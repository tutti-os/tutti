import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostActivation,
  WorkbenchHostHandle,
  WorkbenchHostLaunchInput,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeData,
  WorkbenchHostNodeHeaderContext,
  WorkbenchNode
} from "@tutti-os/workbench-surface";
import { Button, cn } from "@tutti-os/ui-system";
import type {
  DesktopApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type { DesktopFusionWindowKind } from "@shared/contracts/fusion.ts";
import {
  WorkspaceAppCenterIntegration,
  workspaceAppWebviewTypeID,
  useWorkspaceAppCenterService
} from "@renderer/features/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { resolveFusionWorkbenchTypeId } from "../services/fusionWindowModel.ts";
import {
  canResolveStandaloneFusionNode,
  createStandaloneWorkbenchHost,
  readResourceIdFromNode,
  readStandaloneSettingsRequest,
  resolveStandaloneNode,
  shouldCloseStandaloneAfterWorkspaceAppHandoff,
  type ResolvedStandaloneNode
} from "../services/standaloneWorkbenchNodeAdapter.ts";
import {
  publishWorkspaceAppLaunchIntent,
  shouldPublishWorkspaceAppLaunchIntentBeforeLaunch
} from "../services/workspaceAppLaunchIntent.ts";
import {
  createStandaloneWorkbenchNodeLaunchRequestController,
  type StandaloneWorkbenchNodeLaunchRequestController
} from "../services/standaloneWorkbenchNodeLaunchRequest.ts";
import { createStandaloneWorkbenchExternalStateRevisionStore } from "../services/standaloneWorkbenchExternalState.ts";
import { useStandaloneFusionLaunchCoordinators } from "../services/useStandaloneFusionLaunchCoordinators.ts";
import type { WorkspaceWorkbenchHostSessionBinding } from "../services/workspaceWorkbenchHostService.interface.ts";
import { FusionFallbackWindowChrome } from "./FusionFallbackWindowChrome.tsx";
import { WorkspaceAppExternalBridge } from "./WorkspaceAppExternalBridge.tsx";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel.tsx";
import { WorkspaceWorkbenchWindowChromeProvider } from "./WorkspaceWorkbenchTrafficLights.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService.ts";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime.tsx";
import { useWorkspaceExternalAgentSessionImportHost } from "./useWorkspaceExternalAgentSessionImportHost.tsx";

export interface StandaloneWorkbenchNodeWindowProps {
  desktopApi: DesktopApi;
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceId?: string | null;
  windowInstanceId: string;
  workspace: WorkspaceSummary;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
}

interface StandaloneWorkbenchNodeLaunchResolution {
  result: ResolvedStandaloneNode | null;
  shouldPrepublishIntent: boolean;
}

export function StandaloneWorkbenchNodeWindow(
  props: StandaloneWorkbenchNodeWindowProps
): ReactNode {
  const { t } = useTranslation();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [hostSession, setHostSession] =
    useState<WorkspaceWorkbenchHostSessionBinding | null>(null);

  useEffect(() => {
    const binding = workbenchHostService.openHostSession(props.workspace.id);
    setHostSession(binding);
    return () => {
      binding.release();
    };
  }, [props.workspace.id, workbenchHostService]);

  if (!hostSession?.isActive) {
    return (
      <FusionFallbackWindowChrome
        desktopApi={props.desktopApi}
        title={t("workspace.fusion.toolLoading")}
      >
        <div className="grid h-full place-items-center p-8 text-center text-sm text-[var(--text-secondary)]">
          {t("workspace.fusion.toolLoading")}
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  return (
    <StandaloneWorkbenchNodeWindowWithSession
      {...props}
      hostSession={hostSession}
    />
  );
}

function StandaloneWorkbenchNodeWindowWithSession({
  desktopApi,
  hostSession,
  kind,
  launchPayload,
  resourceId,
  windowInstanceId,
  workspace,
  workspaceAppExternalApi
}: StandaloneWorkbenchNodeWindowProps & {
  hostSession: WorkspaceWorkbenchHostSessionBinding;
}): ReactNode {
  const { t } = useTranslation();
  const runtime = useWorkspaceWorkbenchShellRuntime({
    enableWindowCloseGuard: false,
    hostSession,
    state: {
      platform: desktopApi.platform.os,
      workspace
    }
  });
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const fusionLaunch = useStandaloneFusionLaunchCoordinators({
    appCenterService,
    desktopApi,
    workbenchHostService,
    workspaceId: workspace.id
  });
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();
  const { host: externalAgentImportHost, openExternalAgentImport } =
    useWorkspaceExternalAgentSessionImportHost({
      enabled: kind === "settings",
      workspace
    });
  const [launch, setLaunch] = useState<ResolvedStandaloneNode | null>(null);
  const [launchError, setLaunchError] = useState(false);
  const launchRequestControllerRef =
    useRef<StandaloneWorkbenchNodeLaunchRequestController<StandaloneWorkbenchNodeLaunchResolution> | null>(
      null
    );
  launchRequestControllerRef.current ??=
    createStandaloneWorkbenchNodeLaunchRequestController<StandaloneWorkbenchNodeLaunchResolution>();
  const launchRequestController = launchRequestControllerRef.current;
  const workspaceAppHandoffOpenedRef = useRef(false);
  const settingsRenderedOpenRef = useRef(false);
  const latestNodeRef = useRef<WorkbenchNode<WorkbenchHostNodeData> | null>(
    null
  );
  const hostRef = useRef<WorkbenchHostHandle | null>(null);
  const [runtimeNodeState, setRuntimeNodeState] = useState<unknown>(null);
  const [snapshotNodeState, setSnapshotNodeState] = useState<unknown>(null);
  const [activation, setActivation] = useState<WorkbenchHostActivation | null>(
    null
  );
  const [title, setTitle] = useState<string | null>(null);
  const [surfaceSize, setSurfaceSize] = useState(() => readSurfaceSize());
  const appCenterIntegration =
    kind === "app-center" || kind === "settings" || kind === "workspace-app" ? (
      <WorkspaceAppCenterIntegration workspaceId={workspace.id} />
    ) : null;

  const launchFusionWindow = useCallback(
    async (input: WorkbenchHostLaunchInput): Promise<string | null> => {
      const descriptor = await fusionLaunch.openWorkbenchNode({
        payload: input.payload,
        typeId: input.typeId
      });
      if (
        descriptor &&
        input.typeId === workspaceAppWebviewTypeID &&
        isPreparedWorkspaceAppLaunch(input.payload)
      ) {
        workspaceAppHandoffOpenedRef.current = true;
      }
      return descriptor?.windowInstanceId ?? null;
    },
    [fusionLaunch]
  );

  if (!hostRef.current) {
    hostRef.current = createStandaloneWorkbenchHost({
      approveClose: () => desktopApi.host.window.approveClose(),
      getNode: () => latestNodeRef.current,
      launchNode: launchFusionWindow,
      minimize: () => desktopApi.host.window.minimize(),
      setActivation,
      setRuntimeNodeState,
      setSnapshotNodeState,
      setTitle,
      toggleMaximize: () => desktopApi.host.window.toggleMaximize()
    });
  }
  const host = hostRef.current;

  useEffect(() => {
    const handleResize = () => setSurfaceSize(readSurfaceSize());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    runtime.onWorkbenchHostHandleReady(host);
    return () => runtime.onWorkbenchHostHandleReady(null);
  }, [host, runtime.onWorkbenchHostHandleReady]);

  useEffect(() => {
    if (kind !== "settings") {
      return;
    }
    const settingsRequest = readStandaloneSettingsRequest(launchPayload);
    settingsService.openPanel(
      { id: workspace.id },
      {
        ...(settingsRequest.anchor ? { anchor: settingsRequest.anchor } : {}),
        ...(settingsRequest.provider || settingsRequest.tab === "models"
          ? { pane: "managed-models" as const }
          : {}),
        ...(settingsRequest.provider
          ? { provider: settingsRequest.provider }
          : {}),
        ...(settingsRequest.section ? { section: settingsRequest.section } : {})
      }
    );
    return () => settingsService.closePanel();
  }, [kind, launchPayload, settingsService, workspace.id]);

  useEffect(() => {
    if (kind !== "settings") {
      return;
    }
    if (settingsState.open) {
      settingsRenderedOpenRef.current = true;
      return;
    }
    if (settingsRenderedOpenRef.current) {
      void desktopApi.host.window.approveClose();
    }
  }, [desktopApi.host.window, kind, settingsState.open]);

  useEffect(() => {
    if (kind === "settings") {
      return;
    }
    if (
      !canResolveStandaloneFusionNode({
        appCenterLoadStatus: appCenterState.loadStatus,
        appCenterWorkspaceId: appCenterState.workspaceId,
        kind,
        workspaceId: workspace.id
      })
    ) {
      return;
    }
    const typeId = resolveFusionWorkbenchTypeId({ kind, launchPayload });
    if (!typeId) {
      setLaunchError(true);
      return;
    }
    return launchRequestController.start({
      async execute() {
        const shouldPrepublishIntent =
          shouldPublishWorkspaceAppLaunchIntentBeforeLaunch({
            appCenterService,
            payload: launchPayload,
            typeId
          });
        if (shouldPrepublishIntent) {
          publishWorkspaceAppLaunchIntent({
            api: workspaceAppExternalApi,
            payload: launchPayload,
            typeId,
            workspaceId: workspace.id
          });
        }
        workspaceAppHandoffOpenedRef.current = false;
        return {
          result: await resolveStandaloneNode({
            contributions: runtime.hostInput.contributions ?? [],
            kind,
            launchPayload,
            resourceId,
            typeId,
            workspaceId: workspace.id
          }),
          shouldPrepublishIntent
        };
      },
      onRejected() {
        setLaunchError(true);
      },
      onResolved({ result, shouldPrepublishIntent }) {
        if (!result) {
          if (
            shouldCloseStandaloneAfterWorkspaceAppHandoff({
              handoffWindowOpened: workspaceAppHandoffOpenedRef.current,
              kind,
              resolvedNode: result
            })
          ) {
            void desktopApi.host.window.approveClose();
            return;
          }
          setLaunchError(true);
          return;
        }
        setLaunch(result);
        setActivation(result.activation);
        setTitle(result.title);
        if (!shouldPrepublishIntent) {
          publishWorkspaceAppLaunchIntent({
            api: workspaceAppExternalApi,
            payload: launchPayload,
            typeId,
            workspaceId: workspace.id
          });
        }
      }
    });
  }, [
    appCenterState.loadStatus,
    appCenterState.workspaceId,
    appCenterService,
    kind,
    launchRequestController,
    launchPayload,
    resourceId,
    runtime.hostInput.contributions,
    windowInstanceId,
    workspace.id,
    workspaceAppExternalApi
  ]);

  const node = useMemo<WorkbenchNode<WorkbenchHostNodeData> | null>(() => {
    if (!launch) {
      return null;
    }
    const resolvedTitle = title ?? launch.title;
    return {
      data: {
        activation,
        instanceId: launch.instanceId,
        instanceKey: launch.instanceKey,
        runtimeNodeState,
        snapshotNodeState,
        typeId: launch.definition.typeId
      },
      displayMode: "floating",
      frame: {
        height: surfaceSize.height,
        width: surfaceSize.width,
        x: 0,
        y: 0
      },
      id: launch.nodeId,
      isMinimized: false,
      kind: "window",
      restoreFrame: null,
      sizeConstraints: launch.definition.sizeConstraints,
      title: resolvedTitle
    };
  }, [
    activation,
    launch,
    runtimeNodeState,
    snapshotNodeState,
    surfaceSize.height,
    surfaceSize.width,
    title
  ]);
  latestNodeRef.current = node;

  const externalNodeState = useStandaloneExternalNodeState({
    launch,
    node,
    workspaceId: workspace.id
  });
  const externalWorkspaceState = readStandaloneExternalWorkspaceState({
    launch,
    workspaceId: workspace.id
  });

  useEffect(() => {
    if (!launch || !node) {
      return;
    }
    const lease = launch.definition.createLease?.({
      node,
      workspaceId: workspace.id
    });
    return () => lease?.release();
  }, [launch, node?.id, workspace.id]);

  useEffect(() => {
    if (kind === "settings") {
      void desktopApi.fusion
        .updateWindow({
          resourceId: null,
          title: t("workspace.fusion.kind.settings"),
          windowInstanceId
        })
        .catch(() => undefined);
      return;
    }
    if (!node) {
      return;
    }
    void desktopApi.fusion
      .updateWindow({
        resourceId:
          resourceId ?? readResourceIdFromNode(kind, node.data.instanceId),
        title: node.title,
        windowInstanceId
      })
      .catch(() => undefined);
  }, [desktopApi.fusion, kind, node, resourceId, t, windowInstanceId]);

  if (kind === "settings") {
    return (
      <main className="relative h-screen min-h-0 overflow-hidden bg-background">
        {appCenterIntegration}
        <WorkspaceSettingsPanel
          onOpenExternalAgentImport={openExternalAgentImport}
          onSelectWallpaper={runtime.selectWallpaper}
          onSelectWallpaperDisplayMode={runtime.selectWallpaperDisplayMode}
          presentation="window"
          selectedWallpaperDisplayMode={runtime.selectedWallpaperDisplayMode}
          selectedWallpaperID={runtime.selectedWallpaperID}
          workspace={workspace}
        />
        {externalAgentImportHost}
      </main>
    );
  }

  if (launchError) {
    return (
      <FusionFallbackWindowChrome
        desktopApi={desktopApi}
        title={t("workspace.fusion.toolUnavailableTitle")}
      >
        {appCenterIntegration}
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="flex max-w-md flex-col items-center gap-3">
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {t("workspace.fusion.toolUnavailable")}
            </p>
            <Button onClick={() => window.location.reload()}>
              {t("workspace.fallback.retryAction")}
            </Button>
          </div>
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  if (
    kind === "workspace-app" &&
    appCenterState.workspaceId === workspace.id &&
    appCenterState.loadStatus === "unavailable"
  ) {
    return (
      <FusionFallbackWindowChrome
        desktopApi={desktopApi}
        title={t("workspace.fusion.toolUnavailableTitle")}
      >
        {appCenterIntegration}
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="flex max-w-md flex-col items-center gap-3">
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {t("workspace.fusion.appCenterUnavailable")}
            </p>
            <Button onClick={() => void appCenterService.refresh(workspace.id)}>
              {t("workspace.fallback.retryAction")}
            </Button>
          </div>
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  if (!launch || !node) {
    return (
      <FusionFallbackWindowChrome
        desktopApi={desktopApi}
        title={t("workspace.fusion.toolLoading")}
      >
        {appCenterIntegration}
        <div className="grid h-full place-items-center p-8 text-center text-sm text-[var(--text-secondary)]">
          {t("workspace.fusion.toolLoading")}
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  const bodyContext: WorkbenchHostNodeBodyContext = {
    activation,
    displayMode: "floating",
    externalNodeState,
    externalWorkspaceState,
    focus: () => {
      void desktopApi.fusion.focusWindow({ windowInstanceId });
    },
    host,
    instanceId: launch.instanceId,
    instanceKey: launch.instanceKey,
    isFocused: document.hasFocus(),
    node,
    setNodeRuntimeState: setRuntimeNodeState,
    setSnapshotNodeState
  };
  const headerContext: WorkbenchHostNodeHeaderContext = {
    activation,
    defaultActions: null,
    displayMode: "floating",
    dragHandleProps: {
      "data-workbench-drag-handle": "true",
      onDoubleClick: () => undefined,
      onPointerDown: () => undefined
    },
    externalNodeState,
    externalWorkspaceState,
    instanceId: launch.instanceId,
    instanceKey: launch.instanceKey,
    isFocused: document.hasFocus(),
    node,
    surfaceSize,
    windowActions: {
      applyQuickLayout: () => undefined,
      close: () => {
        void desktopApi.host.window.approveClose();
      },
      focus: bodyContext.focus,
      minimize: () => {
        void desktopApi.host.window.minimize();
      },
      resize: () => undefined,
      toggleDisplayMode: () => {
        void desktopApi.host.window.toggleMaximize();
      }
    }
  };

  return (
    <WorkspaceWorkbenchWindowChromeProvider mode="native">
      <main className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-background text-[var(--text-primary)]">
        {appCenterIntegration}
        {launch.definition.renderHeader &&
        shouldRenderStandaloneContentHeader(kind) ? (
          <header
            className={cn(
              "h-[52px] min-h-[52px] border-b border-[var(--border-1)]",
              "[&_[data-workbench-drag-handle]]:!cursor-default",
              "[&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag] [&_input]:[-webkit-app-region:no-drag] [&_select]:[-webkit-app-region:no-drag] [&_textarea]:[-webkit-app-region:no-drag]",
              "[&_.nodrag]:[-webkit-app-region:no-drag] [&_[contenteditable=true]]:[-webkit-app-region:no-drag] [&_[role=button]]:[-webkit-app-region:no-drag]",
              "[-webkit-app-region:no-drag]"
            )}
            data-fusion-native-window-content-header="true"
          >
            {launch.definition.renderHeader(headerContext)}
          </header>
        ) : null}
        <section className="min-h-0 flex-1 overflow-hidden [-webkit-app-region:no-drag]">
          {launch.definition.renderBody(bodyContext)}
        </section>
        {kind === "workspace-app" ? (
          <WorkspaceAppExternalBridge
            api={workspaceAppExternalApi}
            openFile={async (input) => {
              await fusionLaunch.openPayloadWindow({
                kind: "files",
                payload: input,
                resourceId: input.path
              });
            }}
            openSettings={async (input) => {
              await fusionLaunch.openSettings(input);
            }}
            runLinkAction={(action) =>
              runDesktopAgentGUILinkAction(action, {
                homeDirectory: desktopApi.platform.homeDirectory,
                launchAgentGui: async (input) => {
                  await fusionLaunch.openPayloadWindow({
                    kind: "agent",
                    payload: input,
                    resourceId: input.agentSessionId
                  });
                  return true;
                },
                launchGroupChat: async (input) => {
                  return fusionLaunch.openGroupChat(input);
                },
                launchWorkspaceApp: async (input) => {
                  await fusionLaunch.openWorkspaceApp({ appId: input.appId });
                  return true;
                },
                launchWorkspaceFiles: async (input) => {
                  await fusionLaunch.openPayloadWindow({
                    kind: "files",
                    payload: input,
                    resourceId: input.path
                  });
                  return true;
                },
                launchWorkspaceIssueManager: async (input) => {
                  await fusionLaunch.openPayloadWindow({
                    kind: "issue-manager",
                    payload: input,
                    resourceId: input.issueId
                  });
                  return true;
                },
                openBrowserUrl: async (input) => {
                  await fusionLaunch.openPayloadWindow({
                    kind: "browser",
                    payload: { url: input.url }
                  });
                  return true;
                },
                workspaceId: workspace.id
              })
            }
            workspaceId={workspace.id}
          />
        ) : null}
      </main>
    </WorkspaceWorkbenchWindowChromeProvider>
  );
}

function useStandaloneExternalNodeState(input: {
  launch: ResolvedStandaloneNode | null;
  node: WorkbenchNode<WorkbenchHostNodeData> | null;
  workspaceId: string;
}): unknown {
  const source = input.launch?.contribution.externalStateSource;
  const revisionStore = useMemo(
    () => createStandaloneWorkbenchExternalStateRevisionStore(source),
    [source]
  );
  const lookup =
    input.launch && input.node
      ? {
          instanceId: input.launch.instanceId,
          instanceKey: input.launch.instanceKey,
          nodeId: input.node.id,
          typeId: input.launch.definition.typeId,
          workspaceId: input.workspaceId
        }
      : null;
  useSyncExternalStore(
    revisionStore.subscribe,
    revisionStore.getSnapshot,
    readZeroExternalStateRevision
  );
  return lookup ? source?.getNodeState(lookup) : null;
}

function readStandaloneExternalWorkspaceState(input: {
  launch: ResolvedStandaloneNode | null;
  workspaceId: string;
}): unknown {
  return input.launch?.contribution.externalStateSource?.getWorkspaceState({
    workspaceId: input.workspaceId
  });
}

function readSurfaceSize() {
  return {
    height: Math.max(1, window.innerHeight),
    width: Math.max(1, window.innerWidth)
  };
}

function readZeroExternalStateRevision(): number {
  return 0;
}

function isPreparedWorkspaceAppLaunch(payload: unknown): boolean {
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { prepared?: unknown }).prepared === true
  );
}

function shouldRenderStandaloneContentHeader(
  kind: DesktopFusionWindowKind
): boolean {
  return (
    kind === "browser" ||
    kind === "file-preview" ||
    kind === "issue-manager" ||
    kind === "terminal"
  );
}
