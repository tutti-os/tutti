import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";

export interface WorkspaceAppWebviewExternalState {
  title: string | null;
  url: string | null;
}

export interface WorkspaceAppOpenRouteIntent {
  kind: "open-route";
  params?: Record<string, string>;
  route: string;
  state?: Record<string, unknown>;
}

export interface WorkspaceAppOpenPayload {
  appId: string;
  intent?: WorkspaceAppOpenRouteIntent;
  title?: string;
  url: string;
}

export function resolveWorkspaceAppWebviewUrl(input: {
  activation: WorkbenchHostActivation | null;
  appCanUseExternalState: boolean;
  appLaunchUrl: string | null;
  externalNodeState: WorkspaceAppWebviewExternalState | null;
  preferExternalState?: boolean;
}): string {
  const activationUrl = normalizeWorkspaceAppUrl(
    readWorkspaceAppOpenPayload(input.activation)?.url
  );
  const appLaunchUrl = normalizeWorkspaceAppUrl(input.appLaunchUrl);
  const externalNodeUrl = input.appCanUseExternalState
    ? normalizeWorkspaceAppUrl(input.externalNodeState?.url)
    : null;
  if (input.preferExternalState === true && externalNodeUrl) {
    return activationUrl && hasSameUrlOrigin(activationUrl, externalNodeUrl)
      ? activationUrl
      : externalNodeUrl;
  }
  if (appLaunchUrl) {
    return activationUrl && hasSameUrlOrigin(activationUrl, appLaunchUrl)
      ? activationUrl
      : appLaunchUrl;
  }
  return activationUrl ?? externalNodeUrl ?? "about:blank";
}

function normalizeWorkspaceAppUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function hasSameUrlOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function readWorkspaceAppOpenPayload(
  activation: WorkbenchHostActivation | null
): WorkspaceAppOpenPayload | null {
  if (
    activation?.type !== "open-url" &&
    activation?.type !== "workspace-app:open"
  ) {
    return null;
  }
  if (!activation.payload || typeof activation.payload !== "object") {
    return null;
  }
  const payload = activation.payload as {
    appId?: unknown;
    title?: unknown;
    url?: unknown;
    intent?: unknown;
  };
  if (typeof payload.appId !== "string" || typeof payload.url !== "string") {
    return null;
  }
  const intent = readWorkspaceAppOpenRouteIntent(payload.intent);
  return {
    appId: payload.appId,
    ...(intent ? { intent } : {}),
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    url: payload.url
  };
}

function readWorkspaceAppOpenRouteIntent(
  value: unknown
): WorkspaceAppOpenRouteIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "open-route" || typeof record.route !== "string") {
    return null;
  }
  const route = record.route.trim();
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://")
  ) {
    return null;
  }
  return {
    kind: "open-route",
    ...(isStringRecord(record.params) ? { params: record.params } : {}),
    route,
    ...(isRecord(record.state) ? { state: record.state } : {})
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
