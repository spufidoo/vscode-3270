// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./log";
import { SidecarCommand, SidecarEvent } from "./types";

export class Sidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private starting: Promise<void> | undefined;

  constructor(
    private readonly extensionPath: string,
    private readonly logDir: string,
    private readonly workDir: string
  ) {
    super();
  }

  async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  send(cmd: SidecarCommand): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("3270 sidecar is not running");
    }
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  dispose(): void {
    try {
      this.send({ op: "shutdown" });
    } catch {
      /* ignore */
    }
    this.proc?.kill();
    this.proc = undefined;
  }

  private async start(): Promise<void> {
    const python = await resolvePython();
    const script = path.join(this.extensionPath, "sidecar", "sidecar.py");
    if (!fs.existsSync(script)) {
      throw new Error(`Sidecar not found: ${script}`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };
    const libraryPath =
      vscode.workspace.getConfiguration("tn3270").get<string>("libraryPath", "").trim() ||
      siblingTnzCheckout(this.extensionPath);
    if (libraryPath) {
      env.VSCODE_3270_TNZ_PATH = libraryPath;
    }
    env.VSCODE_3270_LOG_DIR = this.logDir;

    // The editor's own working directory is often read-only, and tnz writes
    // its log relative to the process directory.
    const cwd = ensureDir(this.workDir) ?? os.tmpdir();

    const ready = waitForReady(this, 20000);
    const args =
      python === "py" ? ["-3", "-u", script] : ["-u", script];
    log().info(`starting sidecar: ${python} ${args.join(" ")} (cwd ${cwd})`);
    if (env.VSCODE_3270_TNZ_PATH) {
      log().info(`VSCODE_3270_TNZ_PATH=${env.VSCODE_3270_TNZ_PATH}`);
    }
    const proc = spawn(python, args, {
      cwd,
      env,
      windowsHide: true,
    });
    proc.on("error", (err) => {
      log().error(`sidecar spawn failed: ${err.message}`);
    });
    this.proc = proc;
    this.buffer = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) {
        log().error(`sidecar stderr: ${msg}`);
        this.emit("log", msg);
      }
    });
    proc.on("exit", (code, signal) => {
      log().warn(`sidecar exited (code ${code}, signal ${signal})`);
      this.proc = undefined;
      this.emit("exit", code, signal);
    });

    await ready;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) {
        continue;
      }
      try {
        const ev = JSON.parse(line) as SidecarEvent;
        this.emit("event", ev);
      } catch (err) {
        this.emit("log", `bad sidecar line: ${line} (${err})`);
      }
    }
  }
}

function ensureDir(dir: string): string | undefined {
  if (!dir) {
    return undefined;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    log().warn(`cannot create ${dir}: ${err}`);
    return undefined;
  }
}

function siblingTnzCheckout(extensionPath: string): string {
  const sibling = path.join(path.dirname(extensionPath), "tnz");
  if (fs.existsSync(path.join(sibling, "tnz", "tnz.py"))) {
    return sibling;
  }
  return "";
}

function waitForReady(sidecar: Sidecar, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("3270 sidecar did not start. Check the 3270 log."));
    }, timeoutMs);

    const onEvent = (ev: SidecarEvent) => {
      if (ev.op === "ready") {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `3270 sidecar exited before ready (code ${code}). Needs Python 3.10 or later; see the 3270 log.`
        )
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      sidecar.off("event", onEvent);
      sidecar.off("exit", onExit);
    };

    sidecar.on("event", onEvent);
    sidecar.on("exit", onExit);
  });
}

async function resolvePython(): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration("tn3270")
    .get<string>("pythonPath", "")
    .trim();
  if (configured) {
    return configured;
  }

  const candidates =
    process.platform === "win32"
      ? ["py", "python", "python3"]
      : ["python3", "python"];

  for (const cmd of candidates) {
    if (await canRun(cmd)) {
      log().info(`using python: ${cmd}`);
      return cmd;
    }
    log().debug(`python candidate not usable: ${cmd}`);
  }
  throw new Error(
    "No Python interpreter found. Set tn3270.pythonPath to Python 3.10+."
  );
}

function canRun(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = command === "py" ? ["-3", "-c", "import sys"] : ["-c", "import sys"];
    const p = spawn(command, args, { windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}
