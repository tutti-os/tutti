import {
  createBrowserNodeFeature,
  type BrowserNodeEvent,
  type BrowserNodeFeature
} from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopBrowserApi, DesktopRuntimeApi } from "@preload/types";
import { workspaceAppWebviewTypeID } from "../../../../workspace-app-center/services/workspaceAppCenterLaunchIds.ts";
import type { WorkspaceBrowserService } from "../workspaceBrowserService.ts";

export function createWorkspaceAppBrowserFeature(input: {
  browserApi: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  getAppLaunchUrlForNodeId?: (nodeId: string) => string | null | undefined;
  i18n?: I18nRuntime<string>;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  workspaceId: string;
}): BrowserNodeFeature {
  const feature = createBrowserNodeFeature({
    hostApi: input.browserService.createFeatureHostApi({
      acceptsEvent: (event) =>
        isWorkspaceAppBrowserEvent(event, input.getAppLaunchUrlForNodeId),
      source: "workspace_app",
      workspaceId: input.workspaceId
    }),
    i18n: input.i18n,
    reportDiagnostic: (diagnostic) => {
      void input.runtimeApi
        .logRendererDiagnostic({
          details: diagnostic.details,
          event: `browser-node.${diagnostic.event}`,
          level: diagnostic.level,
          source: "workspace-app-webview",
          workspaceId: input.workspaceId
        })
        .catch(() => undefined);
    }
  });
  input.browserService.ensureFeatureConnected(feature);
  return feature;
}

function isWorkspaceAppBrowserEvent(
  event: BrowserNodeEvent,
  getAppLaunchUrlForNodeId:
    | ((nodeId: string) => string | null | undefined)
    | undefined
): boolean {
  const nodeId = event.type === "open-url" ? event.sourceNodeId : event.nodeId;
  const isWorkspaceAppNode =
    nodeId.startsWith(`${workspaceAppWebviewTypeID}:`) ||
    nodeId.startsWith("workspace-app:");
  if (!isWorkspaceAppNode) {
    return false;
  }
  if (
    event.type === "open-url" &&
    hasSameUrlOrigin(event.url, getAppLaunchUrlForNodeId?.(nodeId))
  ) {
    return false;
  }
  return true;
}

function hasSameUrlOrigin(
  left: string,
  right: string | null | undefined
): boolean {
  try {
    return right != null && new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
