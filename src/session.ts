// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as vscode from "vscode";
import { resolveKeymap } from "./keymap";
import { log } from "./log";
import { Sidecar } from "./sidecar";
import { fillPrompts, hasPrompt, resolveNamedMacro } from "./macros";
import { buildParms, getIdleTimeout, getSyntax } from "./transfer";
import {
  DEFAULT_COLORS,
  HostProfile,
  ScriptAskEvent,
  SidecarCommand,
  SidecarEvent,
  TransferEvent,
  TransferRequest,
} from "./types";
import { getNonce } from "./webview";

export class SessionPanel {
  static readonly viewType = "tn3270.session";

  readonly sessionId: string;
  private readonly panel: vscode.WebviewPanel;
  private lost = false;
  private transferSeq = 0;
  private attemptedConnect = false;
  private reportedDead = false;
  private readonly pending = new Map<string, (ev: TransferEvent) => void>();

  constructor(
    private readonly sidecar: Sidecar,
    public host: HostProfile,
    extensionUri: vscode.Uri,
    private readonly macrosDir: string,
    private readonly hooks: { onDispose: () => void; onViewState: () => void },
    restored?: vscode.WebviewPanel
  ) {
    this.sessionId = host.id;
    const options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    };
    if (restored) {
      // A panel VS Code brought back across a reload keeps its position but
      // not its options, and its script context is gone either way.
      this.panel = restored;
      this.panel.webview.options = options;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        SessionPanel.viewType,
        host.label,
        vscode.ViewColumn.One,
        { ...options, retainContextWhenHidden: true }
      );
    }
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.panel.webview.html = this.html(this.panel.webview, extensionUri);

    this.panel.onDidDispose(() => {
      try {
        this.sidecar.send({ op: "disconnect", sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
      this.failPending("the session was closed");
      this.hooks.onDispose();
    });

    this.panel.onDidChangeViewState(() => this.hooks.onViewState());

    this.panel.webview.onDidReceiveMessage((msg: { op: string; [k: string]: unknown }) => {
      if (msg.op === "ready") {
        // The webview has (re)loaded with an empty grid, so give it the
        // settings and ask the host side for the screen it is missing.
        this.sendConfig();
        this.send({ op: "refresh", sessionId: this.sessionId });
      } else if (msg.op === "key" || msg.op === "paste") {
        this.send({ ...msg, sessionId: this.sessionId });
      } else if (msg.op === "click") {
        this.send({ ...msg, sessionId: this.sessionId });
        if (msg.ctrl) {
          const name = vscode.workspace
            .getConfiguration("tn3270")
            .get<string>("clickMacro", "")
            .trim();
          if (name) {
            void this.runMacro(name);
          }
        }
      } else if (msg.op === "copy") {
        void vscode.env.clipboard.writeText(String(msg.text ?? ""));
      } else if (msg.op === "pasteRequest") {
        // A webview cannot read the clipboard, so the context menu asks us to.
        void vscode.env.clipboard.readText().then((text) => {
          if (text) {
            this.send({ op: "paste", text, sessionId: this.sessionId });
          }
        });
      } else if (msg.op === "macro") {
        void this.runMacro(String(msg.name ?? ""));
      }
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  get isActive(): boolean {
    return this.panel.active;
  }

  /** Put the keyboard back in the 3270 after a command took focus away. */
  focus(): void {
    this.panel.reveal(undefined, false);
    void this.panel.webview.postMessage({ op: "focus" });
  }

  /** Apply an edited profile. Colours repaint live; the rest needs a reconnect. */
  applyProfile(host: HostProfile): void {
    this.host = host;
    this.sendConfig();
    this.setStatus();
  }

  sendConfig(): void {
    void this.panel.webview.postMessage({
      op: "config",
      colors: this.host.colors ?? DEFAULT_COLORS,
      blink: this.host.blink === true,
      keymap: resolveKeymap(),
      fontFamily: this.fontFamily(),
      selection: getSelectionMode(),
    });
  }

  /** The profile's font, or the global default when it has none. */
  private fontFamily(): string {
    return (this.host.fontFamily || "").trim() || getDefaultFontFamily();
  }

  /**
   * Send to the sidecar, reporting a dead one rather than throwing.
   *
   * Every keystroke comes through here. A raw throw from the webview's
   * message handler goes nowhere the user can see, which looks like a
   * session that has simply stopped accepting typing.
   */
  private send(cmd: SidecarCommand): boolean {
    try {
      this.sidecar.send(cmd);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log().error(`session ${this.host.label}: ${message}`);
      this.showDead();
      // Only worth a toast for a session that was up: a panel that never
      // connected has already reported why it could not start.
      if (!this.reportedDead && this.attemptedConnect) {
        this.reportedDead = true;
        void vscode.window.showWarningMessage(
          `3270 Terminal: the 3270 sidecar stopped. Connect ${this.host.label} again to restart it.`
        );
      }
      return false;
    }
  }

  /** Put the bad news on the status line, where a locked keyboard shows. */
  private showDead(): void {
    void this.panel.webview.postMessage({
      op: "oia",
      message: "SIDECAR STOPPED — reconnect to restart it",
    });
  }

  /** Settle any transfer still waiting, so its progress bar cannot hang. */
  private failPending(message: string): void {
    for (const [transferId, resolve] of this.pending) {
      resolve({
        op: "transfer",
        sessionId: this.sessionId,
        transferId,
        state: "done",
        ok: false,
        message,
      });
    }
    this.pending.clear();
  }

  /** The sidecar process has gone; nothing queued for it will ever answer. */
  handleSidecarExit(): void {
    this.failPending("the 3270 sidecar stopped");
    this.showDead();
    // The exit is announced once for the window, not once per tab.
    this.reportedDead = true;
  }

  /**
   * Run an IND$FILE transfer.
   *
   * The sidecar answers with a single done event, so the promise settles even
   * when the host never replies; its idle timeout is the backstop.
   */
  transfer(req: TransferRequest): Promise<TransferEvent> {
    const transferId = `t${++this.transferSeq}`;
    return new Promise((resolve) => {
      this.pending.set(transferId, resolve);
      const sent = this.send({
        op: "transfer",
        sessionId: this.sessionId,
        transferId,
        direction: req.direction,
        localPath: req.localPath,
        parms: buildParms(req, getSyntax(this.host)),
        idleTimeout: getIdleTimeout(this.host),
      });
      if (!sent) {
        this.failPending("the 3270 sidecar stopped");
      }
    });
  }

  handleEvent(ev: SidecarEvent): void {
    if (ev.op === "ready") {
      return;
    }
    if (ev.sessionId && ev.sessionId !== this.sessionId) {
      return;
    }
    if (ev.op === "scriptAsk") {
      void this.answerScriptAsk(ev);
      return;
    }
    if (ev.op === "trace") {
      for (const line of ev.text.split("\n")) {
        log().info(`[${this.host.label}] ${line}`);
      }
      return;
    }
    void this.panel.webview.postMessage(ev);
    if (ev.op === "transfer") {
      if (ev.state === "done") {
        this.pending.get(ev.transferId)?.(ev);
        this.pending.delete(ev.transferId);
      }
      return;
    }
    if (ev.op === "status") {
      this.lost = Boolean(ev.seslost);
    }
    if (ev.op === "status" || ev.op === "screen") {
      this.setStatus();
    }
    if (ev.op === "error" && !ev.message.includes("Input Inhibit")) {
      log().error(`session ${this.host.label}: ${ev.message}`);
      void vscode.window
        .showWarningMessage(`3270 Terminal: ${firstLine(ev.message)}`, "Show Log")
        .then((choice) => {
          if (choice === "Show Log") {
            log().show(true);
          }
        });
    }
  }

  /** Expand a named tape or script and hand it to the sidecar. */
  async runMacro(name: string): Promise<void> {
    const resolved = resolveNamedMacro(name, this.macrosDir);
    if (!resolved) {
      return;
    }
    if (resolved.kind === "script") {
      if (!fs.existsSync(resolved.path)) {
        void vscode.window.showErrorMessage(
          `3270 Terminal: macro "${name}": no file at ${resolved.path}. Use Open Macros Folder to create it.`
        );
        return;
      }
      const trace = vscode.workspace
        .getConfiguration("tn3270")
        .get<boolean>("macroTrace", false);
      if (trace) {
        log().show(true);
      }
      this.send({
        op: "script",
        sessionId: this.sessionId,
        name,
        path: resolved.path,
        trace,
      });
      this.focus();
      return;
    }
    const asked = hasPrompt(resolved.steps);
    const steps = asked ? await fillPrompts(name, resolved.steps) : resolved.steps;
    if (!steps) {
      return;
    }
    this.send({
      op: "macro",
      sessionId: this.sessionId,
      name,
      steps,
    });
    if (asked) {
      this.focus();
    }
  }

  private async answerScriptAsk(ev: ScriptAskEvent): Promise<void> {
    const reply = (cancelled: boolean, value?: string) => {
      this.send({
        op: "scriptReply",
        sessionId: this.sessionId,
        askId: ev.askId,
        cancelled,
        value: value ?? "",
      });
      this.focus();
    };
    if (ev.kind === "warn") {
      // A toast plus the operator information area, the way a real 3270 tells
      // you something went wrong: no dialog to dismiss before the next step.
      void vscode.window.showWarningMessage(ev.prompt);
      log().warn(`macro warn: ${ev.prompt}`);
      void this.panel.webview.postMessage({ op: "oia", message: ev.prompt });
      reply(false);
      return;
    }
    const value = await vscode.window.showInputBox({
      title: ev.name ? `Macro "${ev.name}"` : "Macro",
      prompt: ev.prompt,
      value: ev.kind === "password" ? undefined : ev.value,
      password: ev.kind === "password",
      ignoreFocusOut: true,
      validateInput:
        ev.maxLength && ev.maxLength > 0
          ? (s) =>
              s.length > ev.maxLength!
                ? `At most ${ev.maxLength} characters`
                : undefined
          : undefined,
    });
    if (value === undefined) {
      reply(true);
      return;
    }
    reply(false, value);
  }

  sendAid(aid: string): void {
    this.send({
      op: "key",
      sessionId: this.sessionId,
      type: "aid",
      value: aid,
    });
  }

  /** Toggle insert/replace mode in the view (local; nothing sent to the host). */
  toggleInsert(): void {
    void this.panel.webview.postMessage({ op: "toggleInsert" });
  }

  connect(): void {
    this.lost = false;
    this.setStatus();
    this.attemptedConnect = true;
    this.reportedDead = false;
    this.send({
      op: "connect",
      sessionId: this.sessionId,
      host: this.host.host,
      port: this.host.port,
      secure: this.host.secure,
      verifyCert: this.host.verifyCert,
      luName: this.host.luName || "",
      tn3270e: this.host.tn3270e !== false,
      codePage: this.host.codePage,
      psSize: this.host.psSize,
      secLevel: this.host.secLevel,
      capableColor: this.host.extendedColor !== false,
    });
  }

  /**
   * Keep the tab title to the profile name. Insert mode, TLS and the rest
   * live in the operator information area, where a 3270 user looks for them.
   */
  private setStatus(): void {
    this.panel.title = this.lost
      ? `${this.host.label} (lost)`
      : this.host.label;
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.css")
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.js")
    );
    const nonce = getNonce();
    const config = JSON.stringify({
      // Stored by the webview, so a panel VS Code restores after a reload can
      // be matched back to its host profile.
      hostId: this.sessionId,
      colors: this.host.colors ?? DEFAULT_COLORS,
      blink: this.host.blink === true,
      keymap: resolveKeymap(),
      fontFamily: this.fontFamily(),
      selection: getSelectionMode(),
    }).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css}" />
  <title>3270</title>
</head>
<body>
  <div id="wrap">
    <div id="screen" tabindex="0" aria-label="3270 screen"></div>
    <div id="status">
      <span id="oia-lock">X</span>
      <span id="oia-ins">REP</span>
      <span id="oia-pos">1,1</span>
      <span id="oia-size">24x80</span>
      <span id="oia-color">BASE COLOR</span>
      <span id="oia-msg">Connecting…</span>
    </div>
  </div>
  <script nonce="${nonce}">window.__VSCODE_3270_CONFIG__ = ${config};</script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** The workspace-wide font, used by any profile that does not set one. */
export function getDefaultFontFamily(): string {
  return vscode.workspace
    .getConfiguration("tn3270")
    .get<string>("fontFamily", "")
    .trim();
}

/** Rectangular ("block") or linear ("stream") selection in the 3270 view. */
export function getSelectionMode(): "block" | "stream" {
  return vscode.workspace
    .getConfiguration("tn3270")
    .get<string>("selection", "block") === "stream"
    ? "stream"
    : "block";
}

function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim()) ?? message;
  return line.length > 320 ? `${line.slice(0, 320)}…` : line;
}
