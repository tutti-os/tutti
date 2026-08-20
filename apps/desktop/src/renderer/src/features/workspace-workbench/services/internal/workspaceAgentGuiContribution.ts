import { createElement, useEffect, useMemo, type ReactNode } from "react";
import type {
  AgentGUIProvider,
  AgentGUIAllAgentsPresentation,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIAgent,
  AgentGUIAgentDirectoryPort
} from "@tutti-os/agent-gui";
import {
  createAgentGuiWorkbenchContribution,
  type AgentGuiWorkbenchConversationIdentity
} from "@tutti-os/agent-gui/workbench/contribution";
import { resolveAgentGuiWorkbenchConversationIdentity } from "@tutti-os/agent-gui/workbench";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "@tutti-os/agent-gui/workbench/types";
import { isAgentGuiWorkbenchProvider } from "@tutti-os/agent-gui/workbench/providerCatalog";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchContribution,
  WorkbenchDockPreviewCache
} from "@tutti-os/workbench-surface";
import type {
  DesktopComputerUseApi,
  DesktopHostFilesApi,
  DesktopHostWindowApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type {
  IAgentsService,
  IWorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { IWorkspaceFilePreviewSurfaceHost } from "@renderer/features/workspace-file-preview";
import type { IReporterService } from "@renderer/features/analytics";
import { createDesktopAgentGUIWorkbenchHostInput } from "@renderer/features/workspace-agent/services/createDesktopAgentGUIWorkbenchHostInput.ts";
import { createDesktopWorkspaceAgentStatusSource } from "@renderer/features/workspace-agent/services/createDesktopAgentStatusSource.ts";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IAgentQuickPromptService as AgentQuickPromptService } from "@renderer/features/workspace-agent/services/agentQuickPromptService.interface.ts";
import type { DesktopAgentGUIWorkbenchBodyProps } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchModel.ts";
import { DesktopAgentGUIWorkbenchBody } from "@renderer/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";
import { requestWorkspaceFilesLaunch } from "../workspaceFilesLaunchCoordinator.ts";
import { requestWorkspaceIssueManagerLaunch } from "../workspaceIssueManagerLaunchCoordinator.ts";
import { requestGroupChatLaunch } from "../groupChatLaunchCoordinator.ts";
import { useExternalStoreValue } from "../../ui/useExternalStoreValue.ts";
import { workspaceAgentGuiNodeFrame } from "./workspaceWorkbenchComposition.ts";
import type { AgentSessionReplayDesktopComposition } from "@renderer/features/agent-session-replay/services/agentSessionReplayDesktopComposition.ts";

function DesktopWorkspaceAgentGUIWorkbenchBodyWithSideRuntime({
  createAgentSideConversationRuntime,
  ...props
}: Omit<
  DesktopWorkspaceAgentGUIWorkbenchBodyProps,
  "agentSideConversationRuntime"
> & {
  createAgentSideConversationRuntime: () => DesktopAgentGUIWorkbenchBodyProps["agentSideConversationRuntime"];
}) {
  const sideRuntime = useMemo(
    () => createAgentSideConversationRuntime(),
    [createAgentSideConversationRuntime]
  );
  useEffect(() => () => sideRuntime?.dispose?.(), [sideRuntime]);
  return createElement(DesktopWorkspaceAgentGUIWorkbenchBody, {
    ...props,
    agentSideConversationRuntime: sideRuntime
  });
}

export function createWorkspaceAgentGuiContribution(input: {
  agentQuickPromptService?: AgentQuickPromptService;
  agentSessionReplayComposition?: AgentSessionReplayDesktopComposition | null;
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
  hostFilesApi: DesktopHostFilesApi;
  hostWindowApi: Pick<DesktopHostWindowApi, "openAgentWindow">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  onCapabilitySettingsRequest?: DesktopAgentGUIWorkbenchBodyProps["onCapabilitySettingsRequest"];
  agentsService: Pick<IAgentsService, "getSnapshot" | "subscribe">;
  allAgentsPresentation?: AgentGUIAllAgentsPresentation | null;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
  tuttidClient: TuttidClient;
  eventStreamClient?: TuttidEventStreamClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceFilePreviewSurfaceHost: IWorkspaceFilePreviewSurfaceHost;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
}): WorkbenchContribution {
  const defaultAgentProvider = isAgentGuiWorkbenchProvider(
    input.defaultAgentProvider
  )
    ? input.defaultAgentProvider
    : null;
  const agentGUIWorkbenchHostInput = createDesktopAgentGUIWorkbenchHostInput({
    agentQuickPromptService: input.agentQuickPromptService,
    agentSessionReplayComposition: input.agentSessionReplayComposition,
    hostFilesApi: input.hostFilesApi,
    eventStreamClient: input.eventStreamClient,
    tuttidClient: input.tuttidClient,
    platformApi: input.platformApi,
    reporterService: input.reporterService,
    richTextAtService: input.richTextAtService,
    runtimeApi: input.runtimeApi,
    workspaceAgentActivityService: input.workspaceAgentActivityService,
    workspaceFileManagerService: input.workspaceFileManagerService,
    workspaceFilePreviewSurfaceHost: input.workspaceFilePreviewSurfaceHost,
    workspaceUserProjectService: input.workspaceUserProjectService,
    workspaceId: input.workspaceId
  });
  const workspaceAgentStatusSource = createDesktopWorkspaceAgentStatusSource({
    agentActivityRuntime: agentGUIWorkbenchHostInput.agentActivityRuntime,
    agents: () => input.agentsService.getSnapshot().agents,
    workspaceAgentProbes:
      agentGUIWorkbenchHostInput.agentHostApi.workspaceAgentProbes,
    workspaceId: input.workspaceId
  });
  const trackWorkspaceAgentGUIEngagement =
    agentGUIWorkbenchHostInput.createAgentGUIEngagementEventSink("workspace");
  const sessionEngine = input.workspaceAgentActivityService.getSessionEngine(
    input.workspaceId
  );
  const handleLinkAction: NonNullable<
    DesktopAgentGUIWorkbenchBodyProps["onLinkAction"]
  > = (action) => {
    void runDesktopAgentGUILinkAction(action, {
      getAgentSession: ({ agentSessionId, workspaceId }) =>
        input.workspaceAgentActivityService.getSession(
          workspaceId,
          agentSessionId
        ),
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
      openExternalUrl: (url) => input.hostFilesApi.openExternal(url),
      workspaceId: input.workspaceId
    });
  };
  const renderAgentGuiWorkbenchBody = (
    context: Parameters<
      Parameters<typeof createAgentGuiWorkbenchContribution>[0]["renderBody"]
    >[0],
    helpers: Parameters<
      Parameters<typeof createAgentGuiWorkbenchContribution>[0]["renderBody"]
    >[1]
  ) => {
    return createElement(DesktopWorkspaceAgentGUIWorkbenchBodyWithSideRuntime, {
      agentActivityRuntime: agentGUIWorkbenchHostInput.agentActivityRuntime,
      createAgentSideConversationRuntime:
        agentGUIWorkbenchHostInput.createAgentSideConversationRuntime,
      agentHostApi: agentGUIWorkbenchHostInput.agentHostApi,
      agentSessionReplayService:
        agentGUIWorkbenchHostInput.agentSessionReplayService,
      agentStatusSource: workspaceAgentStatusSource,
      tuttiModePlanReviewRuntime:
        agentGUIWorkbenchHostInput.tuttiModePlanReviewRuntime,
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
      onConversationRailLayoutChange: helpers.onConversationRailLayoutChange,
      agentsService: helpers.agentDirectory,
      allAgentsPresentation: input.allAgentsPresentation,
      renderAgentsEmpty: input.renderAgentsEmpty,
      comingSoonAgentProviders: input.comingSoonAgentProviders,
      defaultAgentProvider: input.defaultAgentProvider,
      contextMentionProviders:
        agentGUIWorkbenchHostInput.contextMentionProviders,
      runtimeApi: input.runtimeApi,
      trackAgentProviderChatReady:
        agentGUIWorkbenchHostInput.trackAgentProviderChatReady,
      onEngagementEvent: trackWorkspaceAgentGUIEngagement,
      trackWorkspaceFileReferences:
        agentGUIWorkbenchHostInput.trackWorkspaceFileReferences,
      workspaceFileReferenceAdapter:
        agentGUIWorkbenchHostInput.workspaceFileReferenceAdapter,
      resolveExternalPromptEntries:
        agentGUIWorkbenchHostInput.resolveExternalPromptEntries,
      prepareExternalPromptFiles:
        agentGUIWorkbenchHostInput.prepareExternalPromptFiles,
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
  };

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
      openDetachedWindow: input.appI18n.t("workspace.agentGui.openNewWindow"),
      nodeTitle: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.agent),
      untitledConversation: input.appI18n.t(
        "workspace.agentGui.untitledConversation"
      ),
      sessionMenu: {
        copyAsMarkdown: input.appI18n.t(
          "workspace.agentGui.sessionMenu.copyAsMarkdown"
        ),
        copyAsReference: input.appI18n.t(
          "workspace.agentGui.sessionMenu.copyAsReference"
        ),
        moreSessionActions: input.appI18n.t(
          "workspace.agentGui.sessionMenu.moreActions"
        ),
        renameSession: input.appI18n.t("workspace.agentGui.sessionMenu.rename")
      }
    },
    dockIconUrls: input.dockIconUrls,
    unifiedDockIconUrl: input.unifiedDockIconUrl,
    frame: workspaceAgentGuiNodeFrame,
    defaultProvider: defaultAgentProvider,
    agentDirectory: input.agentsService,
    providerAvailability: () =>
      resolveWorkspaceAgentGuiProviderAvailability(
        input.agentProviderStatusService
      ),
    renderBody: (context, helpers) =>
      renderAgentGuiWorkbenchBody(context, helpers),
    resolveDockPopupIdentity: (state) =>
      resolveWorkspaceAgentGuiDockPopupIdentity(state, {
        dockIconUrls: input.dockIconUrls,
        agents: input.agentsService.getSnapshot().agents,
        sessionEngine
      }),
    onOpenDetachedWindow: ({ agentTargetId, provider }) => {
      void requestWorkspaceAgentGuiLaunch({
        agentTargetId,
        openInNewWindow: true,
        provider,
        workspaceId: input.workspaceId
      });
    },
    sessionEngine,
    workspaceId: input.workspaceId
  });
}

