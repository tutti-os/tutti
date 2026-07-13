import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AgentGuiWorkbenchHeader } from "@tutti-os/agent-gui/workbench";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import {
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  agentGuiWorkbenchProviderRailWidthPx,
  type AgentGuiWorkbenchConversationRailToggleDetail,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import { resolveAgentGuiSessionProviderIconUrl } from "@tutti-os/agent-gui/agentGuiSessionProviderIconUrls";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchFrame,
  WorkbenchHostHandle,
  WorkbenchHostNodeBodyContext,
  WorkbenchSize
} from "@tutti-os/workbench-surface";
import {
  createDesktopAgentGUIWorkbenchHostInput,
  DesktopAgentGUIWorkbenchBody,
  ensureAllDesktopManagedAgentProviderStatuses,
  IAgentsService,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type AgentProviderStatusService,
  type WorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";
import { resolveDesktopAgentGUIProviderForAgentTarget } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchStateHelpers.ts";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { isDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { DesktopAgentGUIWorkbenchState } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { DesktopApi, DesktopHostWindowApi } from "@preload/types";
import { resolveDesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import type { WorkspaceWorkbenchCapabilitySettingsTarget } from "../services/workspaceWorkbenchHostService.interface";
import { useStandaloneFusionLaunchCoordinators } from "../services/useStandaloneFusionLaunchCoordinators.ts";
import {
  createStandaloneAgentWindowLaunchPayload,
  resolveStandaloneAgentInitialActivation,
  resolveStandaloneAgentWindowBootstrap
} from "../services/standaloneAgentWindowIntent.ts";
import { resolveWorkspaceAgentProviderLaunchIntent } from "../services/workspaceOpenFeatureRequest.ts";
import { StandaloneAgentWindowPanelHosts } from "./StandaloneAgentWindowPanelHosts.tsx";

const standaloneAgentNodeId = "standalone-agent-window-node";
const standaloneAgentInstanceKey = "standalone-agent-window";
const standaloneAgentDefaultConversationRailWidthPx = 280;

export interface StandaloneAgentWindowProps {
  agentProviderStatusService: AgentProviderStatusService;
  desktopApi: DesktopApi;
  hostWindowApi: Pick<
    DesktopHostWindowApi,
    "approveClose" | "minimize" | "openAgentWindow" | "toggleMaximize"
  >;
  reporterService: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  tuttidClient: TuttidClient;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  workspace: WorkspaceSummary;
  workspaceUserProjectService: IWorkspaceUserProjectService;
}

export function StandaloneAgentWindow({
  agentProviderStatusService,
  desktopApi,
  hostWindowApi,
  reporterService,
  richTextAtService,
  tuttidClient,
  workspaceAgentActivityService,
  workspaceAppCenterService,
  workspace,
  workspaceUserProjectService
}: StandaloneAgentWindowProps): ReactNode {
  const { i18n } = useTranslation();
  const agentsService = useService(IAgentsService);
  const workspaceFileManagerService = useService(IWorkspaceFileManagerService);
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const workspaceId = workspace.id;
  const launchBootstrap = useMemo(
    () =>
      resolveStandaloneAgentWindowBootstrap(
        resolveDesktopWindowIntent(window.location.search)
      ),
    []
  );
  const launchProvider = normalizeDesktopAgentGUIProvider(
    launchBootstrap.provider
  );
  const launchAgentSessionId = launchBootstrap.agentSessionId;
  const launchAgentTargetId = launchBootstrap.agentTargetId;
  const launchDraftPrompt = launchBootstrap.draftPrompt;
  const launchAutoSubmit = launchBootstrap.autoSubmit;
  const launchUserProjectPath = launchBootstrap.userProjectPath;
  const launchAgentFeature = launchBootstrap.agentFeature;
  const fusionWindowId = launchBootstrap.fusionWindowId;
  const usesNativeWindowChrome = fusionWindowId !== null;
  const fusionLaunch = useStandaloneFusionLaunchCoordinators({
    appCenterService: workspaceAppCenterService,
    desktopApi,
    enabled: fusionWindowId !== null,
    workbenchHostService,
    workspaceId
  });
  const bootstrapAgents = launchBootstrap.agents;
  const providerStatusBootstrapSnapshot =
    launchBootstrap.providerStatusSnapshot;
  // Seed the live service from the opening window's snapshot synchronously,
  // during the first render, before any child effect gets a chance to kick
  // off its own fresh status request. Without this, `agentProviderStatusService`
  // starts as a brand-new instance with no data (it's a separate process from
  // the window that opened us), and as soon as its own request returns even a
  // partial result, the bootstrap snapshot gets abandoned mid-render — which
  // is what caused providers that were already known-ready to flash back to
  // "checking"/"unavailable". `hydrate` is a no-op once real data has landed,
  // so this can never regress fresher local state.
  const hasHydratedProviderStatusRef = useRef(false);
  if (!hasHydratedProviderStatusRef.current) {
    hasHydratedProviderStatusRef.current = true;
    if (providerStatusBootstrapSnapshot) {
      agentProviderStatusService.hydrate(providerStatusBootstrapSnapshot);
    }
  }
  const [frame, setFrame] = useState(() => readWindowFrameRect());
  const [isWindowMaximized, setIsWindowMaximized] = useState(
    readWindowMaximizedState
  );
  const [agents, setAgents] = useState<
    Awaited<ReturnType<typeof agentsService.load>>["agents"] | null
  >(() => bootstrapAgents);
  const [nodeState, setNodeState] = useState<DesktopAgentGUIWorkbenchState>(
    () => ({
      agentTargetId: launchAgentTargetId,
      lastActiveAgentSessionId: launchAgentSessionId,
      provider: launchProvider
    })
  );
  const [activation, setActivation] = useState<
    WorkbenchHostNodeBodyContext["activation"]
  >(() =>
    resolveStandaloneAgentInitialActivation({
      agentSessionId: launchAgentSessionId,
      agentTargetId: launchAgentTargetId,
      autoSubmit: launchAutoSubmit,
      draftPrompt: launchDraftPrompt,
      provider: launchProvider,
      userProjectPath: launchUserProjectPath
    })
  );
  const agentGuiHostInput = useMemo(
    () =>
      createDesktopAgentGUIWorkbenchHostInput({
        hostFilesApi: desktopApi.host.files,
        tuttidClient,
        platformApi: desktopApi.platform,
        reporterService,
        richTextAtService,
        runtimeApi: desktopApi.runtime,
        workspaceAgentActivityService,
        workspaceFileManagerService,
        workspaceUserProjectService,
        workspaceId
      }),
    [
      desktopApi.host.files,
      desktopApi.platform,
      desktopApi.runtime,
      reporterService,
      richTextAtService,
      tuttidClient,
      workspaceAgentActivityService,
      workspaceFileManagerService,
      workspaceId,
      workspaceUserProjectService
    ]
  );
  const dockPreviewCache = useMemo(
    () => createDockPreviewCache(desktopApi.dockPreviewCache),
    [desktopApi.dockPreviewCache]
  );
  const instanceId = useMemo(
    () =>
      fusionWindowId ?? `agent-gui:${launchProvider}:standalone:${workspaceId}`,
    [fusionWindowId, launchProvider, workspaceId]
  );
  const activeAgentTargetId = nodeState.agentTargetId?.trim() || null;
  const headerProvider = resolveDesktopAgentGUIProviderForAgentTarget(
    activeAgentTargetId,
    agents ?? undefined,
    readStandaloneNodeProvider(nodeState, launchProvider)
  );
  const headerAgentTarget =
    activeAgentTargetId && agents
      ? (agents.find(
          (target) => target.agentTargetId === activeAgentTargetId
        ) ?? null)
      : null;
  const headerConversationIconFallbackUrl =
    resolveAgentGuiSessionProviderIconUrl(headerProvider);
  const headerConversationIconUrl =
    headerAgentTarget?.iconUrl ?? headerConversationIconFallbackUrl;
  const headerConversationTitle =
    nodeState.lastActiveConversationTitle?.trim() || null;
  const fusionWindowTitle =
    headerConversationTitle ??
    headerAgentTarget?.name ??
    i18n.t("workspace.agentGui.fallbackAgentLabel");
  const headerConversationRailWidthPx =
    typeof nodeState.conversationRailWidthPx === "number" &&
    Number.isFinite(nodeState.conversationRailWidthPx)
      ? nodeState.conversationRailWidthPx
      : standaloneAgentDefaultConversationRailWidthPx;
  const host = useMemo(
    () =>
      createStandaloneAgentHost({
        clearActivation: (nodeId, sequence) => {
          if (nodeId === standaloneAgentNodeId) {
            setActivation((current) =>
              current?.sequence === sequence ? null : current
            );
          }
        },
        launchNode: async (input) => {
          if (!fusionWindowId) {
            return null;
          }
          const descriptor = await fusionLaunch.openWorkbenchNode(input);
          return descriptor?.windowInstanceId ?? null;
        }
      }),
    [fusionLaunch, fusionWindowId]
  );
  const handledConnectFeatureRef = useRef(false);

  useEffect(() => {
    if (launchAgentFeature !== "connect" || handledConnectFeatureRef.current) {
      return;
    }
    handledConnectFeatureRef.current = true;
    void (async () => {
      await agentProviderStatusService
        .ensureLoaded({ providers: [launchProvider] })
        .catch(() => null);
      const intent = resolveWorkspaceAgentProviderLaunchIntent(
        agentProviderStatusService.getStatus(launchProvider)
      );
      if (intent.kind === "action") {
        await agentProviderStatusService.runAction(
          launchProvider,
          intent.actionId,
          { workbenchHost: host, workspaceId }
        );
      }
    })().catch(() => undefined);
  }, [
    agentProviderStatusService,
    host,
    launchAgentFeature,
    launchProvider,
    workspaceId
  ]);

  useEffect(() => {
    if (!fusionWindowId) {
      return;
    }
    void desktopApi.fusion
      .updateWindow({
        resourceId: nodeState.lastActiveAgentSessionId?.trim() || null,
        title: fusionWindowTitle,
        windowInstanceId: fusionWindowId
      })
      .catch(() => undefined);
  }, [
    desktopApi.fusion,
    fusionWindowId,
    fusionWindowTitle,
    nodeState.lastActiveAgentSessionId
  ]);
  const context = useMemo<
    WorkbenchHostNodeBodyContext<DesktopAgentGUIWorkbenchState, null>
  >(
    () => ({
      activation,
      displayMode: "floating",
      externalNodeState: nodeState,
      externalWorkspaceState: null,
      focus: () => undefined,
      host,
      instanceId,
      instanceKey: standaloneAgentInstanceKey,
      isFocused: document.hasFocus(),
      node: {
        data: {
          activation,
          instanceId,
          instanceKey: standaloneAgentInstanceKey,
          runtimeNodeState: nodeState,
          snapshotNodeState: null,
          typeId: "agent-gui"
        },
        displayMode: "floating",
        frame,
        id: standaloneAgentNodeId,
        isMinimized: false,
        kind: "window",
        restoreFrame: null,
        title: i18n.t("workspace.agentGui.fallbackAgentLabel")
      },
      setNodeRuntimeState: (state) => {
        setNodeState((state ?? {}) as DesktopAgentGUIWorkbenchState);
      },
      setSnapshotNodeState: (state) => {
        setNodeState((state ?? {}) as DesktopAgentGUIWorkbenchState);
      }
    }),
    [activation, frame, host, i18n, instanceId, nodeState]
  );

  useEffect(() => {
    const handleResize = () => {
      setFrame(readWindowFrameRect());
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    const handleLayout = (event: Event) => {
      const detail = (event as CustomEvent<{ maximized?: boolean }>).detail;
      setIsWindowMaximized(detail?.maximized === true);
    };
    window.addEventListener("tutti-host-window-layout", handleLayout);
    return () => {
      window.removeEventListener("tutti-host-window-layout", handleLayout);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadAgents = () => {
      void agentsService
        .load()
        .then((snapshot) => {
          if (!disposed) {
            setAgents(snapshot.agents);
          }
        })
        .catch(() => undefined);
    };
    loadAgents();
    window.addEventListener("focus", loadAgents);
    return () => {
      disposed = true;
      window.removeEventListener("focus", loadAgents);
    };
  }, [agentsService]);
  useEffect(() => {
    // The main workspace window loads every managed provider's status via its
    // dock rail (which subscribes on mount and probes all providers). This
    // standalone window has no dock, so nothing else ever asks for the full
    // set — without this, only the single provider the window was launched
    // for gets checked, and every other provider (e.g. switching the "全部"
    // filter to one that was never probed) stays stuck on "checking".
    void ensureAllDesktopManagedAgentProviderStatuses(
      agentProviderStatusService
    );
  }, [agentProviderStatusService]);
  const handleConversationRailToggle = useCallback(
    (collapsed: boolean) => {
      setNodeState((current) => ({
        ...current,
        conversationRailCollapsed: collapsed
      }));
      window.dispatchEvent(
        new CustomEvent<AgentGuiWorkbenchConversationRailToggleDetail>(
          AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
          {
            detail: {
              conversationRailCollapsed: collapsed,
              instanceId
            }
          }
        )
      );
    },
    [instanceId]
  );
  const handleCreateConversation = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<AgentGuiWorkbenchNewConversationDetail>(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        {
          detail: { instanceId }
        }
      )
    );
  }, [instanceId]);
  const handleCapabilitySettingsRequest = useCallback(
    (target: WorkspaceWorkbenchCapabilitySettingsTarget) => {
      const anchor = target === "computerUse" ? "computer-use" : "browser-use";
      if (fusionWindowId) {
        void fusionLaunch.openSettings({ anchor, section: "general" });
        return;
      }
      workspaceSettingsService.openPanel(
        { id: workspaceId },
        {
          anchor,
          section: "general"
        }
      );
    },
    [fusionLaunch, fusionWindowId, workspaceId, workspaceSettingsService]
  );
  const handleLinkAction = useCallback(
    (action: Parameters<typeof runDesktopAgentGUILinkAction>[0]) => {
      if (!fusionWindowId) {
        return;
      }
      void runDesktopAgentGUILinkAction(action, {
        homeDirectory: desktopApi.platform.homeDirectory,
        launchAgentGui: fusionLaunch.openAgent,
        launchGroupChat: fusionLaunch.openGroupChat,
        launchWorkspaceApp: fusionLaunch.openWorkspaceApp,
        launchWorkspaceFiles: fusionLaunch.openFiles,
        launchWorkspaceIssueManager: fusionLaunch.openIssueManager,
        openBrowserUrl: fusionLaunch.openBrowser,
        workspaceId
      });
    },
    [
      desktopApi.platform.homeDirectory,
      fusionLaunch,
      fusionWindowId,
      workspaceId
    ]
  );

  return (
    <main
      className="workbench-window h-screen min-h-0 overflow-hidden bg-background"
      data-agent-gui-standalone-window="true"
      data-display-mode="floating"
      data-focused="true"
      style={{
        border: 0,
        borderRadius: 0,
        boxShadow: "none",
        height: "100vh",
        maxHeight: "100vh",
        maxWidth: "100vw",
        overflow: "hidden",
        width: "100vw"
      }}
    >
      <div className="workbench-window__header workbench-window__header--custom">
        <AgentGuiWorkbenchHeader
          copy={{
            collapseConversationRail: i18n.t(
              "workspace.agentGui.collapseConversationRail"
            ),
            expandConversationRail: i18n.t(
              "workspace.agentGui.expandConversationRail"
            ),
            fallbackAgentLabel: i18n.t("workspace.agentGui.fallbackAgentLabel"),
            newConversation: i18n.t("workspace.agentGui.newConversation")
          }}
          conversationRailWidthPx={headerConversationRailWidthPx}
          conversationIconUrl={headerConversationIconUrl}
          conversationIconFallbackUrl={headerConversationIconFallbackUrl}
          conversationTitle={headerConversationTitle}
          displayMode={isWindowMaximized ? "fullscreen" : "floating"}
          {...(usesNativeWindowChrome
            ? { "data-agent-gui-native-window-content-header": "true" }
            : {
                "data-agent-gui-standalone-window-header": "true",
                "data-workbench-drag-handle": "true" as const
              })}
          isConversationRailAutoCollapsed={false}
          isConversationRailCollapsed={
            nodeState.conversationRailCollapsed === true
          }
          nodeId={standaloneAgentNodeId}
          providerRailWidthPx={agentGuiWorkbenchProviderRailWidthPx}
          showWindowControls={!usesNativeWindowChrome}
          style={usesNativeWindowChrome ? { cursor: "default" } : undefined}
          title={i18n.t("workspace.agentGui.fallbackAgentLabel")}
          windowActions={{
            close: () => {
              void hostWindowApi.approveClose();
            },
            minimize: () => {
              void hostWindowApi.minimize();
            },
            toggleDisplayMode: () => {
              void hostWindowApi.toggleMaximize();
            }
          }}
          onCreateConversation={handleCreateConversation}
          onToggleConversationRail={handleConversationRailToggle}
        />
      </div>
      <div className="workbench-window__body h-full min-h-0 min-w-0 overflow-hidden">
        <DesktopAgentGUIWorkbenchBody
          agentActivityRuntime={agentGuiHostInput.agentActivityRuntime}
          agentQueuedPromptRuntime={agentGuiHostInput.agentQueuedPromptRuntime}
          agentHostApi={agentGuiHostInput.agentHostApi}
          appCenterService={workspaceAppCenterService}
          agentProviderStatusService={agentProviderStatusService}
          context={context}
          computerUseApi={desktopApi.computerUse}
          dockPreviewCache={dockPreviewCache}
          onLinkAction={fusionWindowId ? handleLinkAction : undefined}
          onCapabilitySettingsRequest={handleCapabilitySettingsRequest}
          onOpenAgentConversationWindow={({ agentSessionId, provider }) => {
            // Hand off whatever is cached right now — see the matching note
            // in workspaceAgentGuiContribution.ts's onOpenDetachedWindow for
            // why we don't block this click on a full provider probe.
            if (fusionWindowId) {
              void fusionLaunch.openPayloadWindow({
                kind: "agent",
                payload: createStandaloneAgentWindowLaunchPayload({
                  agentSessionId,
                  agents: agents ?? undefined,
                  provider,
                  providerStatusSnapshot:
                    agentProviderStatusService.getSnapshot()
                }),
                resourceId: agentSessionId
              });
            } else {
              void hostWindowApi.openAgentWindow({
                launchPayload: createStandaloneAgentWindowLaunchPayload({
                  agentSessionId,
                  agents: agents ?? undefined,
                  provider,
                  providerStatusSnapshot:
                    agentProviderStatusService.getSnapshot()
                }),
                resourceId: agentSessionId,
                workspaceId
              });
            }
          }}
          onStateChange={setNodeState}
          providerStatusBootstrapSnapshot={providerStatusBootstrapSnapshot}
          agents={agents ?? []}
          agentsLoading={agents === null}
          contextMentionProviders={agentGuiHostInput.contextMentionProviders}
          runtimeApi={desktopApi.runtime}
          trackAgentProviderChatReady={
            agentGuiHostInput.trackAgentProviderChatReady
          }
          trackWorkspaceFileReferences={
            agentGuiHostInput.trackWorkspaceFileReferences
          }
          workspaceFileReferenceAdapter={
            agentGuiHostInput.workspaceFileReferenceAdapter
          }
          resolveDroppedFileReferences={
            agentGuiHostInput.resolveDroppedFileReferences
          }
          onRequestGitBranches={agentGuiHostInput.onRequestGitBranches}
          referenceSourceAggregator={
            agentGuiHostInput.referenceSourceAggregator
          }
          resolveWorkspaceReferenceEntryIconUrl={
            agentGuiHostInput.resolveWorkspaceReferenceEntryIconUrl
          }
          resolveMentionReferenceTarget={
            agentGuiHostInput.resolveMentionReferenceTarget
          }
          resolveWorkspaceReferenceInitialTarget={
            agentGuiHostInput.resolveWorkspaceReferenceInitialTarget
          }
          workspaceId={workspaceId}
        />
      </div>
      <StandaloneAgentWindowPanelHosts
        agentFeature={launchAgentFeature}
        agentProviderStatusService={agentProviderStatusService}
        desktopApi={desktopApi}
        focusedProvider={launchProvider}
        fusionWindowId={fusionWindowId}
        host={host}
        workspace={workspace}
        onLaunchNode={async (input) => {
          const descriptor = await fusionLaunch.openWorkbenchNode(input);
          return descriptor?.windowInstanceId ?? null;
        }}
      />
    </main>
  );
}

function readStandaloneNodeProvider(
  state: DesktopAgentGUIWorkbenchState,
  fallbackProvider: DesktopAgentGUIProvider
): DesktopAgentGUIProvider {
  const provider = (state as { provider?: unknown }).provider;
  return isDesktopAgentGUIProvider(provider) ? provider : fallbackProvider;
}

function readWindowSize(): WorkbenchSize {
  return {
    height: Math.max(1, window.innerHeight),
    width: Math.max(1, window.innerWidth)
  };
}

function readWindowFrameRect(): WorkbenchFrame {
  return {
    ...readWindowSize(),
    x: 0,
    y: 0
  };
}

function readWindowMaximizedState(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.tuttiWindowMaximized === "true"
  );
}

