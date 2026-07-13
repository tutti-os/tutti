import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { AgentGuiWorkbenchHeader } from "@tutti-os/agent-gui/workbench";
import { normalizeAgentGUIAgents } from "@tutti-os/agent-gui/agents";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
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
  WorkbenchContribution,
  WorkbenchDockPreviewCache,
  WorkbenchFrame,
  WorkbenchHostHandle,
  WorkbenchHostNodeBodyContext,
  WorkbenchSize
} from "@tutti-os/workbench-surface";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createDesktopAgentGUIWorkbenchHostInput } from "@renderer/features/workspace-agent/services/createDesktopAgentGUIWorkbenchHostInput.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService as AgentProviderStatusService
} from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { resolveDesktopAgentGUIProviderForAgentTarget } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchStateHelpers.ts";
import type { DesktopAgentGUIWorkbenchBodyProps } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchModel.ts";
import { isDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import {
  desktopAgentGUIOpenSessionActivationType,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager/services/workspaceFileManagerService.interface.ts";
import type { DesktopApi, DesktopHostWindowApi } from "@preload/types";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { useTranslation } from "@renderer/i18n";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { StandaloneAgentToolSidebar } from "./StandaloneAgentToolSidebar";
import type { StandaloneAgentFileOpenRequest } from "./StandaloneAgentToolSidebar";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";

import type { WorkspaceWorkbenchCapabilitySettingsTarget } from "../services/workspaceWorkbenchHostService.interface";

const LazyWorkspaceAccountMenu = lazy(() =>
  import("./WorkspaceAccountMenu").then(({ WorkspaceAccountMenu }) => ({
    default: WorkspaceAccountMenu
  }))
);
const LazyStandaloneAgentWindowPanelHosts = lazy(() =>
  import("./StandaloneAgentWindowPanelHosts.tsx").then(
    ({ StandaloneAgentWindowPanelHosts }) => ({
      default: StandaloneAgentWindowPanelHosts
    })
  )
);

const standaloneAgentNodeId = "standalone-agent-window-node";
const standaloneAgentInstanceKey = "standalone-agent-window";
const standaloneAgentDefaultConversationRailWidthPx = 280;
const desktopAgentGUIWorkbenchBodyModulePromise =
  import("@renderer/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx");
const LazyDesktopAgentGUIWorkbenchBody = lazy(() =>
  desktopAgentGUIWorkbenchBodyModulePromise.then((module) => ({
    default: module.DesktopAgentGUIWorkbenchBody
  }))
);

function renderStandaloneAgentSidebarFooter(): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyWorkspaceAccountMenu />
    </Suspense>
  );
}

