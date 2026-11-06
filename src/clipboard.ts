// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type RichFormat = "rtf" | "html" | "image";

export interface RichCopy {
  format: RichFormat;
  /** Always written alongside where the platform allows more than one type. */
  text: string;
  rtf?: string;
  html?: string;
  /** PNG bytes, base64. */
  png?: string;
}

/**
 * Write rich clipboard formats with the operating system's own tools.
 *
 * `vscode.env.clipboard` only does text, and a webview's clipboard cannot
 * write RTF at all. This is the clipboard of the machine the extension host
 * runs on, which over Remote SSH or WSL is not the one in front of you.
 */
export async function writeRich(copy: RichCopy): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn3270-clip-"));
  try {
    const files = writeFiles(dir, copy);
    if (process.platform === "win32") {
      await windows(files);
    } else if (process.platform === "darwin") {
      await mac(copy, files);
    } else {
      await linux(copy, files);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface Files {
  text: string;
  rtf?: string;
  html?: string;
  png?: string;
}

function writeFiles(dir: string, copy: RichCopy): Files {
  const files: Files = { text: path.join(dir, "clip.txt") };
  fs.writeFileSync(files.text, copy.text, "utf8");
  if (copy.format === "rtf" && copy.rtf) {
    files.rtf = path.join(dir, "clip.rtf");
    // Non-ASCII is already escaped as \u, so the file is plain ASCII.
    fs.writeFileSync(files.rtf, copy.rtf, "ascii");
  } else if (copy.format === "html" && copy.html) {
    files.html = path.join(dir, "clip.html");
    fs.writeFileSync(
      files.html,
      process.platform === "win32" ? cfHtml(copy.html) : copy.html,
      "utf8"
    );
  } else if (copy.format === "image" && copy.png) {
    files.png = path.join(dir, "clip.png");
    fs.writeFileSync(files.png, Buffer.from(copy.png, "base64"));
  } else {
    throw new Error(`nothing to write as ${copy.format}`);
  }
  return files;
}

/**
 * Windows' HTML clipboard format, which wants byte offsets in a header.
 *
 * The offsets are fixed-width so the header's own length does not change as
 * they are filled in.
 */
function cfHtml(fragment: string): string {
  const header =
    "Version:0.9\r\nStartHTML:{0}\r\nEndHTML:{1}\r\n" +
    "StartFragment:{2}\r\nEndFragment:{3}\r\n";
  const before = "<html><body>\r\n<!--StartFragment-->";
  const after = "<!--EndFragment-->\r\n</body></html>";
  const pad = (n: number) => String(n).padStart(10, "0");
  const headerLength = Buffer.byteLength(header.replace(/\{\d\}/g, pad(0)), "utf8");
  const startHtml = headerLength;
  const startFragment = startHtml + Buffer.byteLength(before, "utf8");
  const endFragment = startFragment + Buffer.byteLength(fragment, "utf8");
  const endHtml = endFragment + Buffer.byteLength(after, "utf8");
  return (
    header
      .replace("{0}", pad(startHtml))
      .replace("{1}", pad(endHtml))
      .replace("{2}", pad(startFragment))
      .replace("{3}", pad(endFragment)) +
    before +
    fragment +
    after
  );
}

function run(
  command: string,
  args: string[],
  options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; serves?: boolean } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    // xclip and wl-copy leave a child behind to serve the selection, and it
    // inherits the pipes, so waiting for them to close would never end.
    const proc = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "ignore", options.serves ? "ignore" : "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${command} timed out`));
    }, 15000);
    proc.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on(options.serves ? "exit" : "close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${code}`));
      }
    });
    proc.stdin?.end(options.input ?? "");
  });
}

// Windows Forms needs a single-threaded apartment for the clipboard, which
// Windows PowerShell gives by default and -STA makes certain. The paths come
// in through the environment so nothing has to be quoted into the script.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$utf8 = New-Object System.Text.UTF8Encoding($false)",
  "$data = New-Object System.Windows.Forms.DataObject",
  "$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [IO.File]::ReadAllText($env:TN3270_CLIP_TEXT, $utf8))",
  "if ($env:TN3270_CLIP_RTF) {",
  "  $data.SetData([System.Windows.Forms.DataFormats]::Rtf, [IO.File]::ReadAllText($env:TN3270_CLIP_RTF))",
  "}",
  "if ($env:TN3270_CLIP_HTML) {",
  "  $data.SetData([System.Windows.Forms.DataFormats]::Html, [IO.File]::ReadAllText($env:TN3270_CLIP_HTML, $utf8))",
  "}",
  "if ($env:TN3270_CLIP_PNG) {",
  "  $bytes = [IO.File]::ReadAllBytes($env:TN3270_CLIP_PNG)",
  "  $image = [System.Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes)))",
  "  $data.SetImage($image)",
  // Office and most browsers prefer this to the bitmap, and it keeps alpha.
  "  $data.SetData('PNG', (New-Object IO.MemoryStream(,$bytes)))",
  "}",
  "[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)",
].join("\n");

function windows(files: Files): Promise<void> {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT],
    {
      env: {
        TN3270_CLIP_TEXT: files.text,
        TN3270_CLIP_RTF: files.rtf ?? "",
        TN3270_CLIP_HTML: files.html ?? "",
        TN3270_CLIP_PNG: files.png ?? "",
      },
    }
  );
}

/**
 * pbcopy files input that starts with an RTF header as RTF. HTML and PNG go
 * through AppleScript, which can name a pasteboard type; either way only the
 * rich type is placed, and macOS converts from it for plain-text targets.
 */
function mac(copy: RichCopy, files: Files): Promise<void> {
  if (copy.format === "rtf") {
    return run("pbcopy", [], { input: copy.rtf ?? "" });
  }
  if (copy.format === "html") {
    const hex = Buffer.from(copy.html ?? "", "utf8").toString("hex");
    return run("osascript", ["-"], { input: `set the clipboard to «data HTML${hex}»` });
  }
  const file = (files.png ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return run("osascript", ["-"], {
    input: `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`,
  });
}

const MIME: Record<RichFormat, string> = {
  rtf: "text/rtf",
  html: "text/html",
  image: "image/png",
};

/** wl-copy on Wayland, xclip on X. Both place one type only. */
async function linux(copy: RichCopy, files: Files): Promise<void> {
  const file = files.rtf ?? files.html ?? files.png ?? files.text;
  const input = fs.readFileSync(file);
  const type = MIME[copy.format];
  if (process.env.WAYLAND_DISPLAY) {
    try {
      await run("wl-copy", ["--type", type], { input, serves: true });
      return;
    } catch {
      /* fall through to xclip, which XWayland may still serve */
    }
  }
  await run("xclip", ["-selection", "clipboard", "-t", type, "-i"], { input, serves: true });
}