type DesktopWorkspaceAgentGUIWorkbenchBodyProps = Omit<
  DesktopAgentGUIWorkbenchBodyProps,
  "agentDirectory" | "defaultAgentTargetId"
> & {
  agentsService: AgentGUIAgentDirectoryPort;
  defaultAgentProvider?: string | null;
};

function DesktopWorkspaceAgentGUIWorkbenchBody({
  agentsService,
  defaultAgentProvider,
  ...props
}: DesktopWorkspaceAgentGUIWorkbenchBodyProps): ReactNode {
  const snapshot = useExternalStoreValue(
    (listener) => agentsService.subscribe(listener),
    () => agentsService.getSnapshot(),
    () => agentsService.getSnapshot()
  );
  return createElement(DesktopAgentGUIWorkbenchBody, {
    ...props,
    agentDirectory: snapshot,
    defaultAgentTargetId: resolveDefaultAgentTargetId({
      agents: snapshot.agents,
      defaultProvider: defaultAgentProvider
    })
  });
}

function resolveDefaultAgentTargetId(input: {
  agents: readonly AgentGUIAgent[];
  defaultProvider?: string | null;
}): string | null {
  const defaultProvider = input.defaultProvider?.trim() ?? "";
  return (
    input.agents.find(
      (agent) =>
        defaultProvider !== "" &&
        agent.provider === defaultProvider &&
        agent.availability.status === "ready"
    )?.agentTargetId ??
    input.agents.find((agent) => agent.availability.status === "ready")
      ?.agentTargetId ??
    null
  );
}

