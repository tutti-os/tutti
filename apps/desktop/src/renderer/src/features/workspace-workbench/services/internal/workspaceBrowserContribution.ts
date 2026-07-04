import type { ReactNode } from "react";
import {
  createBrowserNodeFeature,
  type BrowserNodeEvent
} from "@tutti-os/browser-node";
import browserDockIconUrl from "@tutti-os/browser-node/assets/workspace-dock-website.png";
import {
  createBrowserDockIconImage,
  createBrowserWorkbenchContribution
} from "@tutti-os/browser-node/workbench";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostNodeHeaderContext
} from "@tutti-os/workbench-surface";
import type { DesktopBrowserApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createWorkspaceBrowserAnalyticsTracker } from "./workspaceBrowserAnalytics.ts";
import {
  createWorkspaceBrowserNodeExternalStateSource,
  resolveWorkspaceBrowserSearchUrl
} from "./workspaceBrowserContributionCore.ts";
import { composeWorkbenchNodeLeases } from "./workspaceNodeLifecycleAnalytics.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchComposition.ts";
import type { WorkspaceBrowserService } from "./workspaceBrowserService.ts";

const browserNodeDefaultUrl = "https://www.google.com/";

export function createWorkspaceBrowserContribution(input: {
  browserApi: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  dockIconUrl?: string;
  i18n?: I18nRuntime<string>;
  renderTrafficLights?: (context: WorkbenchHostNodeHeaderContext) => ReactNode;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceId: string;
}): WorkbenchContribution {
  const analyticsTracker = createWorkspaceBrowserAnalyticsTracker({
    reporterService: input.reporterService
  });
  const browserApi = input.browserService.createFeatureHostApi({
    acceptsEvent: isWorkspaceBrowserEvent,
    observeEvent: (event) => analyticsTracker.observeEvent(event),
    workspaceId: input.workspaceId
  });
  const feature = createBrowserNodeFeature({
    hostApi: browserApi,
    i18n: input.i18n,
    reportDiagnostic: (diagnostic) => {
      void input.runtimeApi
        .logRendererDiagnostic({
          details: diagnostic.details,
          event: `browser-node.${diagnostic.event}`,
          level: diagnostic.level,
          source: "workspace-browser",
          workspaceId: input.workspaceId
        })
        .catch(() => undefined);
    },
    resolveSearchUrl: resolveWorkspaceBrowserSearchUrl
  });
  input.browserService.ensureFeatureConnected(feature);

  const contribution = createBrowserWorkbenchContribution({
    contributionId: "workspace-browser",
    defaultUrl: browserNodeDefaultUrl,
    dockEntry: {
      dockIcon: createBrowserDockIconImage(
        input.dockIconUrl ?? browserDockIconUrl
      ),
      id: workspaceBrowserNodeID,
      order: 20,
      sectionId: "apps"
    },
    externalStateSource: createWorkspaceBrowserNodeExternalStateSource({
      runtimeStore: feature.runtimeStore
    }),
    feature,
    node: {
      renderTrafficLights: input.renderTrafficLights
    },
    typeId: workspaceBrowserNodeID
  });

  return {
    ...contribution,
    nodes: contribution.nodes?.map((node) =>
      node.typeId === workspaceBrowserNodeID
        ? {
            ...node,
            createLease: (context) =>
              composeWorkbenchNodeLeases(
                node.createLease?.(context),
                analyticsTracker.createNodeLease(context)
              )
          }
        : node
    )
  };
}

function isWorkspaceBrowserEvent(event: BrowserNodeEvent): boolean {
  const nodeId = event.type === "open-url" ? event.sourceNodeId : event.nodeId;
  return nodeId.startsWith(`${workspaceBrowserNodeID}:`);
}