function createDockPreviewCache(
  api: DesktopApi["dockPreviewCache"]
): WorkbenchDockPreviewCache {
  const pendingWriteKeys = new Set<string>();
  return {
    read(key) {
      return api.read({ key }).catch(() => null);
    },
    write({ key, previewImageUrl }) {
      const writeKey = JSON.stringify(key);
      if (pendingWriteKeys.has(writeKey)) {
        return;
      }
      pendingWriteKeys.add(writeKey);
      void api
        .write({ dataUrl: previewImageUrl, key })
        .catch(() => {})
        .finally(() => {
          pendingWriteKeys.delete(writeKey);
        });
    }
  };
}

function createStandaloneAgentHost(input: {
  clearActivation(nodeId: string, sequence: number): void;
  launchNode(
    input: Parameters<WorkbenchHostHandle["launchNode"]>[0]
  ): Promise<string | null>;
}): WorkbenchHostHandle {
  const snapshot = {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    lockedLayout: null,
    layoutConstraints: {
      minHeight: 0,
      minWidth: 0,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    nodes: [],
    nodeStack: [],
    surfaceSize: readWindowSize()
  };
  return {
    activateNode: () => undefined,
    clearNodeActivation: input.clearActivation,
    closeNode: () => undefined,
    collectWindowCloseEffects: async () => [],
    dispose: () => undefined,
    exitFullscreenNode: () => undefined,
    focusNode: () => undefined,
    getSnapshot: () => ({
      ...snapshot,
      surfaceSize: readWindowSize()
    }),
    launchNode: input.launchNode,
    load: async () => undefined,
    minimizeNode: () => undefined,
    reconcileProjectedNodes: () => undefined,
    requestNodeClose: () => undefined,
    setNodeRuntimeState: () => undefined,
    setNodeSizeConstraints: () => undefined,
    setNodeTitle: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
