import type { DesktopWorkbenchContributionFactory } from "../workspaceWorkbenchContributionFactory";
import type { BrowserNodeFeature } from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createWorkspaceAppCenterContribution } from "@renderer/features/workspace-app-center";
import type { DesktopBrowserApi, DesktopRuntimeApi } from "@preload/types";
import { createWorkspaceAppBrowserFeature } from "./workspaceAppBrowserFeature.ts";
import type { WorkspaceBrowserService } from "../workspaceBrowserService.ts";

interface CachedWorkspaceAppBrowserFeature {
  browserApi: DesktopBrowserApi;
  feature: BrowserNodeFeature;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

const browserFeaturesByWorkspaceId = new Map<
  string,
  CachedWorkspaceAppBrowserFeature
>();

export const appCenterWorkbenchContributionFactory: DesktopWorkbenchContributionFactory =
  {
    id: "workspace-app-center",
    order: 18,
    create(context) {
      return context.browserApi
        ? createWorkspaceAppCenterContribution({
            appCenterService: context.appCenterService,
            browserFeature: resolveWorkspaceAppBrowserFeature({
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
  browserApi: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  i18n?: I18nRuntime<string>;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  workspaceId: string;
}): BrowserNodeFeature {
  const cached = browserFeaturesByWorkspaceId.get(input.workspaceId);
  if (
    cached?.browserApi === input.browserApi &&
    cached.runtimeApi === input.runtimeApi
  ) {
    return cached.feature;
  }

  const feature = createWorkspaceAppBrowserFeature({
    browserApi: input.browserApi,
    browserService: input.browserService,
    i18n: input.i18n,
    runtimeApi: input.runtimeApi,
    workspaceId: input.workspaceId
  });
  browserFeaturesByWorkspaceId.set(input.workspaceId, {
    browserApi: input.browserApi,
    feature,
    runtimeApi: input.runtimeApi
  });
  return feature;
}
