import { DEFAULTS, SCHEMA_VERSION, migrate, type ThemeConfig } from "./theme";

export type ChatStatus = "connected" | "reconnecting" | "idle";
export type OverlayClientType = "browser" | "obs" | "widget" | "studio";

export interface ConfigWireMessage {
  type: "config";
  schemaVersion: number;
  revision: number;
  config: unknown;
  [key: string]: unknown;
}

export interface ClientHelloWireMessage {
  type: "hello";
  schemaVersion: number;
  client: OverlayClientType;
  [key: string]: unknown;
}

export interface ClientAckWireMessage {
  type: "ack";
  revision: number;
  chatStatus: ChatStatus;
  testId?: string;
  [key: string]: unknown;
}

export interface TestLineWireMessage {
  type: "test-line";
  id: string;
}

export interface ClientCountsWireMessage {
  type: "clients";
  counts: Record<OverlayClientType, number>;
  clients: Array<{ client: OverlayClientType; revision: number; chatStatus: ChatStatus }>;
}

export interface TestProgressWireMessage {
  type: "test-progress";
  id: string;
  shown: number;
  total: number;
}

export interface PingWireMessage {
  type: "ping" | "pong";
  [key: string]: unknown;
}

export type OverlayWireMessage =
  | ConfigWireMessage
  | ClientHelloWireMessage
  | ClientAckWireMessage
  | TestLineWireMessage
  | ClientCountsWireMessage
  | TestProgressWireMessage
  | PingWireMessage;

export type ConfigUpdateDecision =
  | { status: "applied"; config: ThemeConfig; shouldReload: false }
  | { status: "update-required"; config: ThemeConfig; shouldReload: false }
  | { status: "invalid"; config: ThemeConfig; shouldReload: false };

/** Keep the last valid config on an unknown future schema; this function never triggers a reload. */
export function decideConfigUpdate(current: ThemeConfig, incoming: unknown): ConfigUpdateDecision {
  if (!isRecord(incoming)) return { status: "invalid", config: current, shouldReload: false };
  const version = incoming.schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION) {
    return { status: "update-required", config: current, shouldReload: false };
  }
  try {
    return { status: "applied", config: migrate(incoming), shouldReload: false };
  } catch {
    return { status: "invalid", config: current, shouldReload: false };
  }
}

export const INITIAL_THEME = DEFAULTS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
