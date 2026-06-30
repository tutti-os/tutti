import { AppCenterAppOpenedReporter } from "../../../analytics/reporters/app-center-app-opened/appCenterAppOpenedReporter.ts";
import type { AppCenterAppOpenedParams } from "../../../analytics/reporters/app-center-app-opened/types.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { resolveWorkspaceAppCatalogMetadata } from "@tutti-os/workspace-app-center/core";
import type {
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchNodeSizeConstraints
} from "@tutti-os/workbench-surface";
import type { DesktopLocale } from "@shared/i18n";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import {
  workspaceAppCenterNodeID,
  workspaceAppWebviewTypeID
} from "../workspaceAppCenterLaunchIds.ts";
import { workspaceAppWebviewFrame } from "./workspaceAppWebviewFrame.ts";
import type { WorkspaceAppOpenRouteIntent } from "./workspaceAppCenterWebviewUrl.ts";

export { workspaceAppCenterNodeID, workspaceAppWebviewTypeID };

export async function resolveWorkspaceAppCenterLaunchRequest(input: {
  appCenterService: IWorkspaceAppCenterService;
  reporterService?: Pick<IReporterService, "trackEvents">;
  request: WorkbenchHostLaunchRequest;
}): Promise<WorkbenchHostLaunchResult | null> {
  if (input.request.typeId === workspaceAppCenterNodeID) {
    return {
      dockEntryId: workspaceAppCenterNodeID,
      framePolicy: "cascade",
      instanceId: workspaceAppCenterNodeID,
      typeId: workspaceAppCenterNodeID
    };
  }
  if (input.request.typeId !== workspaceAppWebviewTypeID) {
    return null;
  }

  const payload = readWorkspaceAppLaunchPayload(input.request);
  const appId =
    payload?.appId ??
    readWorkspaceAppIdFromDockEntryId(input.request.dockEntryId);
  const appBeforeLaunch = appId
    ? findWorkspaceApp(input.appCenterService, appId)
    : null;
  if (
    !payload?.prepared &&
    appId &&
    appBeforeLaunch?.runtimeStatus === "installed_pending_restart"
  ) {
    await input.appCenterService.restartAndOpenApp({
      appId,
      ...(payload?.intent ? { intent: payload.intent } : {}),
      workspaceId: input.request.workspaceId
    });
    return null;
  }
  const app = payload?.prepared
    ? appBeforeLaunch
    : appId
      ? await input.appCenterService.prepareAppLaunch({
          appId,
          workspaceId: input.request.workspaceId
        })
      : null;
  if (!app?.launchUrl || app.runtimeStatus !== "running") {
    return null;
  }
  reportWorkspaceAppOpened({
    app,
    prevStatus: payload?.prevStatus ?? appBeforeLaunch?.runtimeStatus,
    reporterService: input.reporterService
  });
  const appTitle = resolveWorkspaceAppDisplayName(app);
  const url = resolveWorkspaceAppOpenUrl(app.launchUrl, payload?.intent);

  return {
    activation: {
      payload: {
        appId: app.appId,
        ...(payload?.intent ? { intent: payload.intent } : {}),
        title: appTitle,
        url
      },
      type: payload?.intent ? "workspace-app:open" : "open-url"
    },
    defaultFrame: workspaceAppWebviewFrame,
    dockEntryId: workspaceAppDockEntryId(app.appId),
    framePolicy: "cascade",
    instanceId: workspaceAppWebviewInstanceId(app.appId),
    sizeConstraints: resolveWorkspaceAppSizeConstraints(app),
    title: appTitle,
    typeId: workspaceAppWebviewTypeID
  };
}

export function resolveWorkspaceAppDisplayName(
  app: WorkspaceAppCenterApp,
  locale: DesktopLocale = getActiveLocale()
): string {
  return resolveWorkspaceAppCatalogMetadata({
    catalog: {
      localizations: app.localizations ?? []
    },
    locale,
    manifest: {
      description: app.description ?? "",
      name: app.name,
      tags: app.tags ?? []
    }
  }).name;
}

export function findWorkspaceApp(
  appCenterService: IWorkspaceAppCenterService,
  appId: string
): WorkspaceAppCenterApp | null {
  return (
    appCenterService.store.apps.find(
      (candidate) => candidate.appId === appId
    ) ?? null
  );
}

export function workspaceAppDockEntryId(appId: string): string {
  return `workspace-app:${encodeURIComponent(appId)}`;
}

