import { useEffect, useMemo } from "react";
import type { DesktopApi } from "@preload/types";
import type { DesktopWorkspaceOpenFeatureRequest } from "@shared/contracts/ipc";
import { registerWorkspaceAgentGuiLaunchHandler } from "../../workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import type { IWorkspaceAppCenterService } from "../../workspace-app-center/services/workspaceAppCenterService.interface.ts";
import {
  createFusionNativeLaunchAdapter,
  type FusionNativeLaunchAdapter
} from "./fusionNativeLaunchAdapter.ts";
import { registerGroupChatLaunchHandler } from "./groupChatLaunchCoordinator.ts";
import { registerWorkspaceBrowserLaunchHandler } from "./workspaceBrowserLaunchCoordinator.ts";
import { registerWorkspaceFilesLaunchHandler } from "./workspaceFilesLaunchCoordinator.ts";
import { registerWorkspaceIssueManagerLaunchHandler } from "./workspaceIssueManagerLaunchCoordinator.ts";
import { registerWorkspaceWorkbenchNodeLaunchHandler } from "./workspaceWorkbenchNodeLaunchCoordinator.ts";
import type { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface.ts";
import { createStandaloneAgentWindowLaunchPayload } from "./standaloneAgentWindowIntent.ts";

export function registerStandaloneFusionLaunchCoordinators(input: {
  adapter: FusionNativeLaunchAdapter;
  includeWorkbenchNodeHandler?: boolean;
  workspaceId: string;
}): () => void {
  const releases = [
    registerWorkspaceAgentGuiLaunchHandler(
      input.workspaceId,
      async (request) => {
        await input.adapter.openAgent(request);
      }
    ),
    registerWorkspaceBrowserLaunchHandler(
      input.workspaceId,
      input.adapter.openBrowser
    ),
    registerWorkspaceFilesLaunchHandler(
      input.workspaceId,
      input.adapter.openFiles
    ),
    registerWorkspaceIssueManagerLaunchHandler(
      input.workspaceId,
      input.adapter.openIssueManager
    ),
    registerGroupChatLaunchHandler(
      input.workspaceId,
      input.adapter.openGroupChat
    )
  ];
  if (input.includeWorkbenchNodeHandler) {
    releases.push(
      registerWorkspaceWorkbenchNodeLaunchHandler(
        input.workspaceId,
        async (request) =>
          Boolean(await input.adapter.openWorkbenchNode(request))
      )
    );
  }
  return () => {
    for (const release of [...releases].reverse()) {
      release();
    }
  };
}

export function useStandaloneFusionLaunchCoordinators(input: {
  appCenterService?: IWorkspaceAppCenterService;
  desktopApi: DesktopApi;
  enabled?: boolean;
  includeWorkbenchNodeHandler?: boolean;
  workbenchHostService?: Pick<
    IWorkspaceWorkbenchHostService,
    "onOpenFeatureRequest"
  >;
  workspaceId: string;
}): FusionNativeLaunchAdapter {
  const adapter = useMemo(
    () =>
      createFusionNativeLaunchAdapter({
        appCenterService: input.appCenterService,
        fusionApi: input.desktopApi.fusion,
        workspaceId: input.workspaceId
      }),
    [input.appCenterService, input.desktopApi.fusion, input.workspaceId]
  );

  useEffect(() => {
    if (input.enabled === false) {
      return;
    }
    return registerStandaloneFusionLaunchCoordinators({
      adapter,
      includeWorkbenchNodeHandler: input.includeWorkbenchNodeHandler,
      workspaceId: input.workspaceId
    });
  }, [
    adapter,
    input.enabled,
    input.includeWorkbenchNodeHandler,
    input.workspaceId
  ]);

  useEffect(() => {
    if (input.enabled === false || !input.workbenchHostService) {
      return;
    }
    return input.workbenchHostService.onOpenFeatureRequest((request) => {
      void openStandaloneFusionFeatureRequest({
        adapter,
        request,
        workspaceId: input.workspaceId
      }).then((handled) => {
        if (handled) {
          return;
        }
        return input.desktopApi.runtime.logRendererDiagnostic({
          details: { feature: request.feature },
          event: "fusion.open_feature.unsupported",
          level: "warn",
          source: "fusion-launch-coordinator",
          workspaceId: input.workspaceId
        });
      });
    });
  }, [adapter, input.enabled, input.workbenchHostService, input.workspaceId]);

  return adapter;
}

export async function openStandaloneFusionFeatureRequest(input: {
  adapter: FusionNativeLaunchAdapter;
  request: DesktopWorkspaceOpenFeatureRequest;
  workspaceId: string;
}): Promise<boolean> {
  if (input.request.feature === "app-center") {
    await input.adapter.openPayloadWindow({ kind: "app-center" });
    return true;
  }
  if (input.request.feature === "issue-manager") {
    return input.adapter.openIssueManager({ workspaceId: input.workspaceId });
  }
  if (
    input.request.feature === "message-center" ||
    input.request.feature === "agent-connect" ||
    input.request.feature === "agent-manage"
  ) {
    await input.adapter.openPayloadWindow({
      kind: "agent",
      payload: createStandaloneAgentWindowLaunchPayload({
        agentFeature:
          input.request.feature === "message-center"
            ? "message-center"
            : input.request.feature === "agent-connect"
              ? "connect"
              : "manage",
        ...(input.request.provider ? { provider: input.request.provider } : {})
      })
    });
    return true;
  }
  return input.adapter.openAgent({
    autoSubmit: input.request.autoSubmit === true,
    ...(input.request.draftPrompt?.trim()
      ? { draftPrompt: input.request.draftPrompt.trim() }
      : {}),
    openInNewWindow: true,
    ...(input.request.provider ? { provider: input.request.provider } : {}),
    workspaceId: input.workspaceId
  });
}
