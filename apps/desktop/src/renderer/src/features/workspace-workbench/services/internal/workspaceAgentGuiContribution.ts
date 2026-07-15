import { createElement, type CSSProperties, type ReactNode } from "react";
import type {
  AgentGUIProvider,
  AgentGUIAllAgentsPresentation,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIAgent,
  AgentGUIAgentDirectoryPort
} from "@tutti-os/agent-gui";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { resolveAgentGuiSessionProviderIconUrl } from "@tutti-os/agent-gui/agentGuiSessionProviderIconUrls";
import {
  createAgentGuiWorkbenchContribution,
  type AgentGuiWorkbenchConversationIdentity
} from "@tutti-os/agent-gui/workbench/contribution";
import { resolveAgentGuiWorkbenchHeaderTitle } from "@tutti-os/agent-gui/workbench/sessionTitle";
import { selectWorkspaceAgentConsumerSession } from "@tutti-os/agent-activity-core";
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
import type { IReporterService } from "@renderer/features/analytics";
import { createDesktopAgentGUIWorkbenchHostInput } from "@renderer/features/workspace-agent/services/createDesktopAgentGUIWorkbenchHostInput.ts";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
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
  hostFilesApi: DesktopHostFilesApi;
  hostWindowApi: Pick<DesktopHostWindowApi, "openAgentWindow">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  onCapabilitySettingsRequest?: DesktopAgentGUIWorkbenchBodyProps["onCapabilitySettingsRequest"];
  agentsService: Pick<IAgentsService, "getSnapshot" | "subscribe">;
  allAgentsPresentation?: AgentGUIAllAgentsPresentation | null;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
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
  const initialAgentDirectory = input.agentsService.getSnapshot();
  const defaultAgentProvider = isWorkspaceAgentGuiProviderEnabledForNewEntry(
    input.defaultAgentProvider,
    initialAgentDirectory.agents
  )
    ? input.defaultAgentProvider
    : null;
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
  const trackWorkspaceAgentGUIEngagement =
    agentGUIWorkbenchHostInput.createAgentGUIEngagementEventSink("workspace");
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
  ) => {
    const previewMode = options?.previewMode === true;
    return createElement(DesktopWorkspaceAgentGUIWorkbenchBody, {
      agentActivityRuntime: agentGUIWorkbenchHostInput.agentActivityRuntime,
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
      previewMode,
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
      nodeTitle: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.agent),
      openDetachedWindow: input.appI18n.t(
        "workspace.agentGui.openDetachedWindow"
      )
    },
    dockIconUrls: input.dockIconUrls,
    unifiedDockIconUrl: input.unifiedDockIconUrl,
    frame: workspaceAgentGuiNodeFrame,
    defaultProvider: defaultAgentProvider,
    agentDirectory: input.agentsService,
    providerAvailability: resolveWorkspaceAgentGuiProviderAvailability(
      input.agentProviderStatusService
    ),
    renderBody: (context, helpers) =>
      renderAgentGuiWorkbenchBody(context, helpers),
    onOpenDetachedWindow: (request) => {
      // Transfer the complete lifecycle snapshot synchronously. The detached
      // window hydrates its canonical directory service before first paint and
      // then refreshes that same service; it does not create React-owned
      // loading or retry state.
      input.hostWindowApi.openAgentWindow({
        agentDirectorySnapshot: input.agentsService.getSnapshot(),
        agentSessionId: request.agentSessionId,
        agentTargetId: request.agentTargetId,
        providerStatusSnapshot: input.agentProviderStatusService.getSnapshot(),
        provider: request.provider,
        workspaceId: request.workspaceId
      });
    },
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
    resolveDockPopupIdentity: (state) =>
      resolveWorkspaceAgentGuiDockPopupIdentity(state, {
        dockIconUrls: input.dockIconUrls,
        agents: input.agentsService.getSnapshot().agents,
        workspaceAgentActivityService: input.workspaceAgentActivityService,
        workspaceId: input.workspaceId
      }),
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

function isWorkspaceAgentGuiProviderEnabledForNewEntry(
  provider: string | null | undefined,
  agents: readonly AgentGUIAgent[] | null | undefined
): provider is AgentGuiWorkbenchProvider {
  if (!isAgentGuiWorkbenchProvider(provider)) {
    return false;
  }
  if (
    resolveAgentGUIProviderCatalogIdentity(provider)?.desktop.visibilityGate !==
    "tutti_agent"
  ) {
    return true;
  }
  return (agents ?? []).some(
    (agent) =>
      agent.provider === provider && agent.availability.status === "ready"
  );
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
  const session = selectWorkspaceAgentConsumerSession(
    input.workspaceAgentActivityService
      .getSessionEngine(input.workspaceId)
      .getSnapshot(),
    agentSessionId
  )?.session;
  return session?.title?.trim() || null;
}

function resolveWorkspaceAgentGuiDockPopupIdentity(
  state: AgentGuiWorkbenchState | null,
  input: {
    dockIconUrls?: Parameters<
      typeof createAgentGuiWorkbenchContribution
    >[0]["dockIconUrls"];
    agents?: readonly AgentGUIAgent[];
    workspaceAgentActivityService: IWorkspaceAgentActivityService;
    workspaceId: string;
  }
): AgentGuiWorkbenchConversationIdentity | null {
  const agentSessionId = state?.lastActiveAgentSessionId?.trim() ?? "";
  if (!agentSessionId) {
    return null;
  }
  const session = selectWorkspaceAgentConsumerSession(
    input.workspaceAgentActivityService
      .getSessionEngine(input.workspaceId)
      .getSnapshot(),
    agentSessionId
  )?.session;
  // Prefer the target the workbench state already committed to when the session
  // was created. The activity snapshot lags a few frames behind session
  // creation, so relying on it alone briefly reports an unknown provider and
  // flashes the wrong (codex) icon; the committed agentTargetId is correct
  // immediately.
  const agentTargetId = session?.agentTargetId ?? state?.agentTargetId ?? null;
  const agent = agentTargetId
    ? (input.agents?.find((target) => target.agentTargetId === agentTargetId) ??
      null)
    : null;
  const resolvedProvider = isAgentGuiWorkbenchProvider(session?.provider)
    ? session.provider
    : isAgentGuiWorkbenchProvider(agent?.provider)
      ? agent.provider
      : null;
  const title = session?.title?.trim() || null;
  const agentTitle = resolveAgentGuiWorkbenchHeaderTitle({
    agentName: agent?.name,
    conversationTitle: title,
    provider: resolvedProvider
  });
  // Never fall back to a concrete provider's icon (e.g. codex) while the real
  // provider is still unknown — leave iconUrl null so the header renders a
  // neutral placeholder until the provider resolves.
  const iconUrl =
    agent?.iconUrl ??
    (resolvedProvider
      ? (resolveAgentGuiSessionProviderIconUrl(resolvedProvider) ??
        input.dockIconUrls?.[resolvedProvider] ??
        null)
      : null);
  return {
    agentTitle,
    iconUrl,
    title
  };
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
