// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { DEFAULT_COLORS, HostColors, HostProfile } from "./types";

const HOSTS_KEY = "hosts";

export function getHosts(): HostProfile[] {
  const raw = vscode.workspace
    .getConfiguration("tn3270")
    .get<HostProfile[]>(HOSTS_KEY, []);
  return Array.isArray(raw) ? raw.map(normalizeHost) : [];
}

export async function saveHosts(hosts: HostProfile[]): Promise<void> {
  await vscode.workspace
    .getConfiguration("tn3270")
    .update(HOSTS_KEY, hosts, vscode.ConfigurationTarget.Global);
}

export async function upsertHost(host: HostProfile): Promise<void> {
  const hosts = getHosts();
  const idx = hosts.findIndex((h) => h.id === host.id);
  if (idx >= 0) {
    hosts[idx] = host;
  } else {
    hosts.push(host);
  }
  await saveHosts(hosts);
}

export async function deleteHost(id: string): Promise<void> {
  await saveHosts(getHosts().filter((h) => h.id !== id));
}

export function normalizeHost(raw: Partial<HostProfile>): HostProfile {
  // Absent means plain telnet on 23: the common case, and a profile that
  // fails to connect is easier to reason about than one that hangs in a
  // handshake the host never offered.
  const secure = raw.secure === true;
  return {
    id: raw.id || randomUUID(),
    label: raw.label || raw.host || "host",
    group: raw.group || undefined,
    host: raw.host || "",
    port: Number(raw.port) || (secure ? 992 : 23),
    secure,
    verifyCert: raw.verifyCert !== false,
    luName: raw.luName || "",
    tn3270e: raw.tn3270e !== false,
    codePage: String(raw.codePage || "037"),
    psSize: String(raw.psSize || "24x80").replace(/\u00d7/g, "x"),
    secLevel: raw.secLevel,
    extendedColor: raw.extendedColor !== false,
    blink: raw.blink === true,
    colors: normalizeColors(raw.colors),
    fontFamily: String(raw.fontFamily || "").trim(),
    transferSyntax: raw.transferSyntax === "cms" || raw.transferSyntax === "tso"
      ? raw.transferSyntax
      : "",
    transferOptions: String(raw.transferOptions || "").trim(),
    transferIdleTimeout: Math.max(0, Number(raw.transferIdleTimeout) || 0),
  };
}

export function normalizeColors(raw?: Partial<HostColors>): HostColors {
  const out = { ...DEFAULT_COLORS };
  for (const key of Object.keys(DEFAULT_COLORS) as (keyof HostColors)[]) {
    const value = raw?.[key];
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
      out[key] = value.toLowerCase();
    }
  }
  return out;
}

export function newHost(): HostProfile {
  return normalizeHost({ id: randomUUID(), label: "", host: "" });
}
