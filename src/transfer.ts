// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
// Type-only: session.ts imports buildParms from here, and a value import
// would close the cycle at runtime.
import type { SessionPanel } from "./session";
import { log } from "./log";
import { HostProfile, TransferRequest, TransferSyntax } from "./types";

/**
 * How this host introduces IND$FILE options.
 *
 * The profile wins where it is set: TSO or CMS is a fact about the host, not a
 * preference, so a mixed shop cannot be served by one workspace setting.
 */
export function getSyntax(host?: HostProfile): TransferSyntax {
  if (host?.transferSyntax === "tso" || host?.transferSyntax === "cms") {
    return host.transferSyntax;
  }
  return vscode.workspace
    .getConfiguration("tn3270")
    .get<TransferSyntax>("transfer.syntax", "tso");
}

/** Seconds of silence before a transfer is abandoned. */
export function getIdleTimeout(host?: HostProfile): number {
  const profile = Number(host?.transferIdleTimeout) || 0;
  if (profile > 0) {
    return profile;
  }
  return vscode.workspace
    .getConfiguration("tn3270")
    .get<number>("transfer.idleTimeout", 60);
}

/**
 * Build the argument string for IND$FILE.
 *
 * The two hosts introduce options differently. CMS uses its usual `(`, while
 * TSO takes them as bare keywords and rejects a parenthesis with
 * `IKJ56712I INVALID KEYWORD, (`.
 *
 * Text mode asks for ASCII and CRLF together. tnz treats that pair as a
 * request to do the translation itself, which avoids the host's mangling of
 * characters such as `|`. It matches them as whole words, so on CMS the
 * parenthesis needs a space after it or the assist is silently skipped and
 * the host translates instead.
 */
export function buildParms(
  req: TransferRequest,
  syntax: TransferSyntax
): string {
  const options = [
    ...(req.text ? ["ASCII", "CRLF"] : []),
    ...req.options.trim().split(/\s+/).filter(Boolean),
  ];
  const name = req.hostFile.trim();
  if (!options.length) {
    return name;
  }
  const intro = syntax === "cms" ? "( " : "";
  return `${name} ${intro}${options.join(" ")}`;
}

/** Local file name to suggest for a host file. */
function localNameFor(hostFile: string): string {
  const member = /\(([^)]+)\)/.exec(hostFile);
  const base = member ? member[1] : hostFile.replace(/^'|'$/g, "");
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, ".");
}

async function askHostFile(
  direction: "download" | "upload",
  value = ""
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: direction === "download" ? "Download from host" : "Upload to host",
    prompt: "Host file: TSO dataset(member) or CMS fn ft fm",
    placeHolder: "'USERID.SOURCE(MYPROG)'",
    value,
    ignoreFocusOut: true,
    validateInput: (text) =>
      text.trim() ? undefined : "Enter a host file name",
  });
}

async function askText(): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Text",
        description: "ASCII CRLF",
        detail: "Translate EBCDIC to text and host records to lines",
        text: true,
      },
      {
        label: "Binary",
        description: "no translation",
        detail: "Copy bytes unchanged. Record boundaries are not preserved",
        text: false,
      },
    ],
    { title: "Transfer type", ignoreFocusOut: true }
  );
  return pick?.text;
}

async function askOptions(host?: HostProfile): Promise<string | undefined> {
  const extra =
    (host?.transferOptions ?? "").trim() ||
    vscode.workspace.getConfiguration("tn3270").get<string>("transfer.options", "");
  return vscode.window.showInputBox({
    title: "IND$FILE options",
    prompt: "Extra options, or leave empty",
    placeHolder: "RECFM(V) LRECL(255)",
    value: extra,
    ignoreFocusOut: true,
  });
}

export async function download(panel: SessionPanel): Promise<void> {
  const hostFile = await askHostFile("download");
  if (!hostFile) {
    return;
  }
  const text = await askText();
  if (text === undefined) {
    return;
  }
  const options = await askOptions(panel.host);
  if (options === undefined) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Save downloaded file",
    defaultUri: vscode.Uri.file(localNameFor(hostFile)),
    saveLabel: "Download",
  });
  if (!target) {
    return;
  }

  const done = await run(panel, {
    direction: "download",
    localPath: target.fsPath,
    hostFile,
    text,
    options,
  });
  if (done) {
    const choice = await vscode.window.showInformationMessage(
      `Downloaded ${hostFile}`,
      "Open"
    );
    if (choice === "Open") {
      await vscode.window.showTextDocument(target);
    }
  }
}

export async function upload(panel: SessionPanel): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const picked = await vscode.window.showOpenDialog({
    title: "Upload to host",
    defaultUri: active,
    canSelectMany: false,
    openLabel: "Upload",
  });
  const source = picked?.[0];
  if (!source) {
    return;
  }
  const hostFile = await askHostFile("upload");
  if (!hostFile) {
    return;
  }
  const text = await askText();
  if (text === undefined) {
    return;
  }
  const options = await askOptions(panel.host);
  if (options === undefined) {
    return;
  }

  const done = await run(panel, {
    direction: "upload",
    localPath: source.fsPath,
    hostFile,
    text,
    options,
  });
  if (done) {
    void vscode.window.showInformationMessage(`Uploaded to ${hostFile}`);
  }
}

/** Run the transfer behind a progress notification. Returns true on success. */
async function run(
  panel: SessionPanel,
  req: TransferRequest
): Promise<boolean> {
  const verb = req.direction === "download" ? "Downloading" : "Uploading";
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      // IND$FILE has no abort, so offering Cancel would be a lie.
      cancellable: false,
      title: `${verb} ${req.hostFile}`,
    },
    () => panel.transfer(req)
  );

  if (result.ok) {
    log().info(`transfer ok: ${req.hostFile} — ${result.message ?? ""}`);
    return true;
  }

  const message = result.message || "transfer failed";
  log().error(`transfer failed: ${req.hostFile} — ${message}`);
  void vscode.window
    .showErrorMessage(`3270 Terminal: ${message}`, "Show Log")
    .then((choice) => {
      if (choice === "Show Log") {
        log().show(true);
      }
    });
  return false;
}
