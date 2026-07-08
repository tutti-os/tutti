import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { AgentGuiWorkbenchHeader } from "@tutti-os/agent-gui/workbench";
import { useWorkspaceSettingsPanelRequest } from "@tutti-os/agent-gui/workspace-settings-panel";
import {
  normalizeAgentGUIProviderTargets,
  type AgentGUIProviderTarget
} from "@tutti-os/agent-gui";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
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
  AgentEnvPanel,
  createDesktopAgentGUIWorkbenchHostInput,
  DesktopAgentGUIWorkbenchBody,
  desktopAgentGUIOpenSessionActivationType,
  ensureAllDesktopManagedAgentProviderStatuses,
  IAgentsService,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type AgentProviderStatusSnapshot,
  type AgentProviderStatusService,
  type WorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";
import { resolveDesktopAgentGUIProviderForAgentTarget } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchStateHelpers.ts";
import { isDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { DesktopAgentGUIWorkbenchState } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { DesktopApi, DesktopHostWindowApi } from "@preload/types";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { useTranslation } from "@renderer/i18n";
import { ExternalAgentSessionImportPrompt } from "./ExternalAgentSessionImportPrompt";
import { ExternalAgentSessionImportWizard } from "./ExternalAgentSessionImportWizard";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import type { WorkspaceSettingsSectionID } from "../services/workspaceSettingsService.interface";
import type { WorkspaceWorkbenchCapabilitySettingsTarget } from "../services/workspaceWorkbenchHostService.interface";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

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
  const workspaceId = workspace.id;
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const launchProvider = normalizeDesktopAgentGUIProvider(
    params.get("provider")
  );
  const launchAgentSessionId = params.get("agentSessionId")?.trim() || null;
  const launchAgentTargetId = params.get("agentTargetId")?.trim() || null;
  const bootstrapProviderTargets = useMemo(
    () => readBootstrapProviderTargets(params),
    [params]
  );
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
  const [providerTargets, setProviderTargets] = useState<
    Awaited<ReturnType<typeof agentsService.load>>["providerTargets"] | null
  >(() => bootstrapProviderTargets);
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
    () => `agent-gui:${launchProvider}:standalone:${workspaceId}`,
    [launchProvider, workspaceId]
  );
  const activeAgentTargetId = nodeState.agentTargetId?.trim() || null;
  const headerProvider = resolveDesktopAgentGUIProviderForAgentTarget(
    activeAgentTargetId,
    providerTargets ?? undefined,
    readStandaloneNodeProvider(nodeState, launchProvider)
  );
  const headerAgentTarget =
    activeAgentTargetId && providerTargets
      ? (providerTargets.find(
          (target) => target.agentTargetId === activeAgentTargetId
        ) ?? null)
      : null;
  const headerConversationIconFallbackUrl =
    resolveAgentGuiSessionProviderIconUrl(headerProvider);
  const headerConversationIconUrl =
    headerAgentTarget?.iconUrl ?? headerConversationIconFallbackUrl;
  const headerConversationTitle =
    nodeState.lastActiveConversationTitle?.trim() || null;
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
    let disposed = false;
    void agentsService.load().then((snapshot) => {
      if (!disposed) {
        setProviderTargets(snapshot.providerTargets);
      }
    });
    return () => {
      disposed = true;
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
          displayMode="floating"
          data-agent-gui-standalone-window-header="true"
          data-workbench-drag-handle="true"
          isConversationRailAutoCollapsed={false}
          isConversationRailCollapsed={
            nodeState.conversationRailCollapsed === true
          }
          nodeId={standaloneAgentNodeId}
          providerRailWidthPx={agentGuiWorkbenchProviderRailWidthPx}
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
          onCapabilitySettingsRequest={handleCapabilitySettingsRequest}
          onOpenAgentConversationWindow={({ agentSessionId, provider }) => {
            // Hand off whatever is cached right now — see the matching note
            // in workspaceAgentGuiContribution.ts's onOpenDetachedWindow for
            // why we don't block this click on a full provider probe.
            void hostWindowApi.openAgentWindow({
              agentSessionId,
              providerStatusSnapshot: agentProviderStatusService.getSnapshot(),
              providerTargets: providerTargets ?? undefined,
              provider,
              workspaceId
            });
          }}
          onStateChange={setNodeState}
          providerStatusBootstrapSnapshot={providerStatusBootstrapSnapshot}
          providerTargets={providerTargets ?? []}
          providerTargetsLoading={providerTargets === null}
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
        agentProviderStatusService={agentProviderStatusService}
        host={host}
        workspace={workspace}
      />
    </main>
  );
}

