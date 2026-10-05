// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./log";

/**
 * Carry a user across the rename from the tnzView extension.
 *
 * The extension id changed with it, so VS Code hands us a different
 * globalStorage folder and none of the old settings. Both are copied once,
 * on the first activation that finds them.
 */

const OLD_SECTION = "tnzView";
const NEW_SECTION = "tn3270";
const OLD_EXTENSION_IDS = ["mdavage.vscode-3270", "mdavage.tnz-view"];
const DONE = "migrated.tnzView";

/** Old key to new key. Only tnzPath was renamed as well as re-prefixed. */
const KEYS: readonly (readonly [string, string])[] = [
  ["hosts", "hosts"],
  ["pythonPath", "pythonPath"],
  ["keymap", "keymap"],
  ["macros", "macros"],
  ["clickMacro", "clickMacro"],
  ["fontFamily", "fontFamily"],
  ["macroTrace", "macroTrace"],
  ["selection", "selection"],
  ["transfer.syntax", "transfer.syntax"],
  ["transfer.idleTimeout", "transfer.idleTimeout"],
  ["transfer.options", "transfer.options"],
  ["tnzPath", "libraryPath"],
];

export async function migrateFromTnzView(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(DONE)) {
    return;
  }

  const settings = await copySettings();
  const macros = copyMacros(context.globalStorageUri.fsPath);
  await context.globalState.update(DONE, true);

  if (settings.length === 0 && !macros) {
    return;
  }
  log().info(
    `migrated from ${OLD_SECTION}: ${settings.length} settings` +
      `${macros ? ", macros folder" : ""}`
  );

  const parts = [];
  if (settings.length > 0) {
    parts.push(`${settings.length} settings are now ${NEW_SECTION}.*`);
  }
  if (macros) {
    parts.push("your macros folder came with them");
  }
  const choice = await vscode.window.showInformationMessage(
    `3270 Terminal was renamed: ${parts.join(", ")}.`,
    "Remove Old Settings",
    "Leave Them"
  );
  if (choice === "Remove Old Settings") {
    await removeOldSettings();
  }
}

/**
 * Copy any value the user set under the old prefix, per scope, without
 * overwriting anything already set under the new one.
 */
async function copySettings(): Promise<string[]> {
  const from = vscode.workspace.getConfiguration(OLD_SECTION);
  const to = vscode.workspace.getConfiguration(NEW_SECTION);
  const copied: string[] = [];
  for (const [oldKey, newKey] of KEYS) {
    const old = from.inspect(oldKey);
    const now = to.inspect(newKey);
    if (!old) {
      continue;
    }
    const scopes: [unknown, unknown, vscode.ConfigurationTarget][] = [
      [old.globalValue, now?.globalValue, vscode.ConfigurationTarget.Global],
      [
        old.workspaceValue,
        now?.workspaceValue,
        vscode.ConfigurationTarget.Workspace,
      ],
    ];
    for (const [value, existing, target] of scopes) {
      if (value === undefined || existing !== undefined) {
        continue;
      }
      try {
        await to.update(newKey, value, target);
        copied.push(newKey);
      } catch (err) {
        log().error(`migrate ${oldKey}: ${String(err)}`);
      }
    }
  }
  return copied;
}

/** Only offered after the copy, and only for the keys we actually know. */
async function removeOldSettings(): Promise<void> {
  const from = vscode.workspace.getConfiguration(OLD_SECTION);
  for (const [oldKey] of KEYS) {
    const old = from.inspect(oldKey);
    if (old?.globalValue !== undefined) {
      await from.update(oldKey, undefined, vscode.ConfigurationTarget.Global);
    }
    if (old?.workspaceValue !== undefined) {
      await from.update(
        oldKey,
        undefined,
        vscode.ConfigurationTarget.Workspace
      );
    }
  }
}

/** Bring script macros over to the new extension id's storage. */
function copyMacros(storageDir: string): boolean {
  const target = path.join(storageDir, "macros");
  if (fs.existsSync(target)) {
    return false;
  }
  const parent = path.dirname(storageDir);
  for (const oldId of OLD_EXTENSION_IDS) {
    const source = path.join(parent, oldId, "macros");
    if (!fs.existsSync(source)) {
      continue;
    }
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.cpSync(source, target, { recursive: true });
      return true;
    } catch (err) {
      log().error(`migrate macros from ${oldId}: ${String(err)}`);
    }
  }
  return false;
}
