// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

/** The eight 3270 colour values plus the screen background. */
export interface HostColors {
  background: string;
  black: string;
  blue: string;
  red: string;
  pink: string;
  green: string;
  turquoise: string;
  yellow: string;
  white: string;
}

/** IBM Personal Communications defaults. */
export const DEFAULT_COLORS: HostColors = {
  background: "#000000",
  black: "#000000",
  blue: "#7890f0",
  red: "#f01818",
  pink: "#ff00ff",
  green: "#24d830",
  turquoise: "#58f0f0",
  yellow: "#ffff00",
  white: "#ffffff",
};

export interface HostProfile {
  id: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  secure: boolean;
  verifyCert: boolean;
  luName?: string;
  tn3270e?: boolean;
  codePage: string;
  psSize: string;
  secLevel?: number;
  /** Advertise colour capability so the host may send extended colour orders. */
  extendedColor?: boolean;
  /** Render the extended-highlight blink attribute instead of ignoring it. */
  blink?: boolean;
  colors?: HostColors;
  /** CSS font list for the screen. Empty means the built-in monospace stack. */
  fontFamily?: string;
  /** IND$FILE option syntax. Empty follows tn3270.transfer.syntax. */
  transferSyntax?: TransferSyntax | "";
  /** Extra IND$FILE options offered by default. Empty follows the setting. */
  transferOptions?: string;
  /** Seconds of silence before a transfer is abandoned. 0 follows the setting. */
  transferIdleTimeout?: number;
}

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "lost";

export interface SidecarCommand {
  op: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ScreenEvent {
  op: "screen";
  sessionId: string;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  lock: boolean;
  text: string;
  attr: string;
  fg: string;
  bg: string;
  eh: string;
  extendedColor: boolean;
}

export interface StatusEvent {
  op: "status";
  sessionId: string;
  connected: boolean;
  tls: boolean;
  lu: string;
  seslost: boolean;
  lock: boolean;
  reason?: string;
}

export interface ErrorEvent {
  op: "error";
  sessionId: string;
  message: string;
  lock?: boolean;
}

export interface TransferEvent {
  op: "transfer";
  sessionId: string;
  transferId: string;
  state: "start" | "done";
  ok?: boolean;
  message?: string;
  direction?: TransferDirection;
  localPath?: string;
  parms?: string;
}

export interface ScriptAskEvent {
  op: "scriptAsk";
  sessionId: string;
  askId: string;
  kind: "input" | "password" | "warn";
  prompt: string;
  /** The macro that asked, for the title of the input box. */
  name?: string;
  value?: string;
  maxLength?: number;
}

/** A line of macro trace, destined for the output channel. */
export interface TraceEvent {
  op: "trace";
  sessionId: string;
  text: string;
}

export type SidecarEvent =
  | { op: "ready" }
  | ScreenEvent
  | StatusEvent
  | ErrorEvent
  | TransferEvent
  | ScriptAskEvent
  | TraceEvent;

export type TransferDirection = "download" | "upload";

/** How the host expects IND$FILE options to be introduced. */
export type TransferSyntax = "tso" | "cms";

/** A pending IND$FILE transfer, before it is turned into a command. */
export interface TransferRequest {
  direction: TransferDirection;
  localPath: string;
  hostFile: string;
  /** ASCII CRLF translation. Off means a byte-for-byte binary copy. */
  text: boolean;
  /** Extra IND$FILE options, e.g. `RECFM(V) LRECL(255)`. */
  options: string;
}
