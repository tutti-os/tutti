import { createElement, type CSSProperties, type ReactNode } from "react";
import type { AgentGUIProviderTarget } from "@tutti-os/agent-gui";
import {
  createAgentGuiWorkbenchContribution,
  resolveAgentGuiUnifiedDockLaunchPayload
} from "@tutti-os/agent-gui/workbench/contribution";
import { resolveAgentGuiWorkbenchSessionTitle } from "@tutti-os/agent-gui/workbench/sessionTitle";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "@tutti-os/agent-gui/workbench/types";
import { isAgentGuiWorkbenchProvider } from "@tutti-os/agent-gui/workbench/providerCatalog";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchContribution,
  WorkbenchDockPreviewCache
} from "@tutti-os/workbench-surface";
import type {
  DesktopComputerUseApi,
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { IReporterService } from "@renderer/features/analytics";
import {
  createDesktopAgentGUIWorkbenchHostInput,
  DesktopAgentGUIWorkbenchBody,
  preloadDesktopAgentGuiMentionBrowse,
  requestWorkspaceAgentGuiLaunch,
  type AgentProviderStatusService
} from "@renderer/features/workspace-agent";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";
import { requestWorkspaceFilesLaunch } from "../workspaceFilesLaunchCoordinator.ts";
import { requestWorkspaceIssueManagerLaunch } from "../workspaceIssueManagerLaunchCoordinator.ts";
import { requestGroupChatLaunch } from "../groupChatLaunchCoordinator.ts";
import { workspaceAgentGuiNodeFrame } from "./workspaceWorkbenchComposition.ts";

export function createWorkspaceAgentGuiContribution(input: {
  agentProviderStatusService: AgentProviderStatusService;
  appCenterService: IWorkspaceAppCenterService;
  appI18n: I18nRuntime<string>;
  computerUseApi: Pick<DesktopComputerUseApi, "checkStatus">;
  dockPreviewCache: WorkbenchDockPreviewCache;
  dockIconUrls?: Parameters<
    typeof createAgentGuiWorkbenchContribution
  >[0]["dockIconUrls"];
  unifiedDockIconUrl?: Parameters<
    typeof createAgentGuiWorkbenchContribution
  >[0]["unifiedDockIconUrl"];
  defaultAgentProvider?: string | null;
  defaultProviderTargetId?: string | null;
  hostFilesApi: DesktopHostFilesApi;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  onCapabilitySettingsRequest?: Parameters<
    typeof DesktopAgentGUIWorkbenchBody
  >[0]["onCapabilitySettingsRequest"];
  providerTargets?: readonly AgentGUIProviderTarget[];
  providerTargetsLoading?: boolean;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
}): WorkbenchContribution {
  const agentGUIWorkbenchHostInput = createDesktopAgentGUIWorkbenchHostInput({
    hostFilesApi: input.hostFilesApi,
    tuttidClient: input.tuttidClient,
    platformApi: input.platformApi,
    reporterService: input.reporterService,
    richTextAtService: input.richTextAtService,
    runtimeApi: input.runtimeApi,
    workspaceAgentActivityService: input.workspaceAgentActivityService,
    workspaceFileManagerService: input.workspaceFileManagerService,
    workspaceUserProjectService: input.workspaceUserProjectService,
    workspaceId: input.workspaceId
  });
  // Warm the @-mention browse cache at workspace startup (this factory runs once
  // per workspace, before the agent GUI is opened) so the first palette open is
  // instant rather than waiting for a focus-driven preload.
  preloadDesktopAgentGuiMentionBrowse({
    workspaceId: input.workspaceId,
    baseProviders: agentGUIWorkbenchHostInput.contextMentionProviders,
    agentActivityRuntime: agentGUIWorkbenchHostInput.agentActivityRuntime
  });
  const handleLinkAction: NonNullable<
    Parameters<typeof DesktopAgentGUIWorkbenchBody>[0]["onLinkAction"]
  > = (action) => {
    void runDesktopAgentGUILinkAction(action, {
      homeDirectory: input.platformApi.homeDirectory,
      launchAgentGui: requestWorkspaceAgentGuiLaunch,
      launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
      launchWorkspaceFiles: requestWorkspaceFilesLaunch,
      launchWorkspaceApp: async ({ appId, workspaceId }) => {
        await input.appCenterService.openApp({ appId, workspaceId });
        return true;
      },
      launchGroupChat: requestGroupChatLaunch,
      openBrowserUrl: requestWorkspaceBrowserLaunch,
      workspaceId: input.workspaceId
    });
  };
  const renderAgentGuiWorkbenchBody = (
    context: Parameters<
      Parameters<typeof createAgentGuiWorkbenchContribution>[0]["renderBody"]
    >[0],
    helpers: Parameters<
      Parameters<typeof createAgentGuiWorkbenchContribution>[0]["renderBody"]
    >[1],
    options?: { previewMode?: boolean }
  ) =>
    createElement(DesktopAgentGUIWorkbenchBody, {
      agentActivityRuntime: agentGUIWorkbenchHostInput.agentActivityRuntime,
      agentQueuedPromptRuntime:
        agentGUIWorkbenchHostInput.agentQueuedPromptRuntime,
      agentHostApi: agentGUIWorkbenchHostInput.agentHostApi,
      appCenterService: input.appCenterService,
      agentProviderStatusService: input.agentProviderStatusService,
      context,
      computerUseApi: input.computerUseApi,
      dockPreviewCache: input.dockPreviewCache,
      onCapabilitySettingsRequest: input.onCapabilitySettingsRequest,
      onLinkAction: handleLinkAction,
      onOpenAgentConversationWindow: async (request) => {
        await requestWorkspaceAgentGuiLaunch({
          ...request,
          openInNewWindow: true
        });
      },
      onStateChange: (...args) => helpers.onStateChange(...args),
      previewMode: options?.previewMode,
      providerTargets: input.providerTargets,
      providerTargetsLoading: input.providerTargetsLoading,
      defaultProviderTargetId: input.defaultProviderTargetId,
      contextMentionProviders:
        agentGUIWorkbenchHostInput.contextMentionProviders,
      runtimeApi: input.runtimeApi,
      trackAgentProviderChatReady:
        agentGUIWorkbenchHostInput.trackAgentProviderChatReady,
      trackWorkspaceFileReferences:
        agentGUIWorkbenchHostInput.trackWorkspaceFileReferences,
      workspaceFileReferenceAdapter:
        agentGUIWorkbenchHostInput.workspaceFileReferenceAdapter,
      resolveDroppedFileReferences:
        agentGUIWorkbenchHostInput.resolveDroppedFileReferences,
      onRequestGitBranches: agentGUIWorkbenchHostInput.onRequestGitBranches,
      referenceSourceAggregator:
        agentGUIWorkbenchHostInput.referenceSourceAggregator,
      resolveWorkspaceReferenceEntryIconUrl:
        agentGUIWorkbenchHostInput.resolveWorkspaceReferenceEntryIconUrl,
      resolveMentionReferenceTarget:
        agentGUIWorkbenchHostInput.resolveMentionReferenceTarget,
      resolveWorkspaceReferenceInitialTarget:
        agentGUIWorkbenchHostInput.resolveWorkspaceReferenceInitialTarget,
      workspaceId: input.workspaceId
    });

  return createAgentGuiWorkbenchContribution({
    copy: {
      collapseConversationRail: input.appI18n.t(
        "workspace.agentGui.collapseConversationRail"
      ),
      expandConversationRail: input.appI18n.t(
        "workspace.agentGui.expandConversationRail"
      ),
      fallbackAgentLabel: input.appI18n.t(
        "workspace.agentGui.fallbackAgentLabel"
      ),
      newConversation: input.appI18n.t("workspace.agentGui.newConversation"),
      nodeTitle: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.agent)
    },
    dockIconUrls: input.dockIconUrls,
    unifiedDockIconUrl: input.unifiedDockIconUrl,
    frame: workspaceAgentGuiNodeFrame,
    defaultProvider: isAgentGuiWorkbenchProvider(input.defaultAgentProvider)
      ? input.defaultAgentProvider
      : null,
    defaultProviderTargetId: input.defaultProviderTargetId,
    providerAvailability: resolveWorkspaceAgentGuiProviderAvailability(
      input.agentProviderStatusService
    ),
    providerTargets: input.providerTargets,
    providerTargetsLoading: input.providerTargetsLoading,
    resolveDockLaunchPayload: () =>
      resolveAgentGuiUnifiedDockLaunchPayload({
        defaultProvider: isAgentGuiWorkbenchProvider(input.defaultAgentProvider)
          ? input.defaultAgentProvider
          : null,
        defaultProviderTargetId: input.defaultProviderTargetId,
        providerAvailability: resolveWorkspaceAgentGuiProviderAvailability(
          input.agentProviderStatusService
        ),
        providerTargetsLoading: input.providerTargetsLoading,
        targets: input.providerTargets
      }),
    renderBody: (context, helpers) =>
      renderAgentGuiWorkbenchBody(context, helpers),
    renderPreview: (context, helpers) =>
      createElement(
        DesktopAgentGUIWorkbenchDockPreviewFrame,
        { height: context.node.frame.height, width: context.node.frame.width },
        renderAgentGuiWorkbenchBody(context, helpers, { previewMode: true })
      ),
    renderMinimizedPreview: (context, helpers) => {
      const previewViewport =
        context.previewViewport ?? minimizedDockPreviewViewport;
      return createElement(
        DesktopAgentGUIWorkbenchDockPreviewFrame,
        {
          height: context.node.frame.height,
          viewport: previewViewport,
          width: context.node.frame.width
        },
        renderAgentGuiWorkbenchBody(context, helpers, { previewMode: true })
      );
    },
    resolveDockPopupTitle: (state) =>
      resolveWorkspaceAgentGuiDockPopupTitle(state, {
        workspaceAgentActivityService: input.workspaceAgentActivityService,
        workspaceId: input.workspaceId
      }),
    workspaceId: input.workspaceId
  });
}

