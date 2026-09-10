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
import { SessionPanel, VIEW_SETTINGS } from "./session";
import { HostItem, HostTreeProvider, SessionItem } from "./tree";
import { HostProfile, SessionStatus, SidecarEvent } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  const sidecar = new Sidecar(
    context.extensionPath,
    context.logUri.fsPath,
    context.globalStorageUri.fsPath
  );
  const macrosDir = path.join(context.globalStorageUri.fsPath, "macros");
  const capturesDir = path.join(context.globalStorageUri.fsPath, "captures");
  /** Every open tab, by session id. A host profile may own more than one. */
  const sessions = new Map<string, SessionPanel>();
  const sessionStatus = new Map<string, SessionStatus>();
  let focusedId: string | undefined;

  const sessionsFor = (hostId: string): SessionPanel[] =>
    [...sessions.values()].filter((p) => p.hostId === hostId);

  const statusOf = (sessionId: string): SessionStatus =>
    sessionStatus.get(sessionId) ?? "disconnected";

  const isLive = (sessionId: string): boolean => {
    const status = statusOf(sessionId);
    return status === "connected" || status === "connecting";
  };

  // The tree reads session state from here rather than being told about it,
  // so a host row and its children cannot disagree with the tabs.
  const tree = new HostTreeProvider((hostId) =>
    sessionsFor(hostId).map((panel) => ({
      sessionId: panel.sessionId,
      ordinal: panel.ordinal,
      status: statusOf(panel.sessionId),
    }))
  );

  // Host profiles may arrive from the old prefix, so repaint the list after.
  void migrateFromTnzView(context).then(() => tree.refresh());

  const setStatus = (sessionId: string, status: SessionStatus): void => {
    if (status === "disconnected") {
      sessionStatus.delete(sessionId);
    } else {
      sessionStatus.set(sessionId, status);
    }
    tree.refresh();
  };

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
        // A profile can also change from settings.json or Settings Sync, not
        // just the editor tab, and a live session should not have to be
        // reconnected to pick up a new palette.
        const hosts = getHosts();
        for (const panel of sessions.values()) {
          const host = hosts.find((h) => h.id === panel.hostId);
          if (host) {
            panel.applyProfile(host);
          }
        }
      }
      if (
        e.affectsConfiguration("tn3270.keymap") ||
        // Turning the tilt wheel on or off adds or removes two defaults.
        e.affectsConfiguration("tn3270.wheel.horizontal")
      ) {
        for (const panel of sessions.values()) {
          panel.sendConfig();
        }
        refreshKeymapView(context.extensionUri);
      }
      if (
        e.affectsConfiguration("tn3270.fontFamily") ||
        VIEW_SETTINGS.some((key) => e.affectsConfiguration(key))
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
        setStatus(ev.sessionId, "lost");
      } else if (ev.connected) {
        setStatus(ev.sessionId, "connected");
      } else {
        setStatus(ev.sessionId, "disconnected");
      }
    }
  });
  sidecar.on("log", (msg: string) => {
    log().info(msg);
  });
  sidecar.on("exit", () => {
    const open = [...sessions.values()];
    for (const panel of open) {
      setStatus(panel.sessionId, "lost");
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
      tree.refresh();
      return false;
    }
  };

  /** The lowest number a host's live tabs are not using, so titles stay short. */
  const nextOrdinal = (hostId: string): number => {
    const used = new Set(sessionsFor(hostId).map((p) => p.ordinal));
    let n = 1;
    while (used.has(n)) {
      n += 1;
    }
    return n;
  };

  /**
   * Open a session panel for a host and track it.
   *
   * A host may have several. The sidecar keys its worker threads by session
   * id, so tabs on one profile only need ids of their own to be independent.
   * `restored` is the panel VS Code hands back after a window reload, with the
   * ids it had before; without one a new tab and a new id are created.
   */
  const createSession = (
    host: HostProfile,
    opts: {
      sessionId?: string;
      ordinal?: number;
      restored?: vscode.WebviewPanel;
    } = {}
  ): SessionPanel => {
    const sessionId =
      opts.sessionId && !sessions.has(opts.sessionId)
        ? opts.sessionId
        : `${host.id}#${randomUUID().slice(0, 8)}`;
    const taken = new Set(sessionsFor(host.id).map((p) => p.ordinal));
    const ordinal =
      opts.ordinal && !taken.has(opts.ordinal)
        ? opts.ordinal
        : nextOrdinal(host.id);
    const panel = new SessionPanel(
      sidecar,
      host,
      context.extensionUri,
      macrosDir,
      capturesDir,
      {
        onDispose: () => {
          sessions.delete(sessionId);
          sessionStatus.delete(sessionId);
          if (focusedId === sessionId) {
            focusedId = undefined;
          }
          tree.refresh();
          syncSession();
        },
        onViewState: syncSession,
      },
      { sessionId, ordinal },
      opts.restored
    );
    sessions.set(sessionId, panel);
    focusedId = sessionId;
    tree.refresh();
    return panel;
  };

  /**
   * Connect a fresh tab, whether or not the host already has one.
   *
   * Shared by Connect (when nothing is open) and New Session (always).
   */
  const openSession = async (host: HostProfile): Promise<void> => {
    if (!(await startSidecar(host))) {
      return;
    }
    // A pinned LU can only be in session once, so the host will refuse the
    // second attempt. Cheaper to say so than to let VTAM explain it.
    if (sessionsFor(host.id).length && host.luName) {
      void vscode.window.showWarningMessage(
        `3270 Terminal: ${host.label} asks for LU ${host.luName}, which is already in session. The host will refuse this one unless the LU is free.`
      );
    }
    const panel = createSession(host);
    setStatus(panel.sessionId, "connecting");
    panel.connect();
    // A new panel is active straight away, but onDidChangeViewState only
    // fires on a change, so the context key has to be set here too.
    syncSession();
  };

  /** The tab a session command means: the one clicked, or the one on top. */
  const panelFor = (item?: SessionItem): SessionPanel | undefined => {
    if (item instanceof SessionItem) {
      return sessions.get(item.session.sessionId);
    }
    return focusedId ? sessions.get(focusedId) : undefined;
  };

  /** Drop one tab's host session, leaving the tab open to reconnect. */
  const dropSession = (panel: SessionPanel): void => {
    try {
      sidecar.send({ op: "disconnect", sessionId: panel.sessionId });
    } catch (err) {
      reportError("disconnect", err);
    }
    setStatus(panel.sessionId, "disconnected");
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
    for (const panel of sessionsFor(host.id)) {
      panel.applyProfile(host);
    }
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
        const saved = (state ?? {}) as {
          hostId?: unknown;
          sessionId?: unknown;
          ordinal?: unknown;
        };
        const hostId = String(saved.hostId ?? "");
        const sessionId = String(saved.sessionId ?? "");
        const host = getHosts().find((h) => h.id === hostId);
        if (!host || (sessionId && sessions.has(sessionId))) {
          // The profile is gone, or something already owns this session.
          panel.dispose();
          return;
        }
        // Started before the panel is adopted, so the webview's first request
        // for a screen has something to reach.
        const started = await startSidecar(host);
        const restored = createSession(host, {
          sessionId,
          ordinal: Number(saved.ordinal) || undefined,
          restored: panel,
        });
        syncSession();
        if (!started) {
          return;
        }
        setStatus(restored.sessionId, "connecting");
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
        // Connect reuses the tabs a host already has; New Session is the way
        // to ask for another one. Every idle tab is revived, not just the
        // first, so a host disconnected with two tabs comes back with two.
        const existing = sessionsFor(host.id);
        if (existing.length) {
          existing[0].reveal();
          const idle = existing.filter((p) => !isLive(p.sessionId));
          if (!idle.length) {
            return;
          }
          // The sidecar may have died under an open panel, so reconnecting
          // has to be able to bring the process back.
          if (!(await startSidecar(host))) {
            return;
          }
          for (const panel of idle) {
            setStatus(panel.sessionId, "connecting");
            panel.connect();
          }
          return;
        }
        await openSession(host);
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.newSession",
      async (item?: HostItem | HostProfile) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (host) {
          await openSession(host);
        }
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.hosts.disconnect",
      async (item?: HostItem) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (!host) {
          return;
        }
        // The tree row stands for the profile, which may have several tabs
        // behind it. Dropping them all on one click is too blunt to guess at,
        // so anything past the first asks which. Expanding the row and using
        // a session is the way to skip the question.
        const own = sessionsFor(host.id);
        let targets = own;
        if (own.length > 1) {
          const picked = await vscode.window.showQuickPick(
            [
              ...own.map((panel) => ({
                label: `Session #${panel.ordinal}`,
                description: statusOf(panel.sessionId),
                panel,
              })),
              {
                label: `All ${own.length} sessions`,
                description: "",
                panel: undefined,
              },
            ],
            { title: `Disconnect ${host.label}` }
          );
          if (!picked) {
            return;
          }
          targets = picked.panel ? [picked.panel] : own;
        }
        for (const panel of targets) {
          dropSession(panel);
        }
      }
    ),
    // Clicking a session under a host brings its tab forward.
    vscode.commands.registerCommand(
      "tn3270.session.reveal",
      (item?: SessionItem) => {
        panelFor(item)?.reveal();
      }
    ),
    // Connect and Disconnect on the sidebar row work on the host. These work
    // on one tab, whether picked in the tree or the one in front of you,
    // which is the only way to deal with one of several.
    vscode.commands.registerCommand(
      "tn3270.session.reconnect",
      async (item?: SessionItem) => {
        const panel = panelFor(item);
        if (!panel) {
          void vscode.window.showWarningMessage("3270 Terminal: no active session.");
          return;
        }
        if (isLive(panel.sessionId)) {
          void vscode.window.showInformationMessage(
            `3270 Terminal: ${panel.host.label} is already connected.`
          );
          return;
        }
        if (!(await startSidecar(panel.host))) {
          return;
        }
        setStatus(panel.sessionId, "connecting");
        panel.connect();
        panel.focus();
      }
    ),
    vscode.commands.registerCommand(
      "tn3270.session.disconnect",
      (item?: SessionItem) => {
        const panel = panelFor(item);
        if (!panel) {
          void vscode.window.showWarningMessage("3270 Terminal: no active session.");
          return;
        }
        dropSession(panel);
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
    vscode.commands.registerCommand("tn3270.session.capture", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      let file: string | undefined;
      try {
        file = panel.captureScreen();
      } catch (err) {
        reportError("capture screen", err);
        return;
      }
      if (!file) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `3270 Terminal: screen saved to ${path.basename(file)}.`,
        "Open"
      );
      if (choice === "Open") {
        await vscode.window.showTextDocument(vscode.Uri.file(file));
      }
      panel.focus();
    }),
    vscode.commands.registerCommand("tn3270.session.toggleLog", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("3270 Terminal: no active session.");
        return;
      }
      let result: { logging: boolean; path: string } | undefined;
      try {
        result = panel.toggleLog();
      } catch (err) {
        reportError("session log", err);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        result.logging
          ? `3270 Terminal: logging to ${path.basename(result.path)}.`
          : `3270 Terminal: logging stopped. ${path.basename(result.path)} is complete.`,
        "Open"
      );
      if (choice === "Open") {
        await vscode.window.showTextDocument(vscode.Uri.file(result.path));
      }
      panel.focus();
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
