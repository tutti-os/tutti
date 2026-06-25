import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterRuntimeStatus
} from "@tutti-os/workspace-app-center";

export function shouldRenderWorkspaceAppBrowserNode(
  app: WorkspaceAppCenterApp | null,
  defaultUrl: string,
  options: WorkspaceAppWebviewHandoffOptions = {}
): boolean {
  const url = normalizeWorkspaceAppUrl(defaultUrl);
  if (url === null || url === "about:blank") {
    return false;
  }
  return (
    app?.runtimeStatus === "running" ||
    shouldPreserveWorkspaceAppWebviewDuringHandoff(app, options)
  );
}

export function shouldPreserveWorkspaceAppWebviewDuringHandoff(
  app: WorkspaceAppCenterApp | null,
  options: WorkspaceAppWebviewHandoffOptions = {}
): boolean {
  return (
    app?.installed === true &&
    (app.installProgress != null ||
      isWorkspaceAppWebviewHandoffRuntimeStatus(app.runtimeStatus) ||
      shouldCoverWorkspaceAppWebviewRuntimeUrlSync(app, options) ||
      shouldBridgeWorkspaceAppWebviewHandoffGap(app, options))
  );
}

export function shouldSyncWorkspaceAppWebviewDefaultUrl(
  app: WorkspaceAppCenterApp | null,
  options: WorkspaceAppWebviewHandoffOptions = {}
): boolean {
  if (shouldCoverWorkspaceAppWebviewRuntimeUrlSync(app, options)) {
    return true;
  }
  return !shouldPreserveWorkspaceAppWebviewDuringHandoff(app, options);
}

export interface WorkspaceAppWebviewHandoffOptions {
  externalNodeUrl?: string | null;
  hadRecentHandoff?: boolean;
}

function isWorkspaceAppWebviewHandoffRuntimeStatus(
  status: WorkspaceAppCenterRuntimeStatus
): boolean {
  return (
    status === "installing" ||
    status === "preparing" ||
    status === "starting" ||
    status === "installed_pending_restart"
  );
}

function shouldBridgeWorkspaceAppWebviewHandoffGap(
  app: WorkspaceAppCenterApp,
  options: WorkspaceAppWebviewHandoffOptions
): boolean {
  return (
    options.hadRecentHandoff === true &&
    normalizeWorkspaceAppUrl(options.externalNodeUrl) !== null &&
    (app.runtimeStatus === "stopping" || app.runtimeStatus === "idle")
  );
}

function shouldCoverWorkspaceAppWebviewRuntimeUrlSync(
  app: WorkspaceAppCenterApp | null,
  options: WorkspaceAppWebviewHandoffOptions
): boolean {
  if (
    app?.installed !== true ||
    app.runtimeStatus !== "running" ||
    app.installProgress != null ||
    options.hadRecentHandoff !== true
  ) {
    return false;
  }
  const launchUrl = normalizeWorkspaceAppUrl(app.launchUrl);
  const externalUrl = normalizeWorkspaceAppUrl(options.externalNodeUrl);
  return (
    launchUrl !== null &&
    externalUrl !== null &&
    comparableWorkspaceAppUrl(launchUrl) !==
      comparableWorkspaceAppUrl(externalUrl)
  );
}

function normalizeWorkspaceAppUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function comparableWorkspaceAppUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}