export interface StandaloneAgentWindowProps {
  agentProviderStatusService: AgentProviderStatusService;
  desktopApi: DesktopApi;
  hostWindowApi: Pick<
    DesktopHostWindowApi,
    | "approveClose"
    | "minimize"
    | "openAgentWindow"
    | "resizeContentWidth"
    | "toggleMaximize"
  >;
  reporterService: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  tuttidClient: TuttidClient;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  toolWorkbench: {
    appI18n: I18nRuntime<string>;
    contributions: readonly WorkbenchContribution[] | undefined;
    onHostReady(host: WorkbenchHostHandle | null): void;
    requestWindowClose(): Promise<"approved" | "blocked">;
  };
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
  toolWorkbench,
  workspace,
  workspaceUserProjectService
}: StandaloneAgentWindowProps): ReactNode {
  const { i18n } = useTranslation();
  const agentsService = useService(IAgentsService);
  const workspaceFileManagerService = useService(IWorkspaceFileManagerService);
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workspaceId = workspace.id;
  const [panelHostsReady, setPanelHostsReady] = useState(false);
  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      setPanelHostsReady(true);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);
  const workspaceAppPollingDisposerRef = useRef<(() => void) | null>(null);
  const ensureWorkspaceAppPolling = useCallback(() => {
    if (workspaceAppPollingDisposerRef.current) {
      return;
    }
    workspaceAppPollingDisposerRef.current =
      workspaceAppCenterService.startWorkspacePolling(workspaceId);
  }, [workspaceAppCenterService, workspaceId]);
  useEffect(
    () => () => {
      workspaceAppPollingDisposerRef.current?.();
      workspaceAppPollingDisposerRef.current = null;
    },
    [workspaceAppCenterService, workspaceId]
  );
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const launchProvider = normalizeDesktopAgentGUIProvider(
    params.get("provider")
  );
  const launchAgentSessionId = params.get("agentSessionId")?.trim() || null;
  const launchAgentTargetId = params.get("agentTargetId")?.trim() || null;
  const bootstrapAgents = useMemo(() => readBootstrapAgents(params), [params]);
  const providerStatusBootstrapSnapshot = useMemo(
    () => readProviderStatusBootstrapSnapshot(params),
    [params]
  );
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
    launchAgentSessionId
      ? {
          payload: { agentSessionId: launchAgentSessionId },
          sequence: 1,
          type: desktopAgentGUIOpenSessionActivationType
        }
      : null
  );
  const [fileOpenRequest, setFileOpenRequest] =
    useState<StandaloneAgentFileOpenRequest | null>(null);
  const fileOpenRequestSequenceRef = useRef(0);
  const activationSequenceRef = useRef(1);
  const openFileInSidebar = useCallback((path: string): boolean => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return false;
    }
    setFileOpenRequest({
      path: normalizedPath,
      requestID: `standalone-agent-file-${++fileOpenRequestSequenceRef.current}`
    });
    return true;
  }, []);
  useEffect(() => {
    workspaceFileManagerService.setCanvasFilePreviewLauncher(
      workspaceId,
      (target) => openFileInSidebar(target.path)
    );
    workspaceFileManagerService.setPreviewUnsupportedFallbackNotificationEnabled(
      workspaceId,
      false
    );
    return () => {
      workspaceFileManagerService.setCanvasFilePreviewLauncher(
        workspaceId,
        null
      );
    };
  }, [openFileInSidebar, workspaceFileManagerService, workspaceId]);
  useEffect(() => {
    workspaceAppCenterService.setWorkspaceAppLauncher(
      async ({ appId, workspaceId: targetWorkspaceId }) => {
        if (targetWorkspaceId !== workspaceId) {
          return false;
        }
        ensureWorkspaceAppPolling();
        workspaceAppCenterService.setViewState({
          state: { openAppId: appId },
          workspaceId
        });
        return true;
      }
    );
    workspaceAppCenterService.setWorkspaceAppViewCloser(({ appId }) => {
      if (
        workspaceAppCenterService.getViewState(workspaceId).openAppId === appId
      ) {
        workspaceAppCenterService.setViewState({
          state: { openAppId: null },
          workspaceId
        });
      }
    });
    workspaceAppCenterService.setWorkspaceAppViewOpenChecker(
      ({ appId, workspaceId: targetWorkspaceId }) =>
        targetWorkspaceId === workspaceId &&
        workspaceAppCenterService.getViewState(workspaceId).openAppId === appId
    );
    return () => {
      workspaceAppCenterService.setWorkspaceAppLauncher(null);
      workspaceAppCenterService.setWorkspaceAppViewCloser(null);
      workspaceAppCenterService.setWorkspaceAppViewOpenChecker(null);
    };
  }, [ensureWorkspaceAppPolling, workspaceAppCenterService, workspaceId]);
  const subscribeAppCenter = useCallback(
    (listener: () => void) => workspaceAppCenterService.subscribe(listener),
    [workspaceAppCenterService]
  );
  const getOpenAppId = useCallback(
    () =>
      workspaceAppCenterService.getViewState(workspaceId).openAppId?.trim() ||
      null,
    [workspaceAppCenterService, workspaceId]
  );
  const openAppId = useSyncExternalStore(
    subscribeAppCenter,
    getOpenAppId,
    () => null
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
        workspaceFilePreviewMode: "canvas",
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
    () => `agent-gui:${launchProvider}:standalone:${workspaceId}`,
    [launchProvider, workspaceId]
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
  const headerConversationTitle = null;
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
        }
      }),
    []
  );
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
    // The main process pushes maximize/fullscreen transitions through the host
    // window layout event; keep the traffic-light icon in sync with it.
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
  const handleOpenMessageCenterChat = useCallback(
    (input: { agentSessionId: string; provider: string }) => {
      setNodeState((current) => ({
        ...current,
        lastActiveAgentSessionId: input.agentSessionId,
        provider: normalizeDesktopAgentGUIProvider(input.provider)
      }));
      setActivation({
        payload: { agentSessionId: input.agentSessionId },
        sequence: ++activationSequenceRef.current,
        type: desktopAgentGUIOpenSessionActivationType
      });
    },
    []
  );
  const resizeStandaloneAgentWindowContentWidth = useCallback(
    (width: number) => hostWindowApi.resizeContentWidth({ width }),
    [hostWindowApi]
  );
  const handleLinkAction = useCallback(
    (
      action: Parameters<
        NonNullable<DesktopAgentGUIWorkbenchBodyProps["onLinkAction"]>
      >[0]
    ) => {
      if (
        action.type !== "open-local-asset-preview" &&
        action.type !== "open-workspace-file"
      ) {
        return;
      }
      openFileInSidebar(action.path);
    },
    [openFileInSidebar]
  );
  const handleCapabilitySettingsRequest = useCallback(
    (target: WorkspaceWorkbenchCapabilitySettingsTarget) => {
      workspaceSettingsService.openPanel(
        { id: workspaceId },
        {
          anchor: target === "computerUse" ? "computer-use" : "browser-use",
          section: "general"
        }
      );
    },
    [workspaceId, workspaceSettingsService]
  );
  const handleDuplicateStandaloneWindow = useCallback(() => {
    void hostWindowApi.openAgentWindow({
      agentSessionId: nodeState.lastActiveAgentSessionId,
      agentTargetId: activeAgentTargetId,
      providerStatusSnapshot: agentProviderStatusService.getSnapshot(),
      agents: agents ?? undefined,
      minimizeSourceWindow: false,
      provider: headerProvider,
      workspaceId
    });
  }, [
    activeAgentTargetId,
    agentProviderStatusService,
    agents,
    headerProvider,
    hostWindowApi,
    nodeState.lastActiveAgentSessionId,
    workspaceId
  ]);

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
      <StandaloneAgentToolSidebar
        activityService={workspaceAgentActivityService}
        appOpenId={openAppId}
        appI18n={toolWorkbench.appI18n}
        browserApi={desktopApi.browser}
        contributions={toolWorkbench.contributions}
        fileOpenRequest={fileOpenRequest}
        mainContentMinWidthPx={
          headerConversationRailWidthPx + agentGuiWorkbenchProviderRailWidthPx
        }
        renderHeader={(toolActions) => (
          <AgentGuiWorkbenchHeader
            copy={{
              collapseConversationRail: i18n.t(
                "workspace.agentGui.collapseConversationRail"
              ),
              expandConversationRail: i18n.t(
                "workspace.agentGui.expandConversationRail"
              ),
              fallbackAgentLabel: i18n.t(
                "workspace.agentGui.fallbackAgentLabel"
              ),
              newConversation: i18n.t("workspace.agentGui.newConversation"),
              openDetachedWindow: i18n.t(
                "workspace.agentGui.openDetachedWindow"
              )
            }}
            conversationRailWidthPx={headerConversationRailWidthPx}
            conversationIconUrl={headerConversationIconUrl}
            conversationIconFallbackUrl={headerConversationIconFallbackUrl}
            conversationTitle={headerConversationTitle}
            displayMode={isWindowMaximized ? "fullscreen" : "floating"}
            data-agent-gui-standalone-window-header="true"
            data-workbench-drag-handle="true"
            isConversationRailAutoCollapsed={false}
            isConversationRailCollapsed={
              nodeState.conversationRailCollapsed === true
            }
            nodeId={standaloneAgentNodeId}
            providerRailWidthPx={agentGuiWorkbenchProviderRailWidthPx}
            primaryAccessory={<AppUpdateStatus presentation="standalone" />}
            secondaryAccessory={toolActions}
            showAppTitle={false}
            title={i18n.t("workspace.agentGui.fallbackAgentLabel")}
            windowActions={{
              close: () => {
                void toolWorkbench.requestWindowClose();
              },
              minimize: () => {
                void hostWindowApi.minimize();
              },
              toggleDisplayMode: () => {
                void hostWindowApi.toggleMaximize();
              }
            }}
            onCreateConversation={handleCreateConversation}
            onOpenDetachedWindow={handleDuplicateStandaloneWindow}
            onToggleConversationRail={handleConversationRailToggle}
          />
        )}
        onOpenMessageCenterChat={handleOpenMessageCenterChat}
        onAppsOpen={ensureWorkspaceAppPolling}
        onToolHostReady={toolWorkbench.onHostReady}
        resizeWindowContentWidth={resizeStandaloneAgentWindowContentWidth}
        workspaceId={workspaceId}
      >
        <Suspense fallback={<div className="h-full min-h-0 bg-background" />}>
          <LazyDesktopAgentGUIWorkbenchBody
            agentActivityRuntime={agentGuiHostInput.agentActivityRuntime}
            agentHostApi={agentGuiHostInput.agentHostApi}
            appCenterService={workspaceAppCenterService}
            agentProviderStatusService={agentProviderStatusService}
            context={context}
            computerUseApi={desktopApi.computerUse}
            dockPreviewCache={dockPreviewCache}
            onLinkAction={handleLinkAction}
            onCapabilitySettingsRequest={handleCapabilitySettingsRequest}
            onOpenAgentConversationWindow={({ agentSessionId, provider }) => {
              // Hand off whatever is cached right now — see the matching note
              // in workspaceAgentGuiContribution.ts's onOpenDetachedWindow for
              // why we don't block this click on a full provider probe.
              void hostWindowApi.openAgentWindow({
                agentSessionId,
                providerStatusSnapshot:
                  agentProviderStatusService.getSnapshot(),
                agents: agents ?? undefined,
                provider,
                workspaceId
              });
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
            renderSidebarFooter={renderStandaloneAgentSidebarFooter}
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
        </Suspense>
      </StandaloneAgentToolSidebar>
      {panelHostsReady ? (
        <Suspense fallback={null}>
          <LazyStandaloneAgentWindowPanelHosts
            agentProviderStatusService={agentProviderStatusService}
            host={host}
            workspace={workspace}
          />
        </Suspense>
      ) : null}
    </main>
  );
}

