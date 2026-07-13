import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import type { BrowserNodeFeature } from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceAppCenterContribution,
  readWorkspaceAppIdFromNodeId
} from "@renderer/features/workspace-app-center";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { DesktopBrowserApi, DesktopRuntimeApi } from "@preload/types";
import { createWorkspaceAppBrowserFeature } from "./workspaceAppBrowserFeature.ts";
import type { WorkspaceBrowserService } from "../workspaceBrowserService.ts";

interface CachedWorkspaceAppBrowserFeature {
  appCenterService: IWorkspaceAppCenterService;
  browserApi: DesktopBrowserApi;
  feature: BrowserNodeFeature;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

const browserFeaturesByWorkspaceId = new Map<
  string,
  CachedWorkspaceAppBrowserFeature
>();

type AppCenterWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "appCenterService"
  | "appI18n"
  | "browserApi"
  | "browserService"
  | "reporterService"
  | "runtimeApi"
  | "workspaceId"
>;

export const appCenterWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<AppCenterWorkbenchContributionContext> =
  {
    id: "workspace-app-center",
    order: 18,
    create(context) {
      return context.browserApi
        ? createWorkspaceAppCenterContribution({
            appCenterService: context.appCenterService,
            browserFeature: resolveWorkspaceAppBrowserFeature({
              appCenterService: context.appCenterService,
              browserApi: context.browserApi,
              browserService: context.browserService,
              i18n: context.appI18n,
              runtimeApi: context.runtimeApi,
              workspaceId: context.workspaceId
            }),
            i18n: context.appI18n,
            reporterService: context.reporterService,
            workspaceId: context.workspaceId
          })
        : null;
    }
  };

function resolveWorkspaceAppBrowserFeature(input: {
  appCenterService: IWorkspaceAppCenterService;
  browserApi: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  i18n?: I18nRuntime<string>;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  workspaceId: string;
}): BrowserNodeFeature {
  const cached = browserFeaturesByWorkspaceId.get(input.workspaceId);
  if (
    cached?.appCenterService === input.appCenterService &&
    cached?.browserApi === input.browserApi &&
    cached.runtimeApi === input.runtimeApi
  ) {
    return cached.feature;
  }

  const feature = createWorkspaceAppBrowserFeature({
    browserApi: input.browserApi,
    browserService: input.browserService,
    getAppLaunchUrlForNodeId: (nodeId) =>
      resolveWorkspaceAppLaunchUrlForNodeId(input.appCenterService, nodeId),
    i18n: input.i18n,
    runtimeApi: input.runtimeApi,
    workspaceId: input.workspaceId
  });
  browserFeaturesByWorkspaceId.set(input.workspaceId, {
    appCenterService: input.appCenterService,
    browserApi: input.browserApi,
    feature,
    runtimeApi: input.runtimeApi
  });
  return feature;
}

function resolveWorkspaceAppLaunchUrlForNodeId(
  appCenterService: IWorkspaceAppCenterService,
  nodeId: string
): string | null {
  const appId = readWorkspaceAppIdFromNodeId(nodeId);
  if (!appId) {
    return null;
  }
  for (const app of appCenterService.store.apps) {
    if (app.appId === appId) {
      return app.launchUrl ?? null;
    }
  }
  return null;
}
