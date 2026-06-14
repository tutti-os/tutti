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
import { resolveWorkspaceAppWebviewFrame } from "./workspaceAppWebviewFrame.ts";

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
  const app = payload?.prepared
    ? appBeforeLaunch
    : appId
      ? await input.appCenterService.prepareAppLaunch({
          appId,
          workspaceId: input.request.workspaceId
        })
      : null;
  if (!app?.url || app.runtimeStatus !== "running") {
    return null;
  }
  reportWorkspaceAppOpened({
    app,
    prevStatus: payload?.prevStatus ?? appBeforeLaunch?.runtimeStatus,
    reporterService: input.reporterService
  });
  const appTitle = resolveWorkspaceAppDisplayName(app);
  const sizeConstraints = resolveWorkspaceAppSizeConstraints(app);

  return {
    activation: {
      payload: {
        appId: app.appId,
        title: appTitle,
        url: app.url
      },
      type: "open-url"
    },
    defaultFrame: resolveWorkspaceAppWebviewFrame(sizeConstraints),
    dockEntryId: workspaceAppDockEntryId(app.appId),
    framePolicy: "cascade",
    instanceId: workspaceAppWebviewInstanceId(app.appId),
    sizeConstraints,
    title: appTitle,
    typeId: workspaceAppWebviewTypeID
  };
}

export function resolveWorkspaceAppSizeConstraints(
  app: Pick<WorkspaceAppCenterApp, "windowMinHeight" | "windowMinWidth">
): WorkbenchNodeSizeConstraints | null {
  const minHeight = normalizeWorkspaceAppMinimum(app.windowMinHeight);
  const minWidth = normalizeWorkspaceAppMinimum(app.windowMinWidth);
  if (minHeight === undefined && minWidth === undefined) {
    return null;
  }
  return {
    ...(minHeight === undefined ? {} : { minHeight }),
    ...(minWidth === undefined ? {} : { minWidth })
  };
}

function normalizeWorkspaceAppMinimum(
  value: number | null | undefined
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
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

export function reportWorkspaceAppOpenedFromDockEntry(input: {
  appCenterService: IWorkspaceAppCenterService;
  entryId: string;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): void {
  const appId = readWorkspaceAppIdFromDockEntryId(input.entryId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  if (!app?.url || app.runtimeStatus !== "running") {
    return;
  }
  reportWorkspaceAppOpened({
    app,
    reporterService: input.reporterService
  });
}

function readWorkspaceAppLaunchPayload(request: WorkbenchHostLaunchRequest): {
  appId: string;
  prepared: boolean;
  prevStatus?: AppCenterAppOpenedParams["prevStatus"];
} | null {
  const payload =
    request.payload && typeof request.payload === "object"
      ? (request.payload as {
          appId?: unknown;
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
  return {
    appId,
    prepared: payload?.prepared === true,
    prevStatus
  };
}

function isWorkspaceAppOpenPrevStatus(
  value: string
): value is AppCenterAppOpenedParams["prevStatus"] {
  return (
    value === "failed" ||
    value === "idle" ||
    value === "installing" ||
    value === "preparing" ||
    value === "running" ||
    value === "starting" ||
    value === "stopping"
  );
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
