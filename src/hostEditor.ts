// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { listFontFamilies } from "./fonts";
import { normalizeColors } from "./hosts";
import { log } from "./log";
import { getDefaultFontFamily } from "./session";
import { getIdleTimeout, getSyntax } from "./transfer";
import { HostProfile } from "./types";
import { getNonce } from "./webview";

type SaveHandler = (host: HostProfile) => Promise<void>;

/** Form tab for a host profile, replacing the old chain of input boxes. */
export class HostEditorPanel {
  static readonly viewType = "tn3270.hostEditor";
  private static readonly open = new Map<string, HostEditorPanel>();

  private readonly panel: vscode.WebviewPanel;

  static show(
    extensionUri: vscode.Uri,
    host: HostProfile,
    isNew: boolean,
    onSave: SaveHandler
  ): void {
    const existing = HostEditorPanel.open.get(host.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    new HostEditorPanel(extensionUri, host, isNew, onSave);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private host: HostProfile,
    private isNew: boolean,
    private readonly onSave: SaveHandler
  ) {
    this.panel = vscode.window.createWebviewPanel(
      HostEditorPanel.viewType,
      this.title(),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    HostEditorPanel.open.set(host.id, this);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.panel.webview.html = this.html(this.panel.webview, extensionUri);

    this.panel.onDidDispose(() => {
      HostEditorPanel.open.delete(this.host.id);
    });

    this.panel.webview.onDidReceiveMessage(
      async (msg: { op: string; [k: string]: unknown }) => {
        if (msg.op === "ready") {
          this.load(this.host);
        } else if (msg.op === "fontReport") {
          this.logFontReport(msg);
        } else if (msg.op === "close") {
          this.panel.dispose();
        } else if (msg.op === "save") {
          await this.save(msg.host as Partial<HostProfile>);
        }
      }
    );
  }

  private async save(raw: Partial<HostProfile>): Promise<void> {
    const problem = validate(raw);
    if (problem) {
      void this.panel.webview.postMessage({ op: "invalid", message: problem });
      return;
    }
    const host: HostProfile = {
      id: this.host.id,
      label: String(raw.label || "").trim() || String(raw.host || "").trim(),
      group: String(raw.group || "").trim() || undefined,
      host: String(raw.host || "").trim(),
      port: Number(raw.port),
      secure: raw.secure === true,
      verifyCert: raw.verifyCert !== false,
      luName: String(raw.luName || "").trim(),
      tn3270e: raw.tn3270e !== false,
      codePage: String(raw.codePage || "037").trim() || "037",
      psSize: String(raw.psSize || "24x80").replace(/\u00d7/g, "x"),
      secLevel:
        raw.secLevel === undefined || raw.secLevel === null
          ? undefined
          : Number(raw.secLevel),
      extendedColor: raw.extendedColor !== false,
      blink: raw.blink === true,
      colors: normalizeColors(raw.colors),
      fontFamily: String(raw.fontFamily || "").trim(),
      transferSyntax:
        raw.transferSyntax === "tso" || raw.transferSyntax === "cms"
          ? raw.transferSyntax
          : "",
      transferOptions: String(raw.transferOptions || "").trim(),
      transferIdleTimeout: Math.max(0, Number(raw.transferIdleTimeout) || 0),
    };
    await this.onSave(host);
    this.host = host;
    this.isNew = false;
    this.panel.title = this.title();
    void this.panel.webview.postMessage({ op: "saved", host });
  }

  private load(host: HostProfile): void {
    this.host = host;
    void this.panel.webview.postMessage({
      op: "load",
      host,
      isNew: this.isNew,
      defaultFontFamily: getDefaultFontFamily(),
      // Shown as placeholders, so an empty box says what it will fall back to.
      defaultTransfer: {
        syntax: getSyntax(),
        options: vscode.workspace
          .getConfiguration("tn3270")
          .get<string>("transfer.options", ""),
        idleTimeout: getIdleTimeout(),
      },
    });
    void this.sendFonts();
  }

  /** What the webview made of the font list, for when a font is missing. */
  private logFontReport(msg: { [k: string]: unknown }): void {
    const unknown = (msg.unknown as string[]) ?? [];
    const proportional = (msg.proportional as string[]) ?? [];
    log().info(
      `fonts: ${msg.kept} of ${msg.candidates} usable, ` +
        `${unknown.length} not resolvable, ${proportional.length} proportional`
    );
    log().debug(`fonts not resolvable: ${unknown.join(", ")}`);
    log().debug(`fonts proportional: ${proportional.join(", ")}`);
  }

  /** Font suggestions follow separately: enumerating them takes a moment. */
  private async sendFonts(): Promise<void> {
    const names = await listFontFamilies();
    try {
      await this.panel.webview.postMessage({ op: "fonts", names });
    } catch {
      /* the tab was closed while we were looking */
    }
  }

  private title(): string {
    return this.isNew ? "New 3270 Host" : `${this.host.label} — Settings`;
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "host.css")
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "host.js")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css}" />
  <title>Host</title>
</head>
<body>
  <h1 id="heading">Host</h1>

