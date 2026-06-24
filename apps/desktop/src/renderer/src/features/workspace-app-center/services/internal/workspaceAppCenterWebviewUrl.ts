import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";

export interface WorkspaceAppWebviewExternalState {
  title: string | null;
  url: string | null;
}

export function resolveWorkspaceAppWebviewUrl(input: {
  activation: WorkbenchHostActivation | null;
  appCanUseExternalState: boolean;
  appLaunchUrl: string | null;
  externalNodeState: WorkspaceAppWebviewExternalState | null;
}): string {
  const activationUrl = normalizeWorkspaceAppUrl(
    readWorkspaceAppOpenPayload(input.activation)?.url
  );
  const appLaunchUrl = normalizeWorkspaceAppUrl(input.appLaunchUrl);
  if (appLaunchUrl) {
    return activationUrl && hasSameUrlOrigin(activationUrl, appLaunchUrl)
      ? activationUrl
      : appLaunchUrl;
  }
  return (
    activationUrl ??
    (input.appCanUseExternalState ? input.externalNodeState?.url : null) ??
    "about:blank"
  );
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
): { appId: string; title?: string; url: string } | null {
  if (
    activation?.type !== "open-url" ||
    !activation.payload ||
    typeof activation.payload !== "object"
  ) {
    return null;
  }
  const payload = activation.payload as {
    appId?: unknown;
    title?: unknown;
    url?: unknown;
  };
  return typeof payload.appId === "string" && typeof payload.url === "string"
    ? {
        appId: payload.appId,
        title: typeof payload.title === "string" ? payload.title : undefined,
        url: payload.url
      }
    : null;
}
