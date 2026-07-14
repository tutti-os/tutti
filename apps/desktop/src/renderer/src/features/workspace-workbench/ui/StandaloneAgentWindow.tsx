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
import {
  AGENT_GUI_DETAIL_MIN_WIDTH_PX,
  AGENT_GUI_EXPANDED_TARGET_WIDTH_PX,
  AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX,
  shouldAutoCollapseAgentGUIConversationRail
} from "@tutti-os/agent-gui";
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
  WorkbenchContribution,
  WorkbenchHostHandle,
  WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createDesktopAgentGUIWorkbenchHostInput } from "@renderer/features/workspace-agent/services/createDesktopAgentGUIWorkbenchHostInput.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { resolveDesktopAgentGUIProviderForAgentTarget } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchStateHelpers.ts";
import type { DesktopAgentGUIPrefillPromptRequest } from "@renderer/features/workspace-agent/services/desktopAgentGUIPrefillPromptActivation.ts";
import { isDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import {
  desktopAgentGUIOpenSessionActivationType,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type {
  DesktopApi,
  DesktopHostWindowApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { TuttiExternalFileOpenInput } from "@tutti-os/workspace-external-core/contracts";
import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { DesktopAgentGUIWorkbenchBody } from "@renderer/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx";
import { useTranslation } from "@renderer/i18n";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { StandaloneAgentToolSidebar } from "./StandaloneAgentToolSidebar";
import type { StandaloneAgentFileOpenRequest } from "./StandaloneAgentToolSidebar";
import { WorkspaceAppExternalBridge } from "./WorkspaceAppExternalBridge";
import {
  createStandaloneAgentDockPreviewCache,
  createStandaloneAgentHost,
  readStandaloneAgentWindowFrame,
  readStandaloneAgentWindowMaximizedState
} from "./standaloneAgentWindowHost.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import type { WorkspaceWorkbenchCapabilitySettingsTarget } from "../services/workspaceWorkbenchHostService.interface";
import { resolveDesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
import { useStandaloneAgentLaunchRouting } from "./useStandaloneAgentLaunchRouting.ts";

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
function renderStandaloneAgentSidebarFooter(): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyWorkspaceAccountMenu />
    </Suspense>
  );
}

function StandaloneAgentWindowContentReady({
  children,
  onReady
}: {
  children: ReactNode;
  onReady: () => void;
}): ReactNode {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return children;
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
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
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
  workspaceAppExternalApi,
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
  const windowIntent = useMemo(
    () => resolveDesktopWindowIntent(window.location.search),
    []
  );
  const launchProvider = normalizeDesktopAgentGUIProvider(
    windowIntent.kind === "agent" ? windowIntent.provider : null
  );
  const launchDraftPrompt =
    windowIntent.kind === "agent" ? (windowIntent.draftPrompt ?? null) : null;
  const launchAutoSubmit =
    windowIntent.kind === "agent" && windowIntent.autoSubmit === true;
  const launchUserProjectPath =
    windowIntent.kind === "agent"
      ? (windowIntent.userProjectPath ?? null)
      : null;
  const launchAgentSessionId =
    windowIntent.kind === "agent"
      ? (windowIntent.agentSessionID ?? null)
      : null;
  const launchAgentTargetId =
    windowIntent.kind === "agent" ? (windowIntent.agentTargetID ?? null) : null;
  const prefillPromptBootstrapRequest =
    useMemo<DesktopAgentGUIPrefillPromptRequest | null>(
      () =>
        launchDraftPrompt
          ? {
              agentTargetId: launchAgentTargetId,
              autoSubmit: launchAutoSubmit,
              draftPrompt: launchDraftPrompt,
              provider: launchProvider,
              sequence: 1,
              ...(launchUserProjectPath
                ? { userProjectPath: launchUserProjectPath }
                : {})
            }
          : null,
      [
        launchAgentTargetId,
        launchAutoSubmit,
        launchDraftPrompt,
        launchProvider,
        launchUserProjectPath
      ]
    );
  const bootstrapAgentDirectory =
    windowIntent.kind === "agent"
      ? (windowIntent.agentDirectorySnapshot ?? null)
      : null;
  const providerStatusBootstrapSnapshot =
    windowIntent.kind === "agent"
      ? (windowIntent.providerStatusSnapshot ?? null)
      : null;
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
  const hasHydratedAgentDirectoryRef = useRef(false);
  if (!hasHydratedAgentDirectoryRef.current) {
    hasHydratedAgentDirectoryRef.current = true;
    if (bootstrapAgentDirectory) {
      agentsService.hydrate(bootstrapAgentDirectory);
    }
  }
  const subscribeAgentDirectory = useCallback(
    (listener: () => void) => agentsService.subscribe(listener),
    [agentsService]
  );
  const getAgentDirectorySnapshot = useCallback(
    () => agentsService.getSnapshot(),
    [agentsService]
  );
  const agentDirectorySnapshot = useSyncExternalStore(
    subscribeAgentDirectory,
    getAgentDirectorySnapshot,
    getAgentDirectorySnapshot
  );
  const agents = agentDirectorySnapshot.agents;
  const [frame, setFrame] = useState(readStandaloneAgentWindowFrame);
  const [isWindowMaximized, setIsWindowMaximized] = useState(
    readStandaloneAgentWindowMaximizedState
  );
  const [nodeState, setNodeState] = useState<DesktopAgentGUIWorkbenchState>(
    () => ({
      agentTargetId: launchAgentTargetId,
      lastActiveAgentSessionId: launchAgentSessionId,
      provider: launchProvider
    })
  );
  const [isContentLoading, setIsContentLoading] = useState(true);
  const handleContentReady = useCallback(() => {
    setIsContentLoading(false);
  }, []);
  const activitySnapshot = useSyncExternalStore(
    (listener) =>
      workspaceAgentActivityService.subscribe(workspaceId, listener),
    () => workspaceAgentActivityService.getSnapshot(workspaceId),
    () => workspaceAgentActivityService.getSnapshot(workspaceId)
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
  const openWorkspaceAppExternalFile = useCallback(
    async (input: TuttiExternalFileOpenInput) => {
      if (!openFileInSidebar(input.path)) {
        throw new Error("Workspace files could not be opened.");
      }
    },
    [openFileInSidebar]
  );
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
    () => createStandaloneAgentDockPreviewCache(desktopApi.dockPreviewCache),
    [desktopApi.dockPreviewCache]
  );
  const instanceId = useMemo(
    () => `agent-gui:${launchProvider}:standalone:${workspaceId}`,
    [launchProvider, workspaceId]
  );
  const activeAgentTargetId = nodeState.agentTargetId?.trim() || null;
  const headerProvider = resolveDesktopAgentGUIProviderForAgentTarget(
    activeAgentTargetId,
    agents,
    readStandaloneNodeProvider(nodeState, launchProvider)
  );
  const headerAgentTarget = activeAgentTargetId
    ? (agents.find((target) => target.agentTargetId === activeAgentTargetId) ??
      null)
    : null;
  const headerConversationIconFallbackUrl =
    resolveAgentGuiSessionProviderIconUrl(headerProvider);
  const headerConversationIconUrl =
    headerAgentTarget?.iconUrl ?? headerConversationIconFallbackUrl;
  const headerConversationTitle =
    activitySnapshot.sessions
      .find(
        (session) =>
          session.agentSessionId === nodeState.lastActiveAgentSessionId
      )
      ?.title?.trim() || null;
  const headerConversationRailWidthPx =
    typeof nodeState.conversationRailWidthPx === "number" &&
    Number.isFinite(nodeState.conversationRailWidthPx)
      ? nodeState.conversationRailWidthPx
      : standaloneAgentDefaultConversationRailWidthPx;
  const isConversationRailAutoCollapsed =
    shouldAutoCollapseAgentGUIConversationRail(
      frame.width,
      AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
    );
  const isConversationRailCollapsed =
    nodeState.conversationRailCollapsed === true ||
    isConversationRailAutoCollapsed;
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
      setFrame(readStandaloneAgentWindowFrame());
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
    void agentsService.refresh().catch(() => undefined);
  }, [agentsService]);
  const handleConversationRailToggle = useCallback(
    (collapsed: boolean) => {
      if (!collapsed && frame.width < 640) {
        void hostWindowApi.resizeContentWidth({
          width: AGENT_GUI_EXPANDED_TARGET_WIDTH_PX
        });
      }
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
    [frame.width, hostWindowApi, instanceId]
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
  const {
    handleLinkAction,
    handleOpenMessageCenterChat,
    issueManagerOpenRequest
  } = useStandaloneAgentLaunchRouting({
    agentDirectorySnapshot,
    agentProviderStatusService,
    headerProvider,
    homeDirectory: desktopApi.platform.homeDirectory,
    hostWindowApi,
    openFileInSidebar,
    setActivation,
    setNodeState,
    workspaceAppCenterService,
    workspaceId
  });
  const resizeStandaloneAgentWindowContentWidth = useCallback(
    (width: number) => hostWindowApi.resizeContentWidth({ width }),
    [hostWindowApi]
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
      agentDirectorySnapshot,
      agentSessionId: nodeState.lastActiveAgentSessionId,
      agentTargetId: activeAgentTargetId,
      providerStatusSnapshot: agentProviderStatusService.getSnapshot(),
      minimizeSourceWindow: false,
      provider: headerProvider,
      workspaceId
    });
  }, [
    activeAgentTargetId,
    agentDirectorySnapshot,
    agentProviderStatusService,
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
        issueManagerOpenRequest={issueManagerOpenRequest}
        mainContentMinWidthPx={
          isConversationRailCollapsed
            ? AGENT_GUI_DETAIL_MIN_WIDTH_PX
            : headerConversationRailWidthPx +
              agentGuiWorkbenchProviderRailWidthPx
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
            data-agent-gui-standalone-window-content-loading={
              isContentLoading ? "true" : "false"
            }
            displayMode={isWindowMaximized ? "fullscreen" : "floating"}
            data-agent-gui-standalone-window-header="true"
            data-workbench-drag-handle="true"
            isConversationRailAutoCollapsed={isConversationRailAutoCollapsed}
            isConversationRailCollapsed={isConversationRailCollapsed}
            nodeId={standaloneAgentNodeId}
            providerRailWidthPx={agentGuiWorkbenchProviderRailWidthPx}
            primaryAccessory={<AppUpdateStatus presentation="standalone" />}
            secondaryAccessory={isContentLoading ? null : toolActions}
            showConversationRailToggle={!isContentLoading}
            showAppTitle
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
        <StandaloneAgentWindowContentReady onReady={handleContentReady}>
          <DesktopAgentGUIWorkbenchBody
            agentActivityRuntime={agentGuiHostInput.agentActivityRuntime}
            agentHostApi={agentGuiHostInput.agentHostApi}
            appCenterService={workspaceAppCenterService}
            agentProviderStatusService={agentProviderStatusService}
            context={context}
            computerUseApi={desktopApi.computerUse}
            conversationRailAutoCollapseWidthPx={
              AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
            }
            dockPreviewCache={dockPreviewCache}
            onLinkAction={handleLinkAction}
            onCapabilitySettingsRequest={handleCapabilitySettingsRequest}
            onOpenAgentConversationWindow={({ agentSessionId, provider }) => {
              // Duplicate the complete live snapshot so the new window can
              // hydrate before its first local refresh.
              void hostWindowApi.openAgentWindow({
                agentSessionId,
                providerStatusSnapshot:
                  agentProviderStatusService.getSnapshot(),
                agentDirectorySnapshot,
                provider,
                workspaceId
              });
            }}
            onStateChange={setNodeState}
            prefillPromptBootstrapRequest={prefillPromptBootstrapRequest}
            providerStatusBootstrapSnapshot={providerStatusBootstrapSnapshot}
            agentDirectory={agentDirectorySnapshot}
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
        </StandaloneAgentWindowContentReady>
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
      <WorkspaceAppExternalBridge
        api={workspaceAppExternalApi}
        openFile={openWorkspaceAppExternalFile}
        workspaceId={workspaceId}
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