  <section>
    <h2>Connection</h2>
    <div class="grid">
      <label for="f-label">Name</label>
      <input id="f-label" type="text" placeholder="Display name in the sidebar" />

      <label for="f-group">Group</label>
      <input id="f-group" type="text" placeholder="Optional sidebar folder" />

      <label for="f-host">Hostname</label>
      <input id="f-host" type="text" placeholder="DNS name or IP" />

      <label for="f-port">Port</label>
      <input id="f-port" type="number" min="1" max="65535" />

      <label for="f-psSize">Screen size</label>
      <input id="f-psSize" type="text" list="pssizes" placeholder="rows x cols, e.g. 30x133" />
      <datalist id="pssizes">
        <option value="24x80">Model 2</option>
        <option value="32x80">Model 3</option>
        <option value="43x80">Model 4</option>
        <option value="27x132">Model 5</option>
        <option value="24x132"></option>
        <option value="62x160"></option>
      </datalist>

      <span class="label-spacer"></span>
      <p class="hint">Must match the emulator that started the session. The
      columns have to match exactly; the rows may be higher. Any size is
      allowed, not just the listed models.</p>

      <label for="f-codePage">Code page</label>
      <input id="f-codePage" type="text" list="codepages" />
      <datalist id="codepages">
        <option value="037">037 US / Canada</option>
        <option value="273">273 Germany / Austria</option>
        <option value="277">277 Denmark / Norway</option>
        <option value="278">278 Finland / Sweden</option>
        <option value="280">280 Italy</option>
        <option value="284">284 Spain / Latin America</option>
        <option value="285">285 UK</option>
        <option value="297">297 France</option>
        <option value="500">500 International</option>
        <option value="871">871 Iceland</option>
        <option value="1047">1047 Open Systems Latin-1</option>
        <option value="1140">1140 US with euro</option>
      </datalist>
    </div>
  </section>

  <section>
    <h2>Security</h2>
    <div class="grid">
      <label for="f-secure">Transport</label>
      <select id="f-secure">
        <option value="tls">TLS</option>
        <option value="plain">Plain telnet</option>
      </select>

      <label for="f-secLevel">TLS level</label>
      <select id="f-secLevel">
        <option value="">Default</option>
        <option value="0">0 — most permissive</option>
        <option value="1">1 — older mainframe stacks</option>
        <option value="2">2 — default OpenSSL</option>
      </select>

      <span class="label-spacer"></span>
      <label class="check"><input id="f-verifyCert" type="checkbox" /> Verify server certificate</label>
    </div>
  </section>

  <section>
    <h2>TN3270E</h2>
    <div class="grid">
      <label for="f-luName">LU name</label>
      <input id="f-luName" type="text" placeholder="Optional, if the host requires one" />

      <span class="label-spacer"></span>
      <label class="check"><input id="f-tn3270e" type="checkbox" /> Negotiate TN3270E</label>
    </div>
  </section>

