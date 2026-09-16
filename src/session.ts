// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { resolveKeymap } from "./keymap";
import { log, reportError } from "./log";
import { Sidecar } from "./sidecar";
import { fillPrompts, hasPrompt, resolveNamedMacro } from "./macros";
import { buildParms, getIdleTimeout, getSyntax } from "./transfer";
import {
  DEFAULT_COLORS,
  HostProfile,
  ScreenEvent,
  ScriptAskEvent,
  SidecarCommand,
  SidecarEvent,
  TransferEvent,
  TransferRequest,
} from "./types";
import { getNonce } from "./webview";

/**
 * How long a screen must stand still before the log takes a copy.
 *
 * The sidecar sends a screen for every keystroke, so logging each one would
 * write a page per character typed.
 */
const LOG_SETTLE_MS = 400;

/**
 * How long the first screen must stand still before a logon macro starts.
 *
 * A logon panel usually arrives in one write, but VTAM front ends and session
 * managers often paint two or three in quick succession.
 */
const CONNECT_SETTLE_MS = 600;

/** And how long to wait for such a screen at all before giving up on it. */
const CONNECT_WAIT_MS = 30000;

export class SessionPanel {
  static readonly viewType = "tn3270.session";

  /** Unique per tab. The sidecar keys its threads and Tnz objects by this. */
  readonly sessionId: string;
  /** Which profile the tab belongs to. Several tabs may share one. */
  readonly hostId: string;
  /** 1 for a host's first live tab, 2 for the next, and so on. */
  readonly ordinal: number;
  private readonly panel: vscode.WebviewPanel;
  private lost = false;
  private transferSeq = 0;
  private attemptedConnect = false;
  private reportedDead = false;
  private readonly pending = new Map<string, (ev: TransferEvent) => void>();
  /** The last screen the host drew, for capture and logging. */
  private lastScreen?: ScreenEvent;
  private logPath?: string;
  private logTimer?: NodeJS.Timeout;
  private loggedText = "";
  /** Macro named by the profile, waiting for a screen worth typing into. */
  private connectMacro = "";
  private connectSettle?: NodeJS.Timeout;
  private connectGiveUp?: NodeJS.Timeout;