function StandaloneAgentWindowPanelHosts({
  agentProviderStatusService,
  host,
  workspace
}: {
  agentProviderStatusService: AgentProviderStatusService;
  host: WorkbenchHostHandle;
  workspace: WorkspaceSummary;
}): ReactNode {
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const settingsPanelRequest = useWorkspaceSettingsPanelRequest();
  const lastHandledSettingsRequestRef = useRef(
    settingsPanelRequest.requestSequence
  );
  const [externalImportWizardProviders, setExternalImportWizardProviders] =
    useState<WorkspaceAgentProvider[] | undefined>(undefined);
  const [externalImportWizardOpen, setExternalImportWizardOpen] =
    useState(false);
  const wallpaperRevision = useSyncExternalStore(
    (listener) => workbenchHostService.subscribeWallpaperChanges(listener),
    () => workbenchHostService.getWallpaperRevision(),
    () => workbenchHostService.getWallpaperRevision()
  );
  const selectedWallpaperID = useMemo(
    () => workbenchHostService.readWallpaperId(workspace.id),
    [wallpaperRevision, workbenchHostService, workspace.id]
  );
  const selectedWallpaperDisplayMode = useMemo(
    () => workbenchHostService.readWallpaperDisplayMode(workspace.id),
    [wallpaperRevision, workbenchHostService, workspace.id]
  );
  const openExternalAgentImport = useCallback(
    (providers?: WorkspaceAgentProvider[]) => {
      setExternalImportWizardProviders(providers);
      setExternalImportWizardOpen(true);
    },
    []
  );
  useEffect(() => {
    const openImportWizard = (): void => {
      openExternalAgentImport();
    };
    window.addEventListener(
      AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
      openImportWizard
    );
    return () => {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
        openImportWizard
      );
    };
  }, [openExternalAgentImport]);
  const selectWallpaper = useCallback(
    (wallpaperId: WorkspaceWallpaperId) => {
      workbenchHostService.writeWallpaperId(workspace.id, wallpaperId);
    },
    [workbenchHostService, workspace.id]
  );
  const selectWallpaperDisplayMode = useCallback(
    (displayMode: WorkspaceWallpaperDisplayMode) => {
      workbenchHostService.writeWallpaperDisplayMode(workspace.id, displayMode);
    },
    [workbenchHostService, workspace.id]
  );

  useEffect(() => {
    if (
      settingsPanelRequest.requestSequence ===
      lastHandledSettingsRequestRef.current
    ) {
      return;
    }
    lastHandledSettingsRequestRef.current =
      settingsPanelRequest.requestSequence;
    workspaceSettingsService.openPanel(
      { id: workspace.id },
      settingsPanelRequest.section
        ? {
            section: settingsPanelRequest.section as WorkspaceSettingsSectionID
          }
        : undefined
    );
  }, [settingsPanelRequest, workspace.id, workspaceSettingsService]);

  return (
    <>
      <WorkspaceSettingsPanel
        onOpenExternalAgentImport={() => openExternalAgentImport()}
        onSelectWallpaper={selectWallpaper}
        onSelectWallpaperDisplayMode={selectWallpaperDisplayMode}
        selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
        selectedWallpaperID={selectedWallpaperID}
        workspace={workspace}
      />
      <ExternalAgentSessionImportPrompt
        workspaceId={workspace.id}
        onOpenImport={openExternalAgentImport}
      />
      <ExternalAgentSessionImportWizard
        initialProviders={externalImportWizardProviders}
        open={externalImportWizardOpen}
        workspace={workspace}
        onOpenChange={setExternalImportWizardOpen}
      />
      <AgentEnvPanel
        agentProviderStatusService={agentProviderStatusService}
        workspaceId={workspace.id}
        workbenchHost={host}
      />
    </>
  );
}

function readBootstrapProviderTargets(
  params: URLSearchParams
): readonly AgentGUIProviderTarget[] | null {
  const encodedProviderTargets = params.get("agentProviderTargets");
  if (!encodedProviderTargets) {
    return null;
  }
  try {
    const parsed = JSON.parse(encodedProviderTargets);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return normalizeAgentGUIProviderTargets(
      parsed as readonly AgentGUIProviderTarget[],
      { useStaticCatalog: false }
    );
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
