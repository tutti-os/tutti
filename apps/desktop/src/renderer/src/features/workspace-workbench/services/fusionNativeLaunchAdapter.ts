import type { DesktopFusionApi } from "@preload/types";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import type {
  DesktopFusionOpenWindowInput,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import type { WorkspaceAgentGuiLaunchRequest } from "../../workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { findWorkspaceApp } from "../../workspace-app-center/workspaceAppLaunch.ts";
import type { IWorkspaceAppCenterService } from "../../workspace-app-center/services/workspaceAppCenterService.interface.ts";
import type { WorkspaceBrowserLaunchRequest } from "./workspaceBrowserLaunchCoordinator.ts";
import type { WorkspaceFilesLaunchRequest } from "./workspaceFilesLaunchCoordinator.ts";
import type { WorkspaceIssueManagerLaunchRequest } from "./workspaceIssueManagerLaunchCoordinator.ts";
import {
  buildGroupChatDeepLinkUrl,
  type GroupChatLaunchRequest
} from "./groupChatLaunchCoordinator.ts";
import { resolveFusionKindForWorkbenchTypeId } from "./fusionWindowModel.ts";
import { createStandaloneAgentWindowLaunchPayload } from "./standaloneAgentWindowIntent.ts";
import { readResourceIdFromLaunchPayload } from "./standaloneWorkbenchNodeAdapter.ts";

export interface FusionNativeLaunchAdapter {
  openAgent(request: WorkspaceAgentGuiLaunchRequest): Promise<boolean>;
  openBrowser(request: WorkspaceBrowserLaunchRequest): Promise<boolean>;
  openFiles(request: WorkspaceFilesLaunchRequest): Promise<boolean>;
  openGroupChat(request: GroupChatLaunchRequest): Promise<boolean>;
  openIssueManager(
    request: WorkspaceIssueManagerLaunchRequest
  ): Promise<boolean>;
  openPayloadWindow(input: {
    forceNew?: boolean;
    kind: DesktopFusionWindowKind;
    payload?: unknown;
    resourceId?: string | null;
    title?: string | null;
  }): Promise<DesktopFusionWindowDescriptor>;
  openSettings(payload?: unknown): Promise<boolean>;
  openWorkbenchNode(input: {
    payload?: unknown;
    typeId: string;
  }): Promise<DesktopFusionWindowDescriptor | null>;
  openWorkspaceApp(input: {
    appId: string;
    forceNew?: boolean;
    intent?: unknown;
    prepared?: boolean;
    prevStatus?: WorkspaceAppCenterApp["runtimeStatus"];
  }): Promise<boolean>;
}

export function createFusionNativeLaunchAdapter(input: {
  appCenterService?: IWorkspaceAppCenterService;
  fusionApi: DesktopFusionApi;
  workspaceId: string;
}): FusionNativeLaunchAdapter {
  const openPayloadWindow = (request: {
    forceNew?: boolean;
    kind: DesktopFusionWindowKind;
    payload?: unknown;
    resourceId?: string | null;
    title?: string | null;
  }) =>
    input.fusionApi.openWindow({
      forceNew: request.forceNew ?? true,
      kind: request.kind,
      launchPayload: request.payload,
      ...(request.resourceId !== undefined
        ? { resourceId: request.resourceId }
        : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      workspaceId: input.workspaceId
    });
  const openWorkspaceApp = async (request: {
    appId: string;
    forceNew?: boolean;
    intent?: unknown;
    prepared?: boolean;
    prevStatus?: WorkspaceAppCenterApp["runtimeStatus"];
  }) => {
    await openPayloadWindow({
      ...(request.forceNew !== undefined ? { forceNew: request.forceNew } : {}),
      kind: "workspace-app",
      payload: {
        appId: request.appId,
        ...(request.intent ? { intent: request.intent } : {}),
        ...(request.prepared ? { prepared: true } : {}),
        ...(request.prevStatus ? { prevStatus: request.prevStatus } : {})
      },
      resourceId: request.appId
    });
    return true;
  };

  return {
    async openAgent(request) {
      const payload = createStandaloneAgentWindowLaunchPayload(request);
      const agentSessionId = request.agentSessionId?.trim() || null;
      const descriptor = await input.fusionApi.openWindow({
        forceNew:
          request.openInNewWindow === true ||
          (agentSessionId === null && hasAgentNewWorkPayload(request)),
        kind: "agent",
        launchPayload: payload,
        resourceId: agentSessionId,
        workspaceId: input.workspaceId
      });
      return Boolean(descriptor);
    },
    async openBrowser(request) {
      await openPayloadWindow({
        kind: "browser",
        payload: withoutWorkspaceId(request)
      });
      return true;
    },
    async openFiles(request) {
      await openPayloadWindow({
        kind: "files",
        payload: withoutWorkspaceId(request),
        resourceId: request.path
      });
      return true;
    },
    async openGroupChat(request) {
      let launchUrl = input.appCenterService
        ? findWorkspaceApp(
            input.appCenterService,
            "group-chat"
          )?.launchUrl?.trim()
        : null;
      if (!launchUrl && input.appCenterService) {
        await input.appCenterService.refresh(input.workspaceId);
        launchUrl = findWorkspaceApp(
          input.appCenterService,
          "group-chat"
        )?.launchUrl?.trim();
      }
      if (!launchUrl) {
        return false;
      }
      await openPayloadWindow({
        kind: "workspace-app",
        payload: {
          appId: "group-chat",
          url: buildGroupChatDeepLinkUrl(launchUrl, request)
        },
        resourceId: "group-chat"
      });
      return true;
    },
    async openIssueManager(request) {
      await openPayloadWindow({
        kind: "issue-manager",
        payload: withoutWorkspaceId(request),
        resourceId: request.issueId?.trim() || null
      });
      return true;
    },
    openPayloadWindow,
    async openSettings(payload) {
      await openPayloadWindow({ kind: "settings", payload });
      return true;
    },
    async openWorkbenchNode(request) {
      const resolved = createFusionWorkbenchNodeOpenInput(request);
      if (!resolved) {
        return null;
      }
      return openPayloadWindow({
        kind: resolved.kind,
        payload: resolved.launchPayload,
        resourceId: resolved.resourceId
      });
    },
    openWorkspaceApp
  };
}

export function createFusionWorkbenchNodeOpenInput(request: {
  payload?: unknown;
  typeId: string;
}): Pick<
  DesktopFusionOpenWindowInput,
  "kind" | "launchPayload" | "resourceId"
> | null {
  const kind = resolveFusionKindForWorkbenchTypeId(request.typeId);
  if (!kind) {
    return null;
  }
  return {
    kind,
    launchPayload: request.payload,
    resourceId: readResourceIdFromLaunchPayload(kind, request.payload)
  };
}

function hasAgentNewWorkPayload(request: WorkspaceAgentGuiLaunchRequest) {
  return Boolean(
    request.agentTargetId?.trim() ||
    request.autoSubmit === true ||
    request.draftPrompt?.trim() ||
    request.provider ||
    request.userProjectPath?.trim()
  );
}

function withoutWorkspaceId<T extends { workspaceId: string }>(
  request: T
): Omit<T, "workspaceId"> {
  const { workspaceId: _workspaceId, ...payload } = request;
  return payload;
}
