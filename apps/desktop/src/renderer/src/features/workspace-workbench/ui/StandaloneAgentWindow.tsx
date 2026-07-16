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
import type { AgentGUIComposerAppendRequest } from "@tutti-os/agent-gui";
import {
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  agentGuiWorkbenchProviderRailWidthPx,
  type AgentGuiWorkbenchConversationRailToggleDetail,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import type { WorkbenchHostNodeBodyContext } from "@tutti-os/workbench-surface";
import { createDesktopAgentGUIWorkbenchHostInput } from "@renderer/features/workspace-agent/services/createDesktopAgentGUIWorkbenchHostInput.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import type { DesktopAgentGUIPrefillPromptRequest } from "@renderer/features/workspace-agent/services/desktopAgentGUIPrefillPromptActivation.ts";
import { isDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import {
  desktopAgentGUIOpenSessionActivationType,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import { IWorkspaceAppSurfaceHost } from "@renderer/features/workspace-app-center";
import { useService } from "@tutti-os/infra/di";
import {
  IWorkspaceFileManagerService,
  IWorkspaceFilePreviewSurfaceHost
} from "@renderer/features/workspace-file-manager";
import type { TuttiExternalFileOpenInput } from "@tutti-os/workspace-external-core/contracts";
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
import {
  StandaloneAgentWindowHeader,
  useStandaloneAgentWindowHeaderIdentity
} from "./StandaloneAgentWindowHeader.tsx";
import { StandaloneAgentWindowContentReady } from "./StandaloneAgentWindowContentReady.tsx";
import { showWorkspaceFileMissingToast } from "../services/workspaceFilesLaunchFeedback.ts";
import { Toast } from "@renderer/lib/toast";
import { createStandaloneAgentWorkspaceAppSurfacePresenter } from "../services/standaloneAgentWorkspaceAppSurfacePresenter.ts";
import { createStandaloneAgentWorkspaceFilePreviewPresenter } from "../services/standaloneAgentWorkspaceFilePreviewPresenter.ts";
import { resolveStandaloneAgentLaunchConfiguration } from "./standaloneAgentLaunchProvider.ts";
import type { StandaloneAgentWindowProps } from "./StandaloneAgentWindow.types.ts";

export type { StandaloneAgentWindowProps } from "./StandaloneAgentWindow.types.ts";

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

export function StandaloneAgentWindow({
  agentProviderStatusService,
  defaultAgentProvider,
  desktopApi,
  eventStreamClient,
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
  const workspaceAppSurfaceHost = useService(IWorkspaceAppSurfaceHost);
  const workspaceFilePreviewSurfaceHost = useService(
    IWorkspaceFilePreviewSurfaceHost
  );
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
  const launch = resolveStandaloneAgentLaunchConfiguration({
    defaultProvider: defaultAgentProvider,
    intent: windowIntent
  });
  const launchProvider = launch.provider;
  const launchDraftPrompt = launch.draftPrompt;
  const launchModel = launch.model;
  const launchModelPlanId = launch.modelPlanId;
  const launchAutoSubmit = launch.autoSubmit;
  const launchUserProjectPath = launch.userProjectPath;
  const launchAgentSessionId = launch.agentSessionId;
  const launchAgentTargetId = launch.agentTargetId;
  const prefillPromptBootstrapRequest =
    useMemo<DesktopAgentGUIPrefillPromptRequest | null>(
      () =>
        launchDraftPrompt
          ? {
              agentTargetId: launchAgentTargetId,
              autoSubmit: launchAutoSubmit,
              draftPrompt: launchDraftPrompt,
              ...(launchModel ? { model: launchModel } : {}),
              ...(launchModelPlanId ? { modelPlanId: launchModelPlanId } : {}),
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
        launchModel,
        launchModelPlanId,
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
  const [composerAppendRequest, setComposerAppendRequest] =
    useState<AgentGUIComposerAppendRequest | null>(null);
  const composerAppendSequenceRef = useRef(0);
  const appendBrowserElementMention = useCallback((mention: string): void => {
    setComposerAppendRequest({
      prompt: mention,
      sequence:
        Date.now() * 1_000 + (++composerAppendSequenceRef.current % 1_000)
    });
  }, []);
  const fileOpenRequestSequenceRef = useRef(0);
  const openFileInSidebar = useCallback(
    async (file: string, validateExists = false): Promise<boolean> => {
      const normalizedPath = file.trim();
      if (!normalizedPath) {
        return false;
      }
      if (
        validateExists &&
        !(await workspaceFileManagerService.entryExists({
          path: normalizedPath,
          workspaceID: workspaceId
        }))
      ) {
        showWorkspaceFileMissingToast();
        return false;
      }
      setFileOpenRequest({
        path: normalizedPath,
        requestID: `standalone-agent-file-${++fileOpenRequestSequenceRef.current}`
      });
      return true;
    },
    [workspaceFileManagerService, workspaceId]
  );
  const openWorkspaceAppExternalFile = useCallback(
    async (input: TuttiExternalFileOpenInput) => {
      if (!(await openFileInSidebar(input.path))) {
        throw new Error("Workspace files could not be opened.");
      }
    },
    [openFileInSidebar]
  );
  useEffect(() => {
    return workspaceFilePreviewSurfaceHost.registerPresenter(
      workspaceId,
      createStandaloneAgentWorkspaceFilePreviewPresenter({
        hostFilesApi: desktopApi.host.files,
        workspaceId
      })
    );
  }, [desktopApi.host.files, workspaceFilePreviewSurfaceHost, workspaceId]);
  useEffect(() => {
    return workspaceAppSurfaceHost.registerPresenter(
      createStandaloneAgentWorkspaceAppSurfacePresenter({
        ensureWorkspaceAppPolling,
        getViewState: (targetWorkspaceId) =>
          workspaceAppCenterService.getViewState(targetWorkspaceId),
        setViewState: (request) =>
          workspaceAppCenterService.setViewState(request),
        workspaceId
      })
    );
  }, [
    ensureWorkspaceAppPolling,
    workspaceAppCenterService,
    workspaceAppSurfaceHost,
    workspaceId
  ]);
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
        eventStreamClient,
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
      eventStreamClient,
      reporterService,
      richTextAtService,
      tuttidClient,
      workspaceAgentActivityService,
      workspaceFileManagerService,
      workspaceId,
      workspaceUserProjectService
    ]
  );
  const trackStandaloneAgentGUIEngagement = useMemo(
    () =>
      agentGuiHostInput.createAgentGUIEngagementEventSink("standalone_agent"),
    [agentGuiHostInput]
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
  const headerIdentity = useStandaloneAgentWindowHeaderIdentity({
    activeAgentTargetId,
    agents,
    fallbackProvider: readStandaloneNodeProvider(nodeState, launchProvider),
    nodeState,
    sessions: activitySnapshot.sessions,
    workspaceAgentActivityService,
    workspaceId
  });
  const headerProvider = headerIdentity.provider;
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
      // Standalone has one node; document focus is tracked live by engagement.
      isFocused: true,
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
    workspaceAgentActivityService,
    workspaceAppCenterService,
    workspaceId
  });
  const resizeStandaloneAgentWindowContentWidth = useCallback(
    (width: number, animate = false) =>
      hostWindowApi.resizeContentWidth({ animate, width }),
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
      offsetFromSourceWindow: true,
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
          <StandaloneAgentWindowHeader
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
              openDetachedWindow: i18n.t("workspace.agentGui.openNewWindow"),
              untitledConversation: i18n.t(
                "workspace.agentGui.untitledConversation"
              )
            }}
            conversationRailWidthPx={headerConversationRailWidthPx}
            data-agent-gui-standalone-window-content-loading={
              isContentLoading ? "true" : "false"
            }
            displayMode={isWindowMaximized ? "fullscreen" : "floating"}
            data-agent-gui-standalone-window-header="true"
            data-workbench-drag-handle="true"
            isConversationRailAutoCollapsed={isConversationRailAutoCollapsed}
            isConversationRailCollapsed={isConversationRailCollapsed}
            identity={headerIdentity}
            nodeId={standaloneAgentNodeId}
            providerRailWidthPx={agentGuiWorkbenchProviderRailWidthPx}
            primaryAccessory={<AppUpdateStatus presentation="standalone" />}
            secondaryAccessory={isContentLoading ? null : toolActions}
            showConversationRailToggle={!isContentLoading}
            showAppTitle={false}
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
        onAppendBrowserElementMention={appendBrowserElementMention}
        onBrowserElementError={Toast.Error}
        onToolHostReady={toolWorkbench.onHostReady}
        resizeWindowContentWidth={resizeStandaloneAgentWindowContentWidth}
        workspaceId={workspaceId}
      >
        <StandaloneAgentWindowContentReady onReady={handleContentReady}>
          <DesktopAgentGUIWorkbenchBody
            agentActivityRuntime={agentGuiHostInput.agentActivityRuntime}
            agentHostApi={agentGuiHostInput.agentHostApi}
            tuttiModePlanReviewRuntime={
              agentGuiHostInput.tuttiModePlanReviewRuntime
            }
            appCenterService={workspaceAppCenterService}
            agentProviderStatusService={agentProviderStatusService}
            context={context}
            computerUseApi={desktopApi.computerUse}
            composerAppendRequest={composerAppendRequest}
            conversationRailAutoCollapseWidthPx={
              AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
            }
            dockPreviewCache={dockPreviewCache}
            onLinkAction={handleLinkAction}
            onCapabilitySettingsRequest={handleCapabilitySettingsRequest}
            onCreateIssueFromPlan={agentGuiHostInput.createIssueFromPlan}
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
            onEngagementEvent={trackStandaloneAgentGUIEngagement}
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
