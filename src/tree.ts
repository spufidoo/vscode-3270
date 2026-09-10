// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { getHosts } from "./hosts";
import { HostProfile, SessionStatus } from "./types";

/** What the tree needs to know about one open tab. */
export interface SessionInfo {
  sessionId: string;
  ordinal: number;
  status: SessionStatus;
}

function statusIcon(status: SessionStatus): vscode.ThemeIcon {
  return new vscode.ThemeIcon(
    status === "connected"
      ? "vm-active"
      : status === "connecting"
        ? "sync~spin"
        : status === "lost"
          ? "error"
          : "vm"
  );
}

export class HostItem extends vscode.TreeItem {
  constructor(
    public readonly profile: HostProfile,
    public readonly status: SessionStatus,
    /** The tabs open on this profile, in the order they were opened. */
    public readonly sessions: SessionInfo[] = []
  ) {
    // One session is the ordinary case and reads better as a plain row; a
    // host only becomes a branch when there is something to branch into.
    super(
      profile.label,
      sessions.length > 1
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    const count = sessions.length;
    this.id = profile.id;
    this.contextValue = status === "connected" ? "hostConnected" : "host";
    this.description =
      count > 1
        ? `${profile.host}:${profile.port} · ${count} sessions`
        : `${profile.host}:${profile.port}`;
    this.tooltip = `${profile.label}\n${profile.host}:${profile.port} ${
      profile.secure ? "TLS" : "plain"
    }\n${profile.psSize}  cp${profile.codePage}${
      count > 1 ? `\n${count} sessions open` : ""
    }`;
    this.iconPath = statusIcon(status);
    // A branch row toggles on click, so connecting from it as well would do
    // two things at once. Its children are the way in once it has any.
    if (count <= 1) {
      this.command = {
        command: "tn3270.hosts.connect",
        title: "Connect",
        arguments: [this],
      };
    }
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly profile: HostProfile,
    public readonly session: SessionInfo
  ) {
    super(`Session #${session.ordinal}`, vscode.TreeItemCollapsibleState.None);
    this.id = session.sessionId;
    this.contextValue =
      session.status === "connected" ? "sessionConnected" : "session";
    this.description = session.status;
    this.tooltip = `${profile.label} session #${session.ordinal} — ${session.status}`;
    this.iconPath = statusIcon(session.status);
    this.command = {
      command: "tn3270.session.reveal",
      title: "Show Session",
      arguments: [this],
    };
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(public readonly group: string) {
    super(group, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "group";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class HostTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.TreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /**
   * @param listSessions the open tabs for a host. Session state lives with
   * the panels in the extension, so the tree reads it rather than keeping a
   * second copy that has to be told about every change.
   */
  constructor(private readonly listSessions: (hostId: string) => SessionInfo[]) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  /** The liveliest of a host's tabs, which is what its icon reports. */
  getStatus(hostId: string): SessionStatus {
    const states = this.listSessions(hostId).map((s) => s.status);
    return states.includes("connected")
      ? "connected"
      : states.includes("connecting")
        ? "connecting"
        : states.includes("lost")
          ? "lost"
          : "disconnected";
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const hosts = getHosts();
    if (element instanceof HostItem) {
      return element.sessions.map((s) => new SessionItem(element.profile, s));
    }
    if (element instanceof GroupItem) {
      return hosts
        .filter((h) => (h.group || "") === element.group)
        .map((h) => this.item(h));
    }

    const groups = [
      ...new Set(hosts.map((h) => h.group).filter((g): g is string => !!g)),
    ].sort((a, b) => a.localeCompare(b));
    const ungrouped = hosts.filter((h) => !h.group);
    return [
      ...groups.map((g) => new GroupItem(g)),
      ...ungrouped.map((h) => this.item(h)),
    ];
  }

  private item(host: HostProfile): HostItem {
    return new HostItem(
      host,
      this.getStatus(host.id),
      this.listSessions(host.id)
    );
  }
}