  constructor(
    private readonly sidecar: Sidecar,
    public host: HostProfile,
    extensionUri: vscode.Uri,
    private readonly macrosDir: string,
    private readonly capturesDir: string,
    private readonly hooks: { onDispose: () => void; onViewState: () => void },
    /** Unique per tab, and the second and later tabs on a host are numbered. */
    ids: { sessionId: string; ordinal: number },
    restored?: vscode.WebviewPanel
  ) {
    this.sessionId = ids.sessionId;
    this.hostId = host.id;
    this.ordinal = ids.ordinal;
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
    this.setStatus();
    this.panel.webview.html = this.html(this.panel.webview, extensionUri);

    this.panel.onDidDispose(() => {
      try {
        this.sidecar.send({ op: "disconnect", sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
      this.stopLog();
      this.cancelConnectMacro();
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
      } else if (msg.op === "key" || msg.op === "paste" || msg.op === "cut") {
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
      } else if (msg.op === "openLink") {
        // A hotspot on a URL. Only the two web schemes, so a screen cannot
        // talk the editor into opening anything else.
        const url = String(msg.url ?? "");
        if (/^https?:\/\//i.test(url)) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
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
    void this.panel.webview.postMessage({ op: "config", ...this.viewConfig() });
  }

  /** Everything the webview needs to draw: the profile's, then the settings'. */
  private viewConfig(): Record<string, unknown> {
    return {
      colors: this.host.colors ?? DEFAULT_COLORS,
      blink: this.host.blink === true,
      keymap: resolveKeymap(),
      fontFamily: this.fontFamily(),
      ...viewSettings(),
    };
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
      if (this.lost) {
        // Nothing to log on to any more.
        this.cancelConnectMacro();
      } else if (ev.connected && this.connectMacro && !this.connectGiveUp) {
        this.connectGiveUp = setTimeout(() => {
          this.connectGiveUp = undefined;
          const name = this.connectMacro;
          if (!name) {
            return;
          }
          this.cancelConnectMacro();
          log().warn(
            `session ${this.host.label}: logon macro ${name} not started; ` +
              "no usable screen arrived"
          );
          void vscode.window.showWarningMessage(
            `3270 Terminal: logon macro "${name}" did not start — ${this.host.label} drew nothing to type into. Run it from the palette when the host is ready.`
          );
        }, CONNECT_WAIT_MS);
      }
    }
    if (ev.op === "screen") {
      this.noteScreen(ev);
      this.considerConnectMacro(ev);
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

  /**
   * Keep the newest screen, and give the log a copy once it settles.
   *
   * Hidden fields arrive from the sidecar already blanked, so neither a
   * capture nor a log can carry a password out of a password field.
   */
  private noteScreen(ev: ScreenEvent): void {
    this.lastScreen = ev;
    if (!this.logPath) {
      return;
    }
    if (this.logTimer) {
      clearTimeout(this.logTimer);
    }
    this.logTimer = setTimeout(() => {
      this.logTimer = undefined;
      this.writeLog();
    }, LOG_SETTLE_MS);
  }

  /**
   * Decide whether this screen is the one the logon macro was waiting for.
   *
   * The sidecar draws the buffer as soon as the socket is up, well before the
   * host has written anything, and the host holds the keyboard while it does
   * write. Neither is a screen a macro can type into, so wait for one that is
   * unlocked, has something on it, and has then stopped changing.
   */
  private considerConnectMacro(ev: ScreenEvent): void {
    if (!this.connectMacro || ev.lock || !ev.text.trim()) {
      return;
    }
    if (this.connectSettle) {
      clearTimeout(this.connectSettle);
    }
    this.connectSettle = setTimeout(() => {
      this.connectSettle = undefined;
      const name = this.connectMacro;
      if (!name) {
        return;
      }
      this.cancelConnectMacro();
      // The line is logged because a logon macro that runs against the wrong
      // panel is otherwise very hard to tell from one that has a bug in it.
      log().info(
        `session ${this.host.label}: logon macro ${name} starting on ` +
          `"${topLine(ev)}"`
      );
      void this.runMacro(name);
    }, CONNECT_SETTLE_MS);
  }

  /** Stop waiting for a logon macro's screen, and forget the macro. */
  private cancelConnectMacro(): void {
    this.connectMacro = "";
    if (this.connectSettle) {
      clearTimeout(this.connectSettle);
      this.connectSettle = undefined;
    }
    if (this.connectGiveUp) {
      clearTimeout(this.connectGiveUp);
      this.connectGiveUp = undefined;
    }
  }

  /** Write the screen as it stands to a text file, and say where it went. */
  captureScreen(): string | undefined {
    const screen = this.lastScreen;
    if (!screen) {
      void vscode.window.showWarningMessage(
        `3270 Terminal: ${this.host.label} has no screen to capture yet.`
      );
      return undefined;
    }
    const file = path.join(
      this.captureDir(),
      `${this.fileStem()}-${stamp(new Date(), true)}.txt`
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.formatScreen(screen), "utf8");
    log().info(`session ${this.host.label}: captured to ${file}`);
    return file;
  }

  get logging(): boolean {
    return Boolean(this.logPath);
  }

  /** Start or stop logging every settled screen. Returns the file in use. */
  toggleLog(): { logging: boolean; path: string } {
    if (this.logPath) {
      const was = this.logPath;
      this.stopLog();
      return { logging: false, path: was };
    }
    const file = path.join(
      this.captureDir(),
      `${this.fileStem()}-${stamp(new Date(), true)}.log`
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `3270 session log — ${this.host.label} (${this.host.host}:${this.host.port})` +
        `${os.EOL}started ${stamp(new Date())}${os.EOL}${os.EOL}`,
      "utf8"
    );
    this.logPath = file;
    this.loggedText = "";
    log().info(`session ${this.host.label}: logging to ${file}`);
    // Whatever is on screen now is the first entry, not the next thing typed.
    this.writeLog();
    this.setStatus();
    return { logging: true, path: file };
  }

  private stopLog(): void {
    if (this.logTimer) {
      clearTimeout(this.logTimer);
      this.logTimer = undefined;
    }
    const file = this.logPath;
    if (!file) {
      return;
    }
    this.logPath = undefined;
    try {
      fs.appendFileSync(file, `ended ${stamp(new Date())}${os.EOL}`, "utf8");
    } catch (err) {
      reportError("session log", err);
    }
    this.setStatus();
  }

  private writeLog(): void {
    const screen = this.lastScreen;
    if (!screen || !this.logPath || screen.text === this.loggedText) {
      return;
    }
    this.loggedText = screen.text;
    try {
      fs.appendFileSync(this.logPath, this.formatScreen(screen), "utf8");
    } catch (err) {
      // A log that cannot be written must not keep failing every screen.
      reportError("session log", err);
      this.stopLog();
    }
  }

  private formatScreen(ev: ScreenEvent): string {
    const lines = [
      `==== ${this.host.label}  ${stamp(new Date())}  ${ev.rows}x${ev.cols}` +
        `  cursor ${ev.cursorRow},${ev.cursorCol} ====`,
    ];
    for (let r = 0; r < ev.rows; r++) {
      lines.push(
        ev.text.slice(r * ev.cols, (r + 1) * ev.cols).replace(/\s+$/, "")
      );
    }
    return lines.join(os.EOL) + os.EOL + os.EOL;
  }

  /**
   * The profile name for a file name, with the tab number when there is one.
   *
   * Two tabs on the same host can start logging in the same second, and the
   * timestamp alone would have them writing to one file.
   */
  private fileStem(): string {
    const label = fileLabel(this.host.label);
    return this.ordinal > 1 ? `${label}-${this.ordinal}` : label;
  }

  /** Where captures and logs go: the setting, or our own storage folder. */
  private captureDir(): string {
    const configured = vscode.workspace
      .getConfiguration("tn3270")
      .get<string>("capture.directory", "")
      .trim();
    if (!configured) {
      return this.capturesDir;
    }
    const expanded = configured.startsWith("~")
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
    if (path.isAbsolute(expanded)) {
      return expanded;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder
      ? path.join(folder.uri.fsPath, expanded)
      : path.join(this.capturesDir, expanded);
  }

  connect(): void {
    this.lost = false;
    this.setStatus();
    this.attemptedConnect = true;
    this.reportedDead = false;
    this.cancelConnectMacro();
    this.connectMacro = (this.host.connectMacro || "").trim();
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
   * Lost and logging are the exceptions: both outlast a screen update, and
   * the operator information area is repainted by every one of them.
   */
  private setStatus(): void {
    const notes = [
      this.ordinal > 1 ? `#${this.ordinal}` : "",
      this.lost ? "lost" : "",
      this.logPath ? "log" : "",
    ].filter(Boolean);
    this.panel.title = notes.length
      ? `${this.host.label} (${notes.join(", ")})`
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
      // be matched back to its host profile and its place among that host's
      // tabs.
      hostId: this.hostId,
      sessionId: this.sessionId,
      ordinal: this.ordinal,
      ...this.viewConfig(),
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

/**
 * The settings a session reads rather than a profile: how the view behaves
 * rather than what it is connected to.
 */
export const VIEW_SETTINGS = [
  "tn3270.selection",
  "tn3270.crosshair",
  "tn3270.cursor.style",
  "tn3270.cursor.blink",
  "tn3270.alarm",
  "tn3270.hotspots",
];

function viewSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("tn3270");
  const crosshair = config.get<string>("crosshair", "off");
  const hotspots = config.get<string>("hotspots", "click");
  return {
    selection: getSelectionMode(),
    crosshair: ["row", "column", "cross"].includes(crosshair)
      ? crosshair
      : "off",
    cursorStyle:
      config.get<string>("cursor.style", "block") === "underline"
        ? "underline"
        : "block",
    cursorBlink: config.get<boolean>("cursor.blink", false),
    alarm: config.get<boolean>("alarm", true),
    hotspots: ["click", "doubleclick"].includes(hotspots) ? hotspots : "off",
  };
}

/** A profile name that is safe to put in a file name. */
function fileLabel(label: string): string {
  return label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "session";
}

/** Local time, as `2026-09-09 14:45:00` or `20260909-144500` for a file name. */
function stamp(when: Date, forFile = false): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}${forFile ? "" : "-"}${p(
    when.getMonth() + 1
  )}${forFile ? "" : "-"}${p(when.getDate())}`;
  const time = `${p(when.getHours())}${forFile ? "" : ":"}${p(
    when.getMinutes()
  )}${forFile ? "" : ":"}${p(when.getSeconds())}`;
  return `${date}${forFile ? "-" : " "}${time}`;
}

/** The topmost row with anything on it. The buffer has no line breaks. */
function topLine(ev: ScreenEvent): string {
  for (let r = 0; r < ev.rows; r++) {
    const line = ev.text.slice(r * ev.cols, (r + 1) * ev.cols).trim();
    if (line) {
      return line;
    }
  }
  return "";
}

function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim()) ?? message;
  return line.length > 320 ? `${line.slice(0, 320)}…` : line;
}
