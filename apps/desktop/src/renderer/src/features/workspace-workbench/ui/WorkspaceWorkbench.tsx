import type * as React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import {
  defaultIssueManagerWorkbenchTypeId,
  issueManagerOpenActivationType,
  type IssueManagerOpenActivationPayload
} from "@tutti-os/workspace-issue-manager/workbench";
import {
  type WorkbenchHostCloseDialogRequest,
  type WorkbenchHostHandle,
  WorkbenchHost
} from "@tutti-os/workbench-surface";
import {
  Button,
  CardDescription,
  CardTitle,
  ConfirmationDialog,
  LoadingIcon,
  WarningLinedIcon
} from "@tutti-os/ui-system";
import {
  useWorkspaceAppCenterService,
  WorkspaceAppCenterIntegration,
  workspaceAppCenterNodeID
} from "@renderer/features/workspace-app-center";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import {
  IAgentProviderStatusService,
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { useService } from "@tutti-os/infra/di";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import {
  createWorkspaceAgentGuiDraftLaunchRequest,
  createWorkspaceAgentGuiSessionLaunchRequest
} from "../services/workspaceAgentGuiLaunch.ts";
import type { WorkspaceLaunchpadOpenTrigger } from "../services/workspaceLaunchpadAnalytics.ts";
import {
  registerWorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "../services/workspaceBrowserLaunchCoordinator.ts";
import {
  isWorkspaceMissionControlActivateShortcut,
  isWorkspaceMissionControlLayoutShortcut
} from "../services/workspaceMissionControlShortcut.ts";
import {
  registerWorkspaceFilesLaunchHandler,
  workspaceFilesLaunchTypeId,
  type WorkspaceFilesLaunchRequest
} from "../services/workspaceFilesLaunchCoordinator.ts";
import {
  registerWorkspaceIssueManagerLaunchHandler,
  type WorkspaceIssueManagerLaunchRequest
} from "../services/workspaceIssueManagerLaunchCoordinator.ts";
import { workspaceLaunchpadDockActionId } from "../services/workspaceLaunchpadModel.ts";
import { requestWorkspaceMessageCenterOpen } from "../services/workspaceMessageCenterCoordinator.ts";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog.ts";
import { workspaceBrowserNodeID } from "../services/workspaceWorkbenchNodeIds.ts";
import { WorkspaceChrome } from "./WorkspaceChrome";
import { WorkspaceAppExternalBridge } from "./WorkspaceAppExternalBridge";
import { WorkspaceLaunchpadOverlay } from "./WorkspaceLaunchpadOverlay.tsx";
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime";
import { resolveWorkspaceWorkbenchLayoutConstraints } from "./workspaceWorkbenchLayoutConstraints.ts";
import type { DesktopWorkspaceAppExternalHostApi } from "@preload/types";
import type { TuttiExternalFileOpenInput } from "@tutti-os/workspace-external-core/contracts";

const onboardingAppId = "tutti-onboarding";

interface WorkspaceWorkbenchProps {
  enableWindowCloseGuard: boolean;
  headerSlot?: React.ReactNode;
  routeView: string;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceID: string | null;
}
export function WorkspaceWorkbench({
  enableWindowCloseGuard,
  headerSlot,
  routeView,
  workspaceAppExternalApi,
  workspaceID
}: WorkspaceWorkbenchProps) {
  const { service, state } = useWorkspaceCatalogService();
  const { t } = useTranslation();
  const loadWorkspaceWindow = useCallback(() => {
    void service.loadWorkspaceWindow(workspaceID, routeView);
  }, [routeView, service, workspaceID]);

  useEffect(() => {
    loadWorkspaceWindow();
  }, [loadWorkspaceWindow]);

  if (state.status === "unavailable") {
    return (
      <WorkspaceFallbackState
        description={
          state.workspaceError ?? t("workspace.fallback.loadingDescription")
        }
        onRetry={loadWorkspaceWindow}
        title={t("workspace.fallback.unavailableTitle")}
        tone="destructive"
      />
    );
  }

  if (state.status === "loading" || !state.workspace) {
    return <main className="h-screen min-h-0 bg-background" />;
  }

  return (
    <ReadyWorkspaceWorkbench
      enableWindowCloseGuard={enableWindowCloseGuard}
      headerSlot={headerSlot}
      state={{
        platform: state.platform,
        workspace: state.workspace
      }}
      workspaceAppExternalApi={workspaceAppExternalApi}
    />
  );
}

function ReadyWorkspaceWorkbench({
  enableWindowCloseGuard,
  headerSlot,
  state,
  workspaceAppExternalApi
}: {
  enableWindowCloseGuard: boolean;
  headerSlot?: React.ReactNode;
  state: {
    platform: NodeJS.Platform;
    workspace: WorkspaceSummary;
  };
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
}) {
  const { service: appCenterService } = useWorkspaceAppCenterService();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const runtime = useWorkspaceWorkbenchShellRuntime({
    enableWindowCloseGuard,
    state
  });
  const hostInput = runtime.hostInput;
  const [workbenchHost, setWorkbenchHost] =
    useState<WorkbenchHostHandle | null>(null);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [launchpadOpenTrigger, setLaunchpadOpenTrigger] =
    useState<WorkspaceLaunchpadOpenTrigger>("dock");
  const layoutConstraints = useMemo(
    () => resolveWorkspaceWorkbenchLayoutConstraints(runtime.dockPlacement),
    [runtime.dockPlacement]
  );
  const unregisterAgentGuiLaunchRef = useRef<(() => void) | null>(null);
  const unregisterBrowserLaunchRef = useRef<(() => void) | null>(null);
  const unregisterFilesLaunchRef = useRef<(() => void) | null>(null);
  const unregisterIssueManagerLaunchRef = useRef<(() => void) | null>(null);
  const openedOnboardingWorkspacesRef = useRef(new Set<string>());
  const closeLaunchpad = useCallback(() => {
    setLaunchpadOpen(false);
  }, []);
  const openWorkspaceAppExternalFile = useCallback(
    async (input: TuttiExternalFileOpenInput) => {
      if (!workbenchHost) {
        throw new Error("Workspace host is unavailable.");
      }
      const opened = await openWorkspaceFilesNode(workbenchHost, {
        path: input.path,
        workspaceId: state.workspace.id
      });
      if (!opened) {
        throw new Error("Workspace files could not be opened.");
      }
    },
    [state.workspace.id, workbenchHost]
  );
  const onDockEntryAction = useCallback(
    (
      request: Parameters<NonNullable<typeof hostInput.onDockEntryAction>>[0]
    ) => {
      if (request.actionId === workspaceLaunchpadDockActionId) {
        setLaunchpadOpenTrigger("dock");
        setLaunchpadOpen(true);
        return;
      }
      return hostInput.onDockEntryAction?.(request);
    },
    [hostInput.onDockEntryAction]
  );
  const onDockEntryClick = useCallback(
    (request: Parameters<NonNullable<typeof hostInput.onDockEntryClick>>[0]) =>
      hostInput.onDockEntryClick?.(request),
    [hostInput.onDockEntryClick]
  );
  const onWorkbenchHostHandleReady = useCallback(
    (host: WorkbenchHostHandle | null) => {
      setWorkbenchHost(host);
      runtime.onWorkbenchHostHandleReady(host);
      unregisterAgentGuiLaunchRef.current?.();
      unregisterAgentGuiLaunchRef.current = null;
      unregisterBrowserLaunchRef.current?.();
      unregisterBrowserLaunchRef.current = null;
      unregisterFilesLaunchRef.current?.();
      unregisterFilesLaunchRef.current = null;
      unregisterIssueManagerLaunchRef.current?.();
      unregisterIssueManagerLaunchRef.current = null;

      if (!host) {
        return;
      }

      unregisterAgentGuiLaunchRef.current =
        registerWorkspaceAgentGuiLaunchHandler(
          state.workspace.id,
          async ({
            agentSessionId,
            draftPrompt,
            provider,
            userProjectPath
          }) => {
            const normalizedDraftPrompt = draftPrompt?.trim() ?? "";
            await host.launchNode(
              normalizedDraftPrompt
                ? createWorkspaceAgentGuiDraftLaunchRequest({
                    draftPrompt: normalizedDraftPrompt,
                    provider,
                    userProjectPath
                  })
                : createWorkspaceAgentGuiSessionLaunchRequest({
                    agentSessionId,
                    provider
                  })
            );
          }
        );
      unregisterFilesLaunchRef.current = registerWorkspaceFilesLaunchHandler(
        state.workspace.id,
        async (request) => {
          return openWorkspaceFilesNode(host, request);
        }
      );
      unregisterIssueManagerLaunchRef.current =
        registerWorkspaceIssueManagerLaunchHandler(
          state.workspace.id,
          async (request) => {
            return openWorkspaceIssueManagerNode(host, request);
          }
        );
      unregisterBrowserLaunchRef.current =
        registerWorkspaceBrowserLaunchHandler(
          state.workspace.id,
          async (request) => {
            return openWorkspaceBrowserNode(host, request);
          }
        );
    },
    [runtime, state.workspace.id]
  );

  useEffect(() => {
    return () => {
      unregisterAgentGuiLaunchRef.current?.();
      unregisterAgentGuiLaunchRef.current = null;
      unregisterBrowserLaunchRef.current?.();
      unregisterBrowserLaunchRef.current = null;
      unregisterFilesLaunchRef.current?.();
      unregisterFilesLaunchRef.current = null;
      unregisterIssueManagerLaunchRef.current?.();
      unregisterIssueManagerLaunchRef.current = null;
    };
  }, []);

  useEffect(() => {
    setLaunchpadOpen(false);
  }, [state.workspace.id]);

  useEffect(() => {
    if (!workbenchHost) {
      return;
    }
    const workspaceId = state.workspace.id;
    return runtime.workbenchHostService.onOpenFeatureRequest((request) => {
      if (
        request.feature === "app-center" ||
        request.feature === "issue-manager"
      ) {
        void workbenchHost.launchNode({
          reason: "host",
          typeId:
            request.feature === "app-center"
              ? workspaceAppCenterNodeID
              : defaultIssueManagerWorkbenchTypeId
        });
        return;
      }
      if (request.feature === "message-center") {
        requestWorkspaceMessageCenterOpen(workspaceId);
        return;
      }
      if (request.feature === "agent-chat") {
        // “已绑定，去使用”：打开已绑定（默认）provider 的对话框。
        const snapshot = agentProviderStatusService.getSnapshot();
        const preferred = normalizeDesktopAgentGUIProvider(
          snapshot.defaultProvider ?? request.provider
        );
        void requestWorkspaceAgentGuiLaunch({
          provider: preferred,
          workspaceId
        }).catch(() => {});
        return;
      }
      if (request.feature === "agent-connect") {
        // “绑定 Agent”：走 tutti 既有的绑定流程，与点登录按钮一致。
        // - 未安装 → install（codex：底部连接检测卡片）
        // - 未登录 → login（claude-code：终端面板 + 网页授权）
        // - 已就绪 → 直接打开对话框
        const snapshot = agentProviderStatusService.getSnapshot();
        const provider = normalizeDesktopAgentGUIProvider(request.provider);
        const targetStatus = snapshot.statuses.find(
          (candidate) => String(candidate.provider) === provider
        );
        const availability = targetStatus?.availability.status;
        if (!targetStatus || availability === "ready") {
          void requestWorkspaceAgentGuiLaunch({
            provider,
            workspaceId
          }).catch(() => {});
          return;
        }
        const actionId =
          availability === "not_installed"
            ? targetStatus.actions.find((action) => action.id === "install")?.id
            : availability === "auth_required"
              ? targetStatus.actions.find((action) => action.id === "login")?.id
              : targetStatus.actions.find((action) => action.kind !== "refresh")
                  ?.id;
        if (actionId) {
          void agentProviderStatusService
            .runAction(targetStatus.provider, actionId, {
              workbenchHost,
              workspaceId
            })
            .catch(() => {});
        } else {
          void requestWorkspaceAgentGuiLaunch({
            provider,
            workspaceId
          }).catch(() => {});
        }
        return;
      }
    });
  }, [
    agentProviderStatusService,
    runtime.workbenchHostService,
    state.workspace.id,
    workbenchHost
  ]);

  useEffect(() => {
    if (!workbenchHost) {
      return;
    }
    const workspaceId = state.workspace.id;
    if (openedOnboardingWorkspacesRef.current.has(workspaceId)) {
      return;
    }
    openedOnboardingWorkspacesRef.current.add(workspaceId);

    let canceled = false;
    const openOnboarding = async () => {
      for (let attempt = 0; attempt < 20 && !canceled; attempt += 1) {
        await appCenterService.refresh(workspaceId);
        const app = appCenterService.store.apps.find(
          (candidate) => candidate.appId === onboardingAppId
        );
        if (!app) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (!app.installed) {
          await appCenterService.installApp({
            appId: onboardingAppId,
            workspaceId
          });
          continue;
        }
        if (app?.installed) {
          await appCenterService.openApp({
            appId: onboardingAppId,
            workspaceId
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void openOnboarding().catch(() => {
      openedOnboardingWorkspacesRef.current.delete(workspaceId);
    });
    return () => {
      canceled = true;
    };
  }, [appCenterService, state.workspace.id, workbenchHost]);

  useEffect(() => {
    const missionControlShortcutsEnabled =
      runtime.shortcutsEnabled || runtime.missionControl.isOpen;
    if (!missionControlShortcutsEnabled || !runtime.missionControl.canOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isWorkspaceMissionControlActivateShortcut(event)) {
        if (!isWorkspaceMissionControlLayoutShortcut(event)) {
          return;
        }

        event.preventDefault();
        if (runtime.missionControl.mode === "layout") {
          runtime.missionControl.close();
          return;
        }

        runtime.missionControl.open("layout", "keyboard");
        return;
      }

      event.preventDefault();
      if (runtime.missionControl.mode === "activate") {
        runtime.missionControl.close();
        return;
      }

      runtime.missionControl.open("activate", "keyboard");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [runtime.missionControl, runtime.shortcutsEnabled]);

  return (
    <main
      className={cn(
        "relative h-screen min-h-0 overflow-hidden bg-background",
        launchpadOpen && "workspace-workbench-shell--launchpad-open"
      )}
    >
      <WorkspaceAppCenterIntegration workspaceId={state.workspace.id} />
      <WorkbenchHost
        captureNodePreviewImage={hostInput.captureNodePreviewImage}
        className="h-full"
        contributions={hostInput.contributions}
        debugDiagnostics={hostInput.debugDiagnostics}
        dockPreviewCache={hostInput.dockPreviewCache}
        dockPlacement={runtime.dockPlacement}
        dockEntries={hostInput.dockEntries}
        dockStateSource={hostInput.dockStateSource}
        externalStateSource={hostInput.externalStateSource}
        i18n={runtime.appI18n}
        layoutConstraints={layoutConstraints}
        missionControl={{
          mode: runtime.missionControl.mode,
          onRequestClose: runtime.missionControl.close
        }}
        nodes={hostInput.nodes}
        onDockEntryAction={onDockEntryAction}
        onDockEntryClick={onDockEntryClick}
        onHandleReady={onWorkbenchHostHandleReady}
        onLaunchRequest={hostInput.onLaunchRequest}
        onMissionControlAdapterReady={runtime.onMissionControlAdapterReady}
        onNodeCloseRequest={hostInput.onNodeCloseRequest}
        renderTopChrome={(chromeContext) => (
          <WorkspaceChrome
            headerSlot={headerSlot}
            launchNode={chromeContext.launchNode}
            missionControl={runtime.missionControl}
            onSelectWallpaper={runtime.selectWallpaper}
            onSelectWallpaperDisplayMode={runtime.selectWallpaperDisplayMode}
            platform={state.platform}
            selectedWallpaperDisplayMode={runtime.selectedWallpaperDisplayMode}
            selectedWallpaperID={runtime.selectedWallpaperID}
            wallpaperAppearance={runtime.wallpaper.appearance}
            workbenchController={chromeContext.controller}
            workspace={state.workspace}
          />
        )}
        snapshotRepository={hostInput.snapshotRepository}
        shortcutsEnabled={runtime.shortcutsEnabled}
        wallpaper={runtime.wallpaper}
        workspaceId={hostInput.workspaceId}
      />
      <WorkspaceAppExternalBridge
        api={workspaceAppExternalApi}
        openFile={openWorkspaceAppExternalFile}
        workspaceId={state.workspace.id}
      />
      <WorkspaceLaunchpadOverlay
        dockIconStyle={runtime.dockIconStyle}
        dockPlacement={runtime.dockPlacement}
        host={workbenchHost}
        open={launchpadOpen}
        openTrigger={launchpadOpenTrigger}
        themeAppearance={runtime.themeAppearance}
        workspaceId={state.workspace.id}
        onClose={closeLaunchpad}
      />
      <WorkspaceAgentConnectingCard service={agentProviderStatusService} />
      <WorkspaceCloseGuardDialog
        request={runtime.closeDialog.request}
        onCancel={runtime.closeDialog.onCancel}
        onConfirm={runtime.closeDialog.onConfirm}
      />
    </main>
  );
}

function WorkspaceAgentConnectingCard({
  service
}: {
  service: IAgentProviderStatusService;
}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getSnapshot(),
    () => service.getSnapshot()
  );
  const pending = snapshot.pendingActions.find(
    (action) => action.actionId === "install"
  );
  if (!pending) {
    return null;
  }
  const label = resolveWorkspaceAgentGuiLabel(
    normalizeDesktopAgentGUIProvider(pending.provider)
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-50 flex justify-center">
      <div className="pointer-events-auto flex w-64 flex-col items-center gap-3 rounded-2xl border border-border bg-background px-6 py-5 text-center shadow-xl">
        <div className="text-[15px] font-semibold text-foreground">{label}</div>
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          {t("workspace.workbenchDesktop.agentProviders.installing")}
        </div>
        <LoadingIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

async function openWorkspaceFilesNode(
  host: WorkbenchHostHandle,
  request: WorkspaceFilesLaunchRequest
): Promise<boolean> {
  const nodeId = await host.launchNode({
    launchSource: request.source,
    reason: "host",
    typeId: workspaceFilesLaunchTypeId
  });
  if (!nodeId) {
    return false;
  }
  host.activateNode(
    {
      instanceId: workspaceFilesLaunchTypeId,
      typeId: workspaceFilesLaunchTypeId
    },
    {
      payload: {
        path: request.path
      },
      type: "reveal-file"
    }
  );
  return true;
}

async function openWorkspaceIssueManagerNode(
  host: WorkbenchHostHandle,
  request: WorkspaceIssueManagerLaunchRequest
): Promise<boolean> {
  const nodeId = await host.launchNode({
    launchSource: "agent_command",
    reason: "host",
    typeId: defaultIssueManagerWorkbenchTypeId
  });
  if (!nodeId) {
    return false;
  }
  if (!request.issueId) {
    return true;
  }

  const payload: IssueManagerOpenActivationPayload = {
    issueId: request.issueId,
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.outputDir ? { outputDir: request.outputDir } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.topicId ? { topicId: request.topicId } : {})
  };
  host.activateNode(
    { nodeId },
    {
      payload,
      type: issueManagerOpenActivationType
    }
  );
  return true;
}

async function openWorkspaceBrowserNode(
  host: WorkbenchHostHandle,
  request: WorkspaceBrowserLaunchRequest
): Promise<boolean> {
  const existingNodeId =
    request.reuseIfOpen === false
      ? null
      : resolveCurrentWorkspaceBrowserNodeId(host);
  const nodeId =
    existingNodeId ??
    (await host.launchNode({
      launchSource: request.source,
      reason: "host",
      typeId: workspaceBrowserNodeID
    }));
  if (!nodeId) {
    return false;
  }

  host.activateNode(
    { nodeId },
    {
      payload: {
        url: request.url
      },
      type: "open-url"
    }
  );
  return true;
}

function resolveCurrentWorkspaceBrowserNodeId(
  host: WorkbenchHostHandle
): string | null {
  const snapshot = host.getSnapshot();
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const nodeId of [...snapshot.nodeStack].reverse()) {
    const node = nodesById.get(nodeId);
    if (node?.data.typeId === workspaceBrowserNodeID) {
      return node.id;
    }
  }

  return (
    snapshot.nodes.find((node) => node.data.typeId === workspaceBrowserNodeID)
      ?.id ?? null
  );
}

function WorkspaceCloseGuardDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: WorkbenchHostCloseDialogRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (request === null) {
    return null;
  }

  return (
    <ConfirmationDialog
      cancelLabel={request.cancelLabel}
      confirmLabel={request.confirmLabel}
      description={request.description}
      open={true}
      title={request.title}
      tone={request.variant === "destructive" ? "destructive" : "default"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
      onConfirm={onConfirm}
    >
      {request.details ? (
        <div className="whitespace-pre-wrap">{request.details}</div>
      ) : null}
    </ConfirmationDialog>
  );
}

interface WorkspaceFallbackStateProps {
  description: string;
  isLoading?: boolean;
  onRetry?: () => void;
  title: string;
  tone?: "default" | "destructive";
}

function WorkspaceFallbackState({
  description,
  isLoading = false,
  onRetry,
  title,
  tone = "default"
}: WorkspaceFallbackStateProps) {
  const { t } = useTranslation();

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-7">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-3xl items-center justify-center">
        <div className="flex max-w-3xl flex-col items-center text-center">
          <div
            className={cn(
              "text-primary",
              tone === "destructive" && "text-[var(--state-danger)]"
            )}
          >
            {isLoading ? (
              <LoadingIcon className="size-9 animate-spin" />
            ) : (
              <WarningLinedIcon className="size-9" />
            )}
          </div>
          <div className="mt-6 flex flex-col items-center gap-3">
            <CardTitle className="text-3xl tracking-tight">{title}</CardTitle>
            <CardDescription className="text-[15px] text-muted-foreground">
              {description}
            </CardDescription>
            {onRetry ? (
              <Button
                className="mt-3 h-10 rounded-lg px-4"
                type="button"
                onClick={onRetry}
              >
                {t("workspace.fallback.retryAction")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
