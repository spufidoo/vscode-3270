// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";

/**
 * Keyboard chord to 3270 action.
 *
 * An action is `aid:<name>` to send an AID, `nav:<name>` for a cursor or
 * edit key, or `local:<name>` for something the view handles itself.
 * Chords are lower case, modifiers in the order ctrl, alt, shift, meta.
 */
export type Keymap = Record<string, string>;

/** AID names the sidecar accepts. */
export const AID_NAMES = [
  "enter",
  "clear",
  "attn",
  "pa1",
  "pa2",
  "pa3",
  ...Array.from({ length: 24 }, (_, i) => `pf${i + 1}`),
];

/** Cursor and edit names the sidecar accepts. */
export const NAV_NAMES = [
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "wordleft",
  "wordright",
  "tab",
  "backtab",
  "newline",
  "backspace",
  "delete",
  "eraseeof",
  "eraseinput",
];

function pfKeys(): Keymap {
  const map: Keymap = {};
  for (let n = 1; n <= 12; n++) {
    map[`f${n}`] = `aid:pf${n}`;
    map[`shift+f${n}`] = `aid:pf${n + 12}`;
  }
  return map;
}

/** Extra defaults where the usual PC key is missing (no Insert on Mac keyboards). */
function platformDefaults(): Keymap {
  if (process.platform === "darwin") {
    return { "ctrl+i": "local:insert" };
  }
  return {};
}

// Defaults follow zti, the terminal front end shipped with tnz, so the two
// behave the same way where they overlap.
export const DEFAULT_KEYMAP: Keymap = {
  ...pfKeys(),
  ...platformDefaults(),

  enter: "aid:enter",
  "alt+a": "aid:attn",
  "alt+c": "aid:clear",
  pause: "aid:clear",
  "alt+1": "aid:pa1",
  "alt+2": "aid:pa2",
  "alt+3": "aid:pa3",

  tab: "nav:tab",
  "shift+tab": "nav:backtab",
  left: "nav:left",
  right: "nav:right",
  up: "nav:up",
  down: "nav:down",
  home: "nav:home",
  end: "nav:end",
  "alt+left": "nav:wordleft",
  "alt+right": "nav:wordright",
  backspace: "nav:backspace",
  delete: "nav:delete",
  "shift+end": "nav:eraseeof",
  "ctrl+home": "nav:eraseeof",
  "alt+delete": "nav:eraseinput",
  "ctrl+enter": "nav:newline",

  insert: "local:insert",
  "ctrl+r": "local:reset",
  rightctrl: "local:reset",

  // Mark a block without the mouse. The first one anchors at the cursor; the
  // 3270 cursor itself does not move, so the typing position survives a copy.
  "shift+left": "local:markleft",
  "shift+right": "local:markright",
  "shift+up": "local:markup",
  "shift+down": "local:markdown",
  escape: "local:markclear",
};

export const ACTION_LABELS: Record<string, string> = {
  "aid:enter": "ENTER",
  "aid:attn": "ATTN",
  "aid:clear": "CLEAR",
  "aid:pa1": "PA1",
  "aid:pa2": "PA2",
  "aid:pa3": "PA3",
  "nav:tab": "Tab to next field",
  "nav:backtab": "Tab to previous field",
  "nav:left": "Cursor left",
  "nav:right": "Cursor right",
  "nav:up": "Cursor up",
  "nav:down": "Cursor down",
  "nav:home": "Cursor to first field",
  "nav:end": "Cursor to end of field",
  "nav:wordleft": "Word left",
  "nav:wordright": "Word right",
  "nav:backspace": "Backspace",
  "nav:delete": "Delete",
  "nav:eraseeof": "Erase to end of field",
  "nav:eraseinput": "Erase all input fields",
  "nav:newline": "New line",
  "local:insert": "Toggle insert mode",
  "local:reset": "Reset (unlock keyboard, leave insert)",
  "local:markleft": "Extend block selection left",
  "local:markright": "Extend block selection right",
  "local:markup": "Extend block selection up",
  "local:markdown": "Extend block selection down",
  "local:markclear": "Clear the block selection",
};

/** Defaults with the user's tn3270.keymap merged over the top. */
export function resolveKeymap(): Keymap {
  const overrides = vscode.workspace
    .getConfiguration("tn3270")
    .get<Keymap>("keymap", {});
  const map: Keymap = { ...DEFAULT_KEYMAP };
  for (const [chord, action] of Object.entries(overrides || {})) {
    const key = String(chord).trim().toLowerCase();
    if (!key) {
      continue;
    }
    // An empty action removes a default binding.
    if (!action) {
      delete map[key];
    } else {
      map[key] = String(action);
    }
  }
  return map;
}

/** Bindings grouped by action, for the keyboard map view. */
export function describeKeymap(map: Keymap): { action: string; label: string; chords: string[] }[] {
  const byAction = new Map<string, string[]>();
  for (const [chord, action] of Object.entries(map)) {
    const list = byAction.get(action) ?? [];
    list.push(chord);
    byAction.set(action, list);
  }

  const rows = [...byAction.entries()].map(([action, chords]) => ({
    action,
    label:
      ACTION_LABELS[action] ?? pfLabel(action) ?? macroLabel(action) ?? action,
    chords: chords.sort(),
  }));
  rows.sort((a, b) => order(a.action) - order(b.action) || a.label.localeCompare(b.label));
  return rows;
}

function pfLabel(action: string): string | undefined {
  const match = /^aid:pf(\d+)$/.exec(action);
  return match ? `PF${match[1]}` : undefined;
}

function macroLabel(action: string): string | undefined {
  return action.startsWith("macro:")
    ? `Macro “${action.slice("macro:".length)}”`
    : undefined;
}

function order(action: string): number {
  const pf = /^aid:pf(\d+)$/.exec(action);
  if (pf) {
    return 1000 + Number(pf[1]);
  }
  if (action.startsWith("aid:")) {
    return 0;
  }
  if (action.startsWith("nav:")) {
    return 2000;
  }
  if (action.startsWith("macro:")) {
    return 4000;
  }
  return 3000;
}
