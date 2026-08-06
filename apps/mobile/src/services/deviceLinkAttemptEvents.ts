import { accountCookie } from "./http";

const DEFAULT_REALTIME_URL = "wss://ws.tutti.sh/";
const ATTEMPT_CHANGED_EVENT = "device_link.attempt.changed";
const PROTOCOL_VERSION = 2;
const HEARTBEAT_INTERVAL_MS = 180_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

type SocketEvent = { data?: unknown };

export interface DeviceLinkAttemptSocket {
  close(code?: number, reason?: string): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: SocketEvent) => void) | null;
  onopen: (() => void) | null;
  send(data: string): void;
}

export interface DeviceLinkAttemptSocketOptions {
  headers?: Record<string, string>;
}

export type DeviceLinkAttemptSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: DeviceLinkAttemptSocketOptions
) => DeviceLinkAttemptSocket;

export interface DeviceLinkAttemptEventSource {
  start(
    sessionId: string,
    deviceId: string,
    listener: (attemptId: string) => void
  ): { close(): void };
}

export interface DeviceLinkAttemptEventSourceOptions {
  realtimeURL?: string;
  socketConstructor?: DeviceLinkAttemptSocketConstructor;
}

/**
 * Subscribes to the account/device WebSocket only as a wake lane. Every wake
 * is reconciled through the signed HTTP attempt endpoint, so reconnects,
 * dropped frames, and stale payloads cannot change connection authority.
 */
export class DeviceLinkAttemptEvents implements DeviceLinkAttemptEventSource {
  private readonly realtimeURL: string;
  private readonly socketConstructor: DeviceLinkAttemptSocketConstructor | null;

  constructor(options: DeviceLinkAttemptEventSourceOptions = {}) {
    this.realtimeURL = options.realtimeURL?.trim() || DEFAULT_REALTIME_URL;
    this.socketConstructor =
      options.socketConstructor ?? resolveSocketConstructor();
  }

  start(
    sessionId: string,
    deviceId: string,
    listener: (attemptId: string) => void
  ): { close(): void } {
    if (!this.socketConstructor || !sessionId.trim() || !deviceId.trim()) {
      return { close() {} };
    }
    let closed = false;
    let socket: DeviceLinkAttemptSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    const clearTimers = () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      reconnectTimer = null;
      heartbeatTimer = null;
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        Math.max(INITIAL_RECONNECT_DELAY_MS, reconnectDelay * 1.5)
      );
    };

    const handleMessage = (event: SocketEvent) => {
      const payload = parseAttemptChangedPayload(event.data);
      if (payload) listener(payload);
    };

    const connect = () => {
      if (closed) return;
      try {
        clearTimers();
        const endpoint = appendDeviceID(this.realtimeURL, deviceId);
        socket = new this.socketConstructor!(endpoint, [], {
          headers: { Cookie: accountCookie(sessionId) }
        });
      } catch {
        scheduleReconnect();
        return;
      }
      const current = socket;
      current.onopen = () => {
        if (closed || current !== socket) return;
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        current.send(
          JSON.stringify({
            action: "connection.initialize",
            data: { protocolVersion: PROTOCOL_VERSION }
          })
        );
        current.send(
          JSON.stringify({
            action: "init",
            data: { deviceId: deviceId.trim() }
          })
        );
        heartbeatTimer = setInterval(() => {
          if (current !== socket || closed) return;
          current.send(
            JSON.stringify({ action: "ping", data: { ts: Date.now() } })
          );
        }, HEARTBEAT_INTERVAL_MS);
      };
      current.onmessage = handleMessage;
      current.onerror = () => {
        if (current === socket) current.close();
      };
      current.onclose = () => {
        if (current !== socket) return;
        clearTimers();
        socket = null;
        scheduleReconnect();
      };
    };

    connect();
    return {
      close() {
        if (closed) return;
        closed = true;
        clearTimers();
        const current = socket;
        socket = null;
        current?.close(1000, "device-link connection stopped");
      }
    };
  }
}

function resolveSocketConstructor(): DeviceLinkAttemptSocketConstructor | null {
  const constructor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof constructor === "function"
    ? (constructor as DeviceLinkAttemptSocketConstructor)
    : null;
}

function appendDeviceID(rawURL: string, deviceId: string): string {
  const url = new URL(rawURL);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("mobile remote realtime URL must use ws or wss");
  }
  url.searchParams.set("deviceId", deviceId.trim());
  return url.toString();
}

function parseAttemptChangedPayload(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (envelope.protocol_version !== PROTOCOL_VERSION) return null;
  let type = typeof envelope.type === "string" ? envelope.type : "";
  let payload: unknown = envelope.payload;
  if (typeof envelope.event_type === "string") {
    type = envelope.event_type;
    payload = decodeBusinessPayload(envelope.payload);
  }
  if (type !== ATTEMPT_CHANGED_EVENT || !isRecord(payload)) return null;
  const attemptId = payload.attemptId;
  return typeof attemptId === "string" && attemptId.trim()
    ? attemptId.trim()
    : null;
}

function decodeBusinessPayload(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    const encoded = globalThis.atob(raw);
    // The attempt wake payload is ASCII-only (IDs, state, and version). JSON
    // parsing the decoded bytes avoids adding a native text-decoder shim to
    // the MVP bridge.
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const deviceLinkAttemptEventsForTests = {
  appendDeviceID,
  parseAttemptChangedPayload
};
