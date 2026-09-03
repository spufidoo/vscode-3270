// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { describeKeymap, resolveKeymap } from "./keymap";

let panel: vscode.WebviewPanel | undefined;

/** Read-only list of the bindings currently in effect. */
export function showKeymap(extensionUri: vscode.Uri): void {
  if (panel) {
    panel.reveal();
    panel.webview.html = html(panel.webview, extensionUri);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "tn3270.keymap",
    "3270 Terminal Keyboard Map",
    vscode.ViewColumn.Active,
    {
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      enableCommandUris: true,
    }
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  panel.webview.html = html(panel.webview, extensionUri);
  panel.onDidDispose(() => {
    panel = undefined;
  });
}

export function refreshKeymapView(extensionUri: vscode.Uri): void {
  if (panel) {
    panel.webview.html = html(panel.webview, extensionUri);
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const css = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "host.css")
  );
  const rows = describeKeymap(resolveKeymap())
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.label)}</td><td>${row.chords
          .map((c) => `<code>${escapeHtml(c)}</code>`)
          .join(" ")}</td><td><code>${escapeHtml(row.action)}</code></td></tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${css}" />
  <title>Keyboard Map</title>
</head>
<body>
  <h1>3270 keyboard map</h1>
  <p class="hint">Bindings in effect while a 3270 tab is focused. Override them
  with the <code>tn3270.keymap</code> setting
  (<a href="command:tn3270.openSettings?${encodeURIComponent(JSON.stringify(["tn3270.keymap"]))}">edit keymap</a>,
  or <strong>3270 Terminal: Open Settings</strong> from the command palette).
  Ctrl+C copies when text is selected and sends ATTN when it is not; Ctrl+V
  pastes into fields.</p>
  <table>
    <thead><tr><th>Action</th><th>Keys</th><th>Name</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
