// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  deleteHost,
  getHosts,
  newHost,
  upsertHost,
} from "./hosts";
import { HostEditorPanel } from "./hostEditor";
import { refreshKeymapView, showKeymap } from "./keymapView";
import { initLog, log, reportError } from "./log";
import { getMacros } from "./macros";
import { migrateFromTnzView } from "./migrate";
import { download, upload } from "./transfer";
import { Sidecar } from "./sidecar";
import { SessionPanel } from "./session";
import { HostItem, HostTreeProvider } from "./tree";
import { HostProfile, SidecarEvent } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  const tree = new HostTreeProvider();
  // Host profiles may arrive from the old prefix, so repaint the list after.
  void migrateFromTnzView(context).then(() => tree.refresh());
  const sidecar = new Sidecar(
    context.extensionPath,
    context.logUri.fsPath,
    context.globalStorageUri.fsPath
  );
  const macrosDir = path.join(context.globalStorageUri.fsPath, "macros");
  const sessions = new Map<string, SessionPanel>();
  let focusedId: string | undefined;

  /**
   * Track which session tab is on top.
   *
   * Derived from every panel rather than from one panel's event, because
   * switching between two sessions fires deactivate and activate in an order
   * that is not guaranteed.
   */
  const syncSession = (): void => {
    const active = [...sessions.values()].find((p) => p.isActive);
    if (active) {
      focusedId = active.sessionId;
    }
    void vscode.commands.executeCommand(
      "setContext",
      "tn3270.sessionActive",
      Boolean(active)
    );
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("tn3270.hosts", tree),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tn3270.hosts")) {
        tree.refresh();
      }
      if (e.affectsConfiguration("tn3270.keymap")) {
        for (const panel of sessions.values()) {
          panel.sendConfig();
        }
        refreshKeymapView(context.extensionUri);
      }
      if (
        e.affectsConfiguration("tn3270.fontFamily") ||
        e.affectsConfiguration("tn3270.selection")
      ) {
        for (const panel of sessions.values()) {
          panel.sendConfig();
        }
      }
    }),
    { dispose: () => sidecar.dispose() }
  );

  sidecar.on("event", (ev: SidecarEvent) => {
    if (ev.op === "ready") {
      return;
    }
    const panel = ev.sessionId ? sessions.get(ev.sessionId) : undefined;
    panel?.handleEvent(ev);
    if (ev.op === "status" && ev.sessionId) {
      if (ev.seslost) {
        tree.setStatus(ev.sessionId, "lost");
      } else if (ev.connected) {
        tree.setStatus(ev.sessionId, "connected");
      } else {
        tree.setStatus(ev.sessionId, "disconnected");
      }
    }
  });
  sidecar.on("log", (msg: string) => {
    log().info(msg);
  });
  sidecar.on("exit", () => {
    const open = [...sessions.entries()];
    for (const [id, panel] of open) {
      tree.setStatus(id, "lost");
      panel.handleSidecarExit();
    }
    if (open.length) {
      void vscode.window.showWarningMessage(
        open.length === 1
          ? "3270 Terminal: the 3270 sidecar stopped. Connect again to restart it."
          : `3270 Terminal: the 3270 sidecar stopped, ending ${open.length} sessions. Connect again to restart it.`
      );
    }
  });

  /** Start the sidecar for a host, reporting a failure against that host. */
  const startSidecar = async (host: HostProfile): Promise<boolean> => {
    try {
      await sidecar.ensureStarted();
      return true;
    } catch (err) {
      reportError("start sidecar", err);
      tree.setStatus(host.id, "disconnected");
      return false;
    }
  };

  /**
   * Open a session panel for a host and track it.
   *
   * `restored` is the panel VS Code hands back after a window reload; without
   * one a new tab is created.
   */
  const createSession = (
    host: HostProfile,
    restored?: vscode.WebviewPanel
  ): SessionPanel => {
    const panel = new SessionPanel(
      sidecar,
      host,
      context.extensionUri,
      macrosDir,
      {
        onDispose: () => {
          sessions.delete(host.id);
          if (focusedId === host.id) {
            focusedId = undefined;
          }
          tree.setStatus(host.id, "disconnected");
          syncSession();
        },
        onViewState: syncSession,
      },
      restored
    );
    sessions.set(host.id, panel);
    focusedId = host.id;
    return panel;
  };

  const hostFromArg = (item?: HostItem | HostProfile): HostProfile | undefined => {
    if (!item) {
      return undefined;
    }
    if (item instanceof HostItem) {
      return item.profile;
    }
    if ("id" in item && "host" in item) {
      return item;
    }
    return undefined;
  };

  // Saving from the editor tab also repaints any live session for that host,
  // so palette edits show up without reconnecting.
  const saveHost = async (host: HostProfile): Promise<void> => {
    await upsertHost(host);
    tree.refresh();
    sessions.get(host.id)?.applyProfile(host);
  };

  const openEditor = (host: HostProfile, isNew: boolean): void => {
    HostEditorPanel.show(context.extensionUri, host, isNew, saveHost);
  };

  // Without this a 3270 tab left open across a window reload comes back as a
  // blank panel that is attached to nothing and can never be revived.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SessionPanel.viewType, {
      async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: unknown
      ): Promise<void> {
        const hostId =
          state && typeof state === "object"
            ? String((state as { hostId?: unknown }).hostId ?? "")
            : "";
        const host = getHosts().find((h) => h.id === hostId);
        if (!host || sessions.has(hostId)) {
          // The profile is gone, or something already owns this session.
          panel.dispose();
          return;
        }
        // Started before the panel is adopted, so the webview's first request
        // for a screen has something to reach.
        const started = await startSidecar(host);
        const restored = createSession(host, panel);
        syncSession();
        if (!started) {
          return;
        }
        tree.setStatus(host.id, "connecting");
        restored.connect();
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tn3270.hosts.add", () => {
      openEditor(newHost(), true);
    }),
    vscode.commands.registerCommand(
      "tn3270.hosts.edit",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        openEditor(current, false);
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.delete",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `Delete host ${current.label}?`,
          { modal: true },
          "Delete"
        );
        if (ok !== "Delete") {
          return;
        }
        await deleteHost(current.id);
        tree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.duplicate",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        openEditor(
          {
            ...current,
            id: randomUUID(),
            label: `${current.label} copy`,
          },
          true
        );
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.connect",
      async (item?: HostItem | HostProfile) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (!host) {
          return;
        }
        const existing = sessions.get(host.id);
        if (existing) {
          existing.reveal();
          const status = tree.getStatus(host.id);
          if (status === "connected" || status === "connecting") {
            return;
          }
          // The sidecar may have died under an open panel, so reconnecting
          // has to be able to bring the process back.
          if (!(await startSidecar(host))) {
            return;
          }
          tree.setStatus(host.id, "connecting");
          existing.connect();
          return;
        }
        if (!(await startSidecar(host))) {
          return;
        }
        tree.setStatus(host.id, "connecting");
        const panel = createSession(host);
        panel.connect();
        // A new panel is active straight away, but onDidChangeViewState only
        // fires on a change, so the context key has to be set here too.
        syncSession();
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.disconnect",
      async (item?: HostItem) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (!host) {
          return;
        }
        try {
          sidecar.send({ op: "disconnect", sessionId: host.id });
        } catch (err) {
          reportError("disconnect", err);
        }
        tree.setStatus(host.id, "disconnected");
      }
    ),
    vscode.commands.registerCommand("tn3270.session.clear", () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      panel?.sendAid("clear");
    }),
    vscode.commands.registerCommand("tn3270.session.attn", () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      panel?.sendAid("attn");
    }),
    // A webview sees a key press itself and VS Code resolves its own
    // keybindings from the same press, so F5 reached both TSO and the
    // debugger. Claiming the chord for a command that does nothing leaves the
    // webview's copy of the key as the only thing that acts on it.
    vscode.commands.registerCommand("tn3270.session.keyGuard", () => {}),
    vscode.commands.registerCommand("tn3270.showKeymap", () => {
      showKeymap(context.extensionUri);
    }),
    vscode.commands.registerCommand(
      "tn3270.openSettings",
      async (query?: string) => {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          query || "tn3270"
        );
      }
    ),
    vscode.commands.registerCommand("tn3270.session.toggleInsert", () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      panel.toggleInsert();
      panel.focus();
    }),
    vscode.commands.registerCommand("tn3270.openMacrosFolder", async () => {
      fs.mkdirSync(macrosDir, { recursive: true });
      const example = path.join(macrosDir, "startlpar.py");
      const bundled = path.join(
        context.extensionPath,
        "examples",
        "startlpar.py"
      );
      if (!fs.existsSync(example) && fs.existsSync(bundled)) {
        fs.copyFileSync(bundled, example);
      }
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(macrosDir)
      );
    }),
    vscode.commands.registerCommand("tn3270.session.runMacro", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      const names = Object.keys(getMacros());
      if (!names.length) {
        const choice = await vscode.window.showInformationMessage(
          "3270 Terminal: no macros defined.",
          "Edit Settings"
        );
        if (choice === "Edit Settings") {
          await vscode.commands.executeCommand(
            "tn3270.openSettings",
            "tn3270.macros"
          );
        }
        return;
      }
      const name = await vscode.window.showQuickPick(names.sort(), {
        title: "Run macro",
      });
      if (name) {
        await panel.runMacro(name);
        panel.focus();
      }
    }),
    vscode.commands.registerCommand("tn3270.session.download", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      await download(panel);
    }),
    vscode.commands.registerCommand("tn3270.session.upload", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      await upload(panel);
    })
  );
}

export function deactivate(): void {
  /* sidecar disposed via subscriptions */
}

async function pickHost(): Promise<HostProfile | undefined> {
  const hosts = getHosts();
  if (!hosts.length) {
    void vscode.window.showInformationMessage("Add a host first.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    hosts.map((h) => ({
      label: h.label,
      description: `${h.host}:${h.port}`,
      host: h,
    })),
    { placeHolder: "Select a host" }
  );
  return picked?.host;
}
