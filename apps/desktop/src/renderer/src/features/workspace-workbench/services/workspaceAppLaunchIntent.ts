import type { DesktopWorkspaceAppExternalHostApi } from "@preload/types";
import type { DesktopWorkspaceAppExternalRendererEvent } from "@shared/contracts/ipc";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";
import {
  findWorkspaceApp,
  workspaceAppWebviewTypeID
} from "../../workspace-app-center/workspaceAppLaunch.ts";
import type { IWorkspaceAppCenterService } from "../../workspace-app-center/services/workspaceAppCenterService.interface.ts";

export function publishWorkspaceAppLaunchIntent(input: {
  api: DesktopWorkspaceAppExternalHostApi | undefined;
  payload: unknown;
  typeId: string;
  workspaceId: string;
}): void {
  if (!input.api || input.typeId !== workspaceAppWebviewTypeID) {
    return;
  }
  const event = readWorkspaceAppLaunchIntentEvent(
    input.payload,
    input.workspaceId
  );
  if (event) {
    input.api.sendEvent(event);
  }
}

export function readWorkspaceAppLaunchIntentEvent(
  payload: unknown,
  workspaceId: string
): DesktopWorkspaceAppExternalRendererEvent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
  const intent = readWorkspaceAppOpenRouteIntent(payload.intent);
  if (!appId || !intent) {
    return null;
  }
  return {
    appId,
    intent,
    type: "workspace.launchIntent",
    workspaceId
  };
}

export function shouldPublishWorkspaceAppLaunchIntentBeforeLaunch(input: {
  appCenterService: IWorkspaceAppCenterService;
  payload: unknown;
  typeId: string;
}): boolean {
  if (input.typeId !== workspaceAppWebviewTypeID) {
    return false;
  }
  const event = readWorkspaceAppLaunchIntentEvent(input.payload, "workspace");
  const app =
    event?.type === "workspace.launchIntent"
      ? findWorkspaceApp(input.appCenterService, event.appId)
      : null;
  return app?.runtimeStatus === "installed_pending_restart";
}

function readWorkspaceAppOpenRouteIntent(
  value: unknown
): TuttiExternalWorkspaceOpenRouteIntent | null {
  if (!isRecord(value) || value.kind !== "open-route") {
    return null;
  }
  const route = typeof value.route === "string" ? value.route.trim() : "";
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://")
  ) {
    return null;
  }
  return {
    kind: "open-route",
    ...(isStringRecord(value.params) ? { params: value.params } : {}),
    route,
    ...(isRecord(value.state) ? { state: value.state } : {})
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