function readBootstrapAgents(
  params: URLSearchParams
): readonly AgentGUIAgent[] | null {
  const encodedAgents = params.get("agents");
  if (!encodedAgents) {
    return null;
  }
  try {
    const parsed = JSON.parse(encodedAgents);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return normalizeAgentGUIAgents(parsed as readonly AgentGUIAgent[]);
  } catch {
    return null;
  }
}

function readProviderStatusBootstrapSnapshot(
  params: URLSearchParams
): AgentProviderStatusSnapshot | null {
  const encodedSnapshot = params.get("agentProviderStatusSnapshot");
  if (!encodedSnapshot) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      encodedSnapshot
    ) as Partial<AgentProviderStatusSnapshot>;
    if (!parsed.capturedAt || typeof parsed.capturedAt !== "string") {
      return null;
    }
    return {
      capturedAt: parsed.capturedAt,
      defaultProvider: parsed.defaultProvider ?? null,
      error: parsed.error ?? null,
      isLoading: parsed.isLoading === true,
      pendingActions: Array.isArray(parsed.pendingActions)
        ? parsed.pendingActions
        : [],
      statuses: Array.isArray(parsed.statuses) ? parsed.statuses : []
    };
  } catch {
    return null;
  }
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
    launchNode: async () => null,
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
