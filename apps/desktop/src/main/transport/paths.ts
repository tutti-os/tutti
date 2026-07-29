import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveDesktopDefaultsFromEnv } from "../defaults.ts";

export interface DesktopDaemonEndpoint {
  accessToken: string;
  boundAddr: string | null;
  listenerInfoPath: string;
  pidPath: string;
  requestedAddr: string;
}

export interface DesktopTerminalStreamUrlInput {
  afterSeq?: number;
  sessionId: string;
  workspaceId: string;
}

export function resolveDesktopDaemonEndpoint(): DesktopDaemonEndpoint {
  const defaults = resolveDesktopDefaultsFromEnv();
  const requestedAddr = process.env.TUTTID_ADDR?.trim() || "127.0.0.1:0";

  return {
    accessToken: randomBytes(32).toString("base64url"),
    boundAddr: null,
    listenerInfoPath: defaults.state.tuttidListenerInfoPath,
    pidPath: defaults.state.tuttidPIDPath,
    requestedAddr
  };
}

export function resolveDesktopDaemonBaseUrl(
  endpoint: DesktopDaemonEndpoint
): string {
  if (!endpoint.boundAddr) {
    throw new Error("Desktop daemon endpoint is not ready yet.");
  }

  return toBaseUrl(endpoint.boundAddr);
}

export function resolveDesktopTerminalStreamUrl(
  endpoint: DesktopDaemonEndpoint,
  input: DesktopTerminalStreamUrlInput
): string {
  const url = createDesktopWebSocketUrl(
    endpoint,
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/terminals/${encodeURIComponent(input.sessionId)}/ws`
  );
  if (input.afterSeq !== undefined) {
    url.searchParams.set("afterSeq", String(input.afterSeq));
  }
  return url.toString();
}

export function resolveDesktopBusinessEventStreamUrl(
  endpoint: DesktopDaemonEndpoint
): string {
  return createDesktopWebSocketUrl(endpoint, "/v1/events/ws").toString();
}

export function resolveDesktopLogsDir(): string {
  return resolveDesktopDefaultsFromEnv().state.logsDir;
}

export function resolveBrowserNodeAutomationListenerInfoPath(): string {
  return join(
    resolveDesktopDefaultsFromEnv().state.runDir,
    "browser-node-automation.json"
  );
}

function toBaseUrl(addr: string): string {
  if (addr.startsWith("http://") || addr.startsWith("https://")) {
    return addr.replace(/\/+$/, "");
  }

  return `http://${addr}`.replace(/\/+$/, "");
}

function createDesktopWebSocketUrl(
  endpoint: DesktopDaemonEndpoint,
  pathname: string
): URL {
  const url = new URL(pathname, resolveDesktopDaemonBaseUrl(endpoint));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("access_token", endpoint.accessToken);
  return url;
}
