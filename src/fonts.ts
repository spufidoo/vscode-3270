// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "./log";

/**
 * Installed font families, for the host editor's Font suggestions.
 *
 * A webview cannot ask: it only knows fonts it has loaded itself, and the
 * browser API for listing system fonts needs a permission prompt VS Code does
 * not grant. So the names are gathered out here and sent in, and the webview
 * decides which of them resolve and sit on a fixed pitch — the only ones a
 * 3270 can use. That split is deliberate: measuring is the one thing the
 * webview can do better than we can, and it makes a wrong guess harmless.
 */
export const FALLBACK_FAMILIES = [
  "Lucida Console",
  "Cascadia Mono",
  "Consolas",
  "Courier New",
  "IBM Plex Mono",
  "IBM 3270",
  "3270Medium",
  "DejaVu Sans Mono",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
];

let cached: Promise<string[]> | undefined;

export function listFontFamilies(): Promise<string[]> {
  cached ??= discover()
    .catch((err) => {
      log().warn(`font list failed: ${String(err)}`);
      return [] as string[];
    })
    .then((names) => [...new Set([...names, ...FALLBACK_FAMILIES])]);
  return cached;
}

async function discover(): Promise<string[]> {
  if (process.platform === "win32") {
    return windowsFamilies();
  }
  if (process.platform === "darwin") {
    return macFamilies();
  }
  return linuxFamilies();
}

/** Run a command, treating any failure as "no fonts found". */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? "" : String(stdout || ""))
    );
  });
}

/**
 * GDI+ knows the family names a renderer will match, which is what CSS needs.
 *
 * The font registry does not: it holds face names, and for anything with more
 * than four weights the two diverge completely. `Sauce Code Pro Light Nerd
 * Font Complete Mono` in the registry is the Light face of a family actually
 * called `SauceCodePro Nerd Font Mono`, and only the latter resolves. So the
 * registry is the fallback, for when PowerShell is unavailable.
 */
async function windowsFamilies(): Promise<string[]> {
  // Both, because each misses something. GDI+ inherits the old LOGFONT limit
  // and cuts names at 31 characters, which mangles most Nerd Fonts —
  // "FantasqueSansMono Nerd Font Mon". WPF keeps them whole but names some
  // families differently. The webview measures whatever we send, so offering
  // both spellings costs nothing and one of them will be the one that works.
  const script = [
    "$names = @()",
    "try {",
    "  Add-Type -AssemblyName System.Drawing",
    "  $names += (New-Object System.Drawing.Text.InstalledFontCollection).Families |",
    "    ForEach-Object { $_.Name }",
    "} catch {}",
    "try {",
    "  Add-Type -AssemblyName PresentationCore",
    "  $names += [System.Windows.Media.Fonts]::SystemFontFamilies |",
    "    ForEach-Object { $_.Source }",
    "} catch {}",
    "$names | Sort-Object -Unique",
  ].join("\n");
  const output = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const families = output
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (families.length) {
    log().info(`fonts: ${families.length} families from GDI+`);
    return families;
  }
  log().warn("fonts: no families from PowerShell, reading the font registry");
  return windowsRegistryFaces();
}

/**
 * Entries look like `Consolas (TrueType)    REG_SZ    consola.ttf`, and one
 * entry can name several faces: `Arial Bold & Arial Bold Italic (TrueType)`.
 */
async function windowsRegistryFaces(): Promise<string[]> {
  const key = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
  const output = await Promise.all([
    run("reg", ["query", `HKLM\\${key}`]),
    run("reg", ["query", `HKCU\\${key}`]),
  ]);

  const names: string[] = [];
  for (const line of output.join("\n").split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{2,}REG_SZ\s/.exec(line);
    if (!match) {
      continue;
    }
    for (const face of match[1].split("&")) {
      const name = stripStyle(
        face.replace(/\((TrueType|OpenType|All res|VGA res)\)\s*$/i, "")
      );
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * macOS has no quick family list — `system_profiler SPFontsDataType` takes
 * many seconds — so guess from file names and let the webview throw out the
 * guesses that do not resolve. `AndaleMono.ttf` becomes both `AndaleMono` and
 * `Andale Mono`, one of which will be the real family.
 */
function macFamilies(): string[] {
  const dirs = [
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    path.join(os.homedir(), "Library", "Fonts"),
  ];

  const names: string[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ttf|ttc|otf)$/i.test(entry)) {
        continue;
      }
      const base = entry.replace(/\.(ttf|ttc|otf)$/i, "").replace(/-.*$/, "");
      names.push(base, stripStyle(splitCamel(base)));
    }
  }
  return names;
}

async function linuxFamilies(): Promise<string[]> {
  const output = await run("fc-list", [":", "family"]);
  return output
    .split(/\r?\n/)
    // Each line is a family and its aliases, comma separated.
    .flatMap((line) => line.split(","))
    .map((name) => name.trim())
    .filter(Boolean);
}

// The registry names faces, not families: Consolas, Consolas Bold, Consolas
// Bold Italic. Folding the styles away leaves one suggestion per family.
const STYLE_WORD =
  /\s+(regular|italic|oblique|bold|semibold|demibold|extrabold|ultrabold|light|semilight|extralight|ultralight|thin|medium|black|heavy|book|condensed|narrow|expanded)$/i;

function stripStyle(name: string): string {
  let out = name.trim();
  for (;;) {
    const shorter = out.replace(STYLE_WORD, "").trim();
    if (!shorter || shorter === out) {
      return out;
    }
    out = shorter;
  }
}

function splitCamel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}