  <section>
    <h2>File transfer</h2>
    <div class="grid">
      <label for="f-transferSyntax">IND$FILE syntax</label>
      <select id="f-transferSyntax">
        <option value="">Default</option>
        <option value="tso">TSO — bare keywords</option>
        <option value="cms">CMS — options after (</option>
      </select>

      <span class="label-spacer"></span>
      <p class="hint">How this host expects options to be introduced. TSO
      rejects a parenthesis with <code>IKJ56712I INVALID KEYWORD, (</code>.
      Default follows <code>tn3270.transfer.syntax</code>.</p>

      <label for="f-transferOptions">Default options</label>
      <input id="f-transferOptions" type="text" placeholder="RECFM(V) LRECL(255)" />

      <label for="f-transferIdleTimeout">Idle timeout</label>
      <input id="f-transferIdleTimeout" type="number" min="0" max="3600" placeholder="Seconds" />

      <span class="label-spacer"></span>
      <p class="hint">Seconds of silence before a transfer is abandoned. Empty
      or zero follows <code>tn3270.transfer.idleTimeout</code>.</p>
    </div>
  </section>

  <section>
    <h2>Appearance</h2>
    <div class="grid">
      <label for="f-fontFamily">Font</label>
      <!-- Our own suggestion list, not a datalist: a native popup with a few
           hundred families is taller than the screen and will not scroll
           inside a webview. -->
      <div class="combo">
        <input id="f-fontFamily" type="text" autocomplete="off"
               placeholder="Default monospace" />
        <div id="font-list" hidden></div>
      </div>

      <span class="label-spacer"></span>
      <p class="hint">Must be monospaced: columns sit on a fixed pitch, so a
      proportional font will not line up. The size is not set here, it grows to
      fill the panel. Leave empty to follow <code>tn3270.fontFamily</code>.</p>

      <span class="label-spacer"></span>
      <p class="hint" id="font-warning"></p>

      <span class="label-spacer"></span>
      <label class="check"><input id="f-extendedColor" type="checkbox" /> Extended colour</label>

      <span class="label-spacer"></span>
      <p class="hint">Advertises colour capability to the host, which lets it send
      extended colour and highlighting orders. Turn off to force the basic
      four-colour field attributes.</p>

      <span class="label-spacer"></span>
      <label class="check"><input id="f-blink" type="checkbox" /> Render the blink attribute</label>
    </div>

    <div class="palette" id="palette">
      <label class="swatch"><input id="c-background" type="color" /><span>Background</span></label>
      <label class="swatch"><input id="c-black" type="color" /><span>Black</span></label>
      <label class="swatch"><input id="c-blue" type="color" /><span>Blue</span></label>
      <label class="swatch"><input id="c-red" type="color" /><span>Red</span></label>
      <label class="swatch"><input id="c-pink" type="color" /><span>Pink</span></label>
      <label class="swatch"><input id="c-green" type="color" /><span>Green</span></label>
      <label class="swatch"><input id="c-turquoise" type="color" /><span>Turquoise</span></label>
      <label class="swatch"><input id="c-yellow" type="color" /><span>Yellow</span></label>
      <label class="swatch"><input id="c-white" type="color" /><span>White</span></label>
    </div>

    <div id="preview" aria-label="Palette preview"></div>
    <button id="reset" type="button" class="secondary">Reset to defaults</button>
  </section>

  <div id="actions">
    <button id="save" type="button">Save</button>
    <button id="close" type="button" class="secondary">Close</button>
    <span id="status"></span>
  </div>

  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function validate(raw: Partial<HostProfile>): string | undefined {
  if (!String(raw.host || "").trim()) {
    return "Hostname is required.";
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be between 1 and 65535.";
  }
  const codePage = String(raw.codePage || "").trim();
  if (codePage && !/^\d{3,5}$/.test(codePage)) {
    return "Code page must be numeric, for example 037.";
  }
  return validatePsSize(String(raw.psSize || ""));
}

function validatePsSize(value: string): string | undefined {
  const match = /^(\d+)\s*[xX\u00d7]\s*(\d+)$/.exec(value.trim());
  if (!match) {
    return "Screen size must be rows x cols, for example 30x133.";
  }
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  if (rows < 24 || cols < 80) {
    return "Screen size must be at least 24x80.";
  }
  // tnz addresses the buffer with 14 bits.
  if (rows > 204 || cols > 682 || rows * cols > 16383) {
    return "Screen size is too large for a 3270 buffer (max 16383 cells).";
  }
  return undefined;
}