export function workspaceAppWebviewInstanceId(appId: string): string {
  return `app:${encodeURIComponent(appId)}`;
}

export function readWorkspaceAppIdFromDockEntryId(
  value: string | null | undefined
): string | null {
  const prefix = "workspace-app:";
  return value?.startsWith(prefix)
    ? decodeURIComponent(value.slice(prefix.length))
    : null;
}

export function readWorkspaceAppIdFromInstanceId(
  value: string | null | undefined
): string | null {
  const prefix = "app:";
  return value?.startsWith(prefix)
    ? decodeURIComponent(value.slice(prefix.length))
    : null;
}

export function readWorkspaceAppIdFromNodeId(
  value: string | null | undefined
): string | null {
  const webviewPrefix = `${workspaceAppWebviewTypeID}:`;
  return (
    readWorkspaceAppIdFromDockEntryId(value) ??
    (value?.startsWith(webviewPrefix)
      ? readWorkspaceAppIdFromInstanceId(value.slice(webviewPrefix.length))
      : null)
  );
}

export function reportWorkspaceAppOpenedFromDockEntry(input: {
  appCenterService: IWorkspaceAppCenterService;
  entryId: string;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): void {
  const appId = readWorkspaceAppIdFromDockEntryId(input.entryId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  if (!app?.launchUrl || app.runtimeStatus !== "running") {
    return;
  }
  reportWorkspaceAppOpened({
    app,
    reporterService: input.reporterService
  });
}

function readWorkspaceAppLaunchPayload(request: WorkbenchHostLaunchRequest): {
  appId: string;
  intent?: WorkspaceAppOpenRouteIntent;
  prepared: boolean;
  prevStatus?: AppCenterAppOpenedParams["prevStatus"];
} | null {
  const payload =
    request.payload && typeof request.payload === "object"
      ? (request.payload as {
          appId?: unknown;
          intent?: unknown;
          prepared?: unknown;
          prevStatus?: unknown;
        })
      : null;
  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
  if (!appId) {
    return null;
  }
  const prevStatus =
    typeof payload?.prevStatus === "string" &&
    isWorkspaceAppOpenPrevStatus(payload.prevStatus)
      ? payload.prevStatus
      : undefined;
  const intent = readWorkspaceAppOpenRouteIntent(payload?.intent);
  return {
    appId,
    ...(intent ? { intent } : {}),
    prepared: payload?.prepared === true,
    prevStatus
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

function resolveWorkspaceAppOpenUrl(
  launchUrl: string,
  intent: WorkspaceAppOpenRouteIntent | undefined
): string {
  if (!intent) {
    return launchUrl;
  }
  try {
    const url = new URL(launchUrl);
    url.pathname = intent.route;
    url.search = "";
    for (const [key, value] of Object.entries(intent.params ?? {})) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  } catch {
    return launchUrl;
  }
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

function isWorkspaceAppOpenPrevStatus(
  value: string
): value is AppCenterAppOpenedParams["prevStatus"] {
  return (
    value === "failed" ||
    value === "idle" ||
    value === "installed_pending_restart" ||
    value === "installing" ||
    value === "preparing" ||
    value === "running" ||
    value === "starting" ||
    value === "stopping" ||
    value === "unavailable"
  );
}

function resolveWorkspaceAppSizeConstraints(
  app: WorkspaceAppCenterApp
): WorkbenchNodeSizeConstraints | null {
  const minWidth =
    typeof app.windowMinWidth === "number" && app.windowMinWidth > 0
      ? app.windowMinWidth
      : undefined;
  const minHeight =
    typeof app.windowMinHeight === "number" && app.windowMinHeight > 0
      ? app.windowMinHeight
      : undefined;
  if (minWidth === undefined && minHeight === undefined) {
    return null;
  }
  return {
    ...(minWidth !== undefined ? { minWidth } : {}),
    ...(minHeight !== undefined ? { minHeight } : {})
  };
}

function reportWorkspaceAppOpened(input: {
  app: WorkspaceAppCenterApp;
  prevStatus?: AppCenterAppOpenedParams["prevStatus"];
  reporterService?: Pick<IReporterService, "trackEvents">;
}): void {
  if (!input.reporterService) {
    return;
  }
  void new AppCenterAppOpenedReporter(
    {
      appId: input.app.appId,
      appSource: input.app.source,
      prevStatus: input.prevStatus ?? input.app.runtimeStatus
    },
    {
      reporterService: input.reporterService
    }
  ).report();
}