function resolveWorkspaceAgentGuiProviderAvailability(
  service: AgentProviderStatusService
): Partial<Record<AgentGuiWorkbenchProvider, boolean>> {
  const availability: Partial<Record<AgentGuiWorkbenchProvider, boolean>> = {};
  for (const status of service.getSnapshot().statuses) {
    if (!isAgentGuiWorkbenchProvider(status.provider)) {
      continue;
    }
    // Only pin ready providers. Contribution rebuilds freeze this map; marking
    // in-flight probes as false blocks dock launch until the next revision and
    // Agent Session Replay clicks often land in that window.
    if (status.availability.status === "ready") {
      availability[status.provider] = true;
    }
  }
  return availability;
}

function resolveWorkspaceAgentGuiDockPopupIdentity(
  state: AgentGuiWorkbenchState | null,
  input: {
    dockIconUrls?: Parameters<
      typeof createAgentGuiWorkbenchContribution
    >[0]["dockIconUrls"];
    agents?: readonly AgentGUIAgent[];
    sessionEngine: ReturnType<
      IWorkspaceAgentActivityService["getSessionEngine"]
    >;
  }
): AgentGuiWorkbenchConversationIdentity | null {
  return resolveAgentGuiWorkbenchConversationIdentity({
    agents: input.agents ?? [],
    dockIconUrls: input.dockIconUrls,
    engineState: input.sessionEngine.getSnapshot(),
    workbenchState: state
  });
}