function resolveWorkspaceAgentGuiProviderAvailability(
  service: AgentProviderStatusService
): Partial<Record<AgentGuiWorkbenchProvider, boolean>> {
  const availability: Partial<Record<AgentGuiWorkbenchProvider, boolean>> = {};
  for (const status of service.getSnapshot().statuses) {
    if (isAgentGuiWorkbenchProvider(status.provider)) {
      availability[status.provider] = status.availability.status === "ready";
    }
  }
  return availability;
}

function resolveWorkspaceAgentGuiDockPopupTitle(
  state: AgentGuiWorkbenchState | null,
  input: {
    workspaceAgentActivityService: IWorkspaceAgentActivityService;
    workspaceId: string;
  }
): string | null {
  const agentSessionId = state?.lastActiveAgentSessionId?.trim() ?? "";
  if (!agentSessionId) {
    return null;
  }
  const snapshot = input.workspaceAgentActivityService.getSnapshot(
    input.workspaceId
  );
  const provider =
    snapshot.sessions.find((item) => item.agentSessionId === agentSessionId)
      ?.provider ?? "codex";
  return resolveAgentGuiWorkbenchSessionTitle({
    agentSessionId,
    fallbackTitle: null,
    provider,
    snapshot
  }).title;
}

const dockPopupPreviewViewport = {
  height: 95,
  width: 157
};

const minimizedDockPreviewViewport = {
  height: 34.2,
  width: 46.8
};

function DesktopAgentGUIWorkbenchDockPreviewFrame({
  children,
  height,
  viewport = dockPopupPreviewViewport,
  width
}: {
  children?: ReactNode;
  height: number;
  viewport?: { height: number; width: number };
  width: number;
}): ReactNode {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(
    viewport.width / safeWidth,
    viewport.height / safeHeight
  );
  const bodyStyle = {
    height: `${safeHeight}px`,
    left: "50%",
    position: "absolute",
    top: "50%",
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: "center",
    width: `${safeWidth}px`
  } satisfies CSSProperties;

  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className:
        "relative block h-full w-full overflow-hidden rounded-md bg-transparent",
      style: {
        height: `${viewport.height}px`,
        width: `${viewport.width}px`
      } satisfies CSSProperties
    },
    createElement(
      "span",
      {
        className: "pointer-events-none block overflow-hidden",
        style: bodyStyle
      },
      children
    )
  );
}
