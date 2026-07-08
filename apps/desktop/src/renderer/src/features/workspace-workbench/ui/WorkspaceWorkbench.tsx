import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  defaultIssueManagerWorkbenchTypeId,
  issueManagerOpenActivationType,
  type IssueManagerOpenActivationPayload
} from "@tutti-os/workspace-issue-manager/workbench";
import {
  isEditableShortcutTarget,
  type WorkbenchHostCloseDialogRequest,
  type WorkbenchContribution,
  type WorkbenchHostHandle,
  type WorkbenchHostDockEntry,
  type WorkbenchWindowManagementConfig,
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
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import {
  AgentEnvPanel,
  DesktopAgentProviderManageDialog,
  IAgentProviderStatusService,
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import {
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { useService } from "@tutti-os/infra/di";
import { useTranslation } from "@renderer/i18n";
import { translate } from "@renderer/i18n/appRuntime";
import { cn } from "@renderer/lib/format";
import { Toast } from "@renderer/lib/toast";
import {
  createWorkspaceAgentGuiUnifiedDraftLaunchRequest,
  createWorkspaceAgentGuiUnifiedSessionLaunchRequest
} from "../services/workspaceAgentGuiLaunch.ts";
import {
  resolveWorkspaceAgentChatProvider,
  resolveWorkspaceAgentProviderLaunchIntent
} from "../services/workspaceOpenFeatureRequest.ts";
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
import { registerWorkspaceWorkbenchNodeLaunchHandler } from "../services/workspaceWorkbenchNodeLaunchCoordinator.ts";
import {
  buildGroupChatDeepLinkUrl,
  registerGroupChatLaunchHandler,
  type GroupChatLaunchRequest
} from "../services/groupChatLaunchCoordinator.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center/services/workspaceAppCenterService.interface";
import {
  findWorkspaceApp,
  workspaceAppWebviewTypeID
} from "@renderer/features/workspace-app-center";
import {
  workspaceLaunchpadDockActionId,
  workspaceLaunchpadDockEntryId
} from "../services/workspaceLaunchpadModel.ts";
import { requestWorkspaceMessageCenterOpen } from "../services/workspaceMessageCenterCoordinator.ts";
import {
  workspaceBrowserNodeID,
  workspaceFilesNodeID
} from "../services/workspaceWorkbenchNodeIds.ts";
import { WorkspaceChrome } from "./WorkspaceChrome";
import { WorkspaceAppExternalBridge } from "./WorkspaceAppExternalBridge";
import { WorkspaceLaunchpadOverlay } from "./WorkspaceLaunchpadOverlay.tsx";
import {
  StandaloneAgentWindow,
  type StandaloneAgentWindowProps
} from "./StandaloneAgentWindow.tsx";
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime";
import { useWorkspaceOnboardingAutoOpen } from "./useWorkspaceOnboardingAutoOpen.ts";
import { resolveWorkspaceWorkbenchLayoutConstraints } from "./workspaceWorkbenchLayoutConstraints.ts";
import type { DesktopWorkspaceAppExternalHostApi } from "@preload/types";
import type { DesktopWorkspaceAppExternalRendererEvent } from "@shared/contracts/ipc";
import type {
  TuttiExternalFileOpenInput,
  TuttiExternalWorkspaceOpenRouteIntent
} from "@tutti-os/workspace-external-core/contracts";
import {
  isFeatureEnabled,
  LAB_WORKBENCH_SHORTCUTS_FLAG
} from "../../../../../shared/featureFlags/catalog.ts";
import { resolveWorkbenchShortcutAction } from "../services/workspaceWorkbenchShortcutService.ts";
import {
  openWorkspaceWorkbenchAgentConversationShortcut,
  openWorkspaceWorkbenchSameTypeWindowShortcut
} from "../services/workspaceWorkbenchShortcutActions.ts";

const temporaryWorkspaceAppDockRetentionActionPrefix =
  "temporary-workspace-app-dock-retention:";

interface WorkspaceWorkbenchProps {
  agentWindowInput?: Omit<StandaloneAgentWindowProps, "workspace">;
  enableWindowCloseGuard: boolean;
  headerSlot?: React.ReactNode;
  routeView: string;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceID: string | null;
}
export function WorkspaceWorkbench({
  agentWindowInput,
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

  if (routeView === "agent" && agentWindowInput) {
    return (
      <StandaloneAgentWindow
        {...agentWindowInput}
        workspace={state.workspace}
      />
    );
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
  const [temporaryDockRetentionByEntryId, setTemporaryDockRetentionByEntryId] =
    useState<Record<string, boolean>>({});
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [launchpadOpenTrigger, setLaunchpadOpenTrigger] =
    useState<WorkspaceLaunchpadOpenTrigger>("dock");
  const [agentProviderManageDialogOpen, setAgentProviderManageDialogOpen] =
    useState(false);
  const [
    agentProviderManageFocusedProvider,
    setAgentProviderManageFocusedProvider
  ] = useState<WorkspaceAgentProvider | null>(null);
  const layoutConstraints = useMemo(
    () => resolveWorkspaceWorkbenchLayoutConstraints(runtime.dockPlacement),
    [runtime.dockPlacement]
  );
  const unregisterAgentGuiLaunchRef = useRef<(() => void) | null>(null);
  const unregisterBrowserLaunchRef = useRef<(() => void) | null>(null);
  const unregisterFilesLaunchRef = useRef<(() => void) | null>(null);
  const unregisterIssueManagerLaunchRef = useRef<(() => void) | null>(null);
  const unregisterGroupChatLaunchRef = useRef<(() => void) | null>(null);
  const unregisterWorkbenchNodeLaunchRef = useRef<(() => void) | null>(null);
  const closeLaunchpad = useCallback(() => {
    setLaunchpadOpen(false);
  }, []);
  const openWorkspaceAppExternalFile = useCallback(
    async (input: TuttiExternalFileOpenInput) => {
      if (!workbenchHost) {
        throw new Error("Workspace host is unavailable.");
      }
      const opened = await openWorkspaceFilesNode(
        workbenchHost,
        {
          path: input.path,
          workspaceId: state.workspace.id
        },
        runtime.workspaceFileManagerService
      );
      if (!opened) {
        throw new Error("Workspace files could not be opened.");
      }
    },
    [runtime.workspaceFileManagerService, state.workspace.id, workbenchHost]
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
      if (
        request.actionId.startsWith(
          temporaryWorkspaceAppDockRetentionActionPrefix
        )
      ) {
        const entry = findTemporaryDockRetentionEntry({
          contributions: hostInput.contributions,
          dockEntries: hostInput.dockEntries,
          entryId: request.entryId
        });
        setTemporaryDockRetentionByEntryId((current) => {
          const retained =
            current[request.entryId] ??
            (entry
              ? resolveTemporaryDockRetentionDefault({
                  appCenterService,
                  entry
                })
              : false);
          return {
            ...current,
            [request.entryId]: !retained
          };
        });
        return;
      }
      return hostInput.onDockEntryAction?.(request);
    },
    [
      appCenterService,
      hostInput.contributions,
      hostInput.dockEntries,
      hostInput.onDockEntryAction
    ]
  );
  const contributions = useMemo(
    () =>
      hostInput.contributions?.map((contribution) =>
        resolveTemporaryDockRetentionContribution({
          appCenterService,
          contribution,
          retainedByEntryId: temporaryDockRetentionByEntryId
        })
      ),
    [appCenterService, hostInput.contributions, temporaryDockRetentionByEntryId]
  );
  const dockEntries = useMemo(
    () =>
      hostInput.dockEntries?.map((entry) =>
        resolveTemporaryDockRetentionEntry({
          appCenterService,
          entry,
          retainedByEntryId: temporaryDockRetentionByEntryId
        })
      ),
    [appCenterService, hostInput.dockEntries, temporaryDockRetentionByEntryId]
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
      unregisterGroupChatLaunchRef.current?.();
      unregisterGroupChatLaunchRef.current = null;
      unregisterWorkbenchNodeLaunchRef.current?.();
      unregisterWorkbenchNodeLaunchRef.current = null;

      if (!host) {
        return;
      }

      unregisterAgentGuiLaunchRef.current =
        registerWorkspaceAgentGuiLaunchHandler(
          state.workspace.id,
          async ({
            agentSessionId,
            agentTargetId,
            autoSubmit,
            draftPrompt,
            openInNewWindow,
            provider,
            userProjectPath
          }) => {
            const normalizedDraftPrompt = draftPrompt?.trim() ?? "";
            await host.launchNode(
              normalizedDraftPrompt
                ? createWorkspaceAgentGuiUnifiedDraftLaunchRequest({
                    agentTargetId,
                    autoSubmit,
                    draftPrompt: normalizedDraftPrompt,
                    openInNewWindow,
                    provider,
                    userProjectPath
                  })
                : createWorkspaceAgentGuiUnifiedSessionLaunchRequest({
                    agentTargetId,
                    agentSessionId,
                    openInNewWindow,
                    provider
                  })
            );
          }
        );
      unregisterFilesLaunchRef.current = registerWorkspaceFilesLaunchHandler(
        state.workspace.id,
        async (request) => {
          return openWorkspaceFilesNode(
            host,
            request,
            runtime.workspaceFileManagerService
          );
        }
      );
      unregisterIssueManagerLaunchRef.current =
        registerWorkspaceIssueManagerLaunchHandler(
          state.workspace.id,
          async (request) => {
            return openWorkspaceIssueManagerNode(host, request);
          }
        );
      unregisterGroupChatLaunchRef.current = registerGroupChatLaunchHandler(
        state.workspace.id,
        async (request) => {
          return openGroupChatNode(host, appCenterService, request);
        }
      );
      unregisterBrowserLaunchRef.current =
        registerWorkspaceBrowserLaunchHandler(
          state.workspace.id,
          async (request) => {
            return openWorkspaceBrowserNode(host, request);
          }
        );
      unregisterWorkbenchNodeLaunchRef.current =
        registerWorkspaceWorkbenchNodeLaunchHandler(
          state.workspace.id,
          async (request) => {
            const shouldPrepublishIntent =
              shouldPublishWorkspaceAppLaunchIntentBeforeLaunch({
                appCenterService,
                payload: request.payload,
                typeId: request.typeId
              });
            if (shouldPrepublishIntent) {
              publishWorkspaceAppLaunchIntent({
                api: workspaceAppExternalApi,
                payload: request.payload,
                typeId: request.typeId,
                workspaceId: state.workspace.id
              });
            }
            const nodeId = await host.launchNode({
              ...(request.dockEntryId
                ? { dockEntryId: request.dockEntryId }
                : {}),
              ...(request.launchSource
                ? { launchSource: request.launchSource }
                : {}),
              payload: request.payload,
              reason: "host",
              typeId: request.typeId
            });
            if (nodeId && !shouldPrepublishIntent) {
              publishWorkspaceAppLaunchIntent({
                api: workspaceAppExternalApi,
                payload: request.payload,
                typeId: request.typeId,
                workspaceId: state.workspace.id
              });
            }
            return nodeId !== null;
          }
        );
    },
    [appCenterService, runtime, state.workspace.id, workspaceAppExternalApi]
  );
  const windowManagement = useMemo<WorkbenchWindowManagementConfig>(
    () => ({
      edgeSnapEnabled: runtime.workbenchWindowSnapping.enabled,
      shortcutPreset: runtime.workbenchWindowSnapping.enabled
        ? runtime.workbenchWindowSnapping.shortcutPreset
        : null
    }),
    [runtime.workbenchWindowSnapping]
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
      unregisterGroupChatLaunchRef.current?.();
      unregisterGroupChatLaunchRef.current = null;
      unregisterWorkbenchNodeLaunchRef.current?.();
      unregisterWorkbenchNodeLaunchRef.current = null;
    };
  }, []);

  useEffect(() => {
    setLaunchpadOpen(false);
    setAgentProviderManageDialogOpen(false);
    setAgentProviderManageFocusedProvider(null);
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
      if (request.feature === "agent-manage") {
        setAgentProviderManageFocusedProvider(
          isDesktopAgentGUIProvider(request.provider) ? request.provider : null
        );
        setAgentProviderManageDialogOpen(true);
        return;
      }
      if (request.feature === "agent-chat") {
        // “已绑定，去使用”：优先打开请求指定的 provider，再回退到默认 provider。
        const snapshot = agentProviderStatusService.getSnapshot();
        const preferred = resolveWorkspaceAgentChatProvider({
          defaultProvider: snapshot.defaultProvider,
          requestedProvider: request.provider
        });
        void (async () => {
          await agentProviderStatusService
            .ensureLoaded({ providers: [preferred] })
            .catch(() => null);
          const intent = resolveWorkspaceAgentProviderLaunchIntent(
            agentProviderStatusService.getStatus(preferred)
          );
          if (intent.kind === "launch") {
            await requestWorkspaceAgentGuiLaunch({
              provider: preferred,
              workspaceId,
              ...(request.draftPrompt?.trim()
                ? {
                    autoSubmit: request.autoSubmit === true,
                    draftPrompt: request.draftPrompt.trim()
                  }
                : {})
            });
            return;
          }
          if (intent.kind === "action") {
            await agentProviderStatusService.runAction(
              preferred,
              intent.actionId,
              {
                workbenchHost,
                workspaceId
              }
            );
          }
        })().catch(() => {});
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
        const intent = resolveWorkspaceAgentProviderLaunchIntent(
          targetStatus ?? null
        );
        if (intent.kind === "launch") {
          void requestWorkspaceAgentGuiLaunch({
            provider,
            workspaceId
          }).catch(() => {});
          return;
        }
        if (intent.kind === "action" && targetStatus) {
          void agentProviderStatusService
            .runAction(targetStatus.provider, intent.actionId, {
              workbenchHost,
              workspaceId
            })
            .catch(() => {});
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

  useWorkspaceOnboardingAutoOpen({
    appCenterService,
    workbenchHost,
    workbenchHostService: runtime.workbenchHostService,
    workspaceId: state.workspace.id
  });

  useEffect(() => {
    const broadcastAgentBound = () => {
      const snapshot = agentProviderStatusService.getSnapshot();
      const agentBound = snapshot.statuses.some(
        (s) => s.availability.status === "ready"
      );
      runtime.workbenchHostService.broadcastAgentStatus({ agentBound });
    };
    broadcastAgentBound();
    return agentProviderStatusService.subscribe(broadcastAgentBound);
  }, [agentProviderStatusService, runtime.workbenchHostService]);

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

  useEffect(() => {
    if (
      !workbenchHost ||
      !runtime.shortcutsEnabled ||
      !isFeatureEnabled(runtime.featureFlags, LAB_WORKBENCH_SHORTCUTS_FLAG)
    ) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        isEditableShortcutTarget(event.target)
      ) {
        return;
      }
      const action = resolveWorkbenchShortcutAction(
        event,
        runtime.workbenchShortcuts
      );
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === "new-agent-conversation") {
        void openWorkspaceWorkbenchAgentConversationShortcut({
          defaultProvider: normalizeDesktopAgentGUIProvider(
            runtime.defaultAgentProvider
          ),
          host: workbenchHost,
          workspaceId: state.workspace.id
        });
        return;
      }
      void openWorkspaceWorkbenchSameTypeWindowShortcut({
        defaultProvider: normalizeDesktopAgentGUIProvider(
          runtime.defaultAgentProvider
        ),
        host: workbenchHost
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    runtime.featureFlags,
    runtime.workbenchShortcuts,
    runtime.shortcutsEnabled,
    runtime.defaultAgentProvider,
    state.workspace.id,
    workbenchHost
  ]);

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
        contributions={contributions}
        debugDiagnostics={hostInput.debugDiagnostics}
        dockPreviewCache={hostInput.dockPreviewCache}
        dockPlacement={runtime.dockPlacement}
        dockEntries={dockEntries}
        dockStateSource={hostInput.dockStateSource}
        externalStateSource={hostInput.externalStateSource}
        i18n={runtime.appI18n}
        layoutConstraints={layoutConstraints}
        missionControl={{
          mode: runtime.missionControl.mode,
          nodeIds: runtime.missionControl.nodeIds ?? undefined,
          onRequestClose: runtime.missionControl.close
        }}
        minimizeAnimation={runtime.minimizeAnimation}
        nodes={hostInput.nodes}
        onDockEntryAction={onDockEntryAction}
        onDockEntryClick={onDockEntryClick}
        onHandleReady={onWorkbenchHostHandleReady}
        onLaunchRequest={hostInput.onLaunchRequest}
        onMissionControlAdapterReady={runtime.onMissionControlAdapterReady}
        onMissionControlRequestOpen={(mode, request) => {
          runtime.missionControl.open(
            mode,
            request
              ? {
                  nodeIds: request.nodeIds,
                  trigger:
                    request.trigger === "dock-context-menu"
                      ? "button"
                      : undefined
                }
              : "button"
          );
        }}
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
        windowManagement={windowManagement}
        workspaceId={hostInput.workspaceId}
      />
      <WorkspaceAppExternalBridge
        api={workspaceAppExternalApi}
        openFile={openWorkspaceAppExternalFile}
        workspaceId={state.workspace.id}
      />
      <DesktopAgentProviderManageDialog
        agentProviderStatusService={agentProviderStatusService}
        focusedProvider={agentProviderManageFocusedProvider}
        open={agentProviderManageDialogOpen}
        workbenchHost={workbenchHost}
        workspaceId={state.workspace.id}
        onOpenChange={setAgentProviderManageDialogOpen}
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
      <WorkspaceCloseGuardDialog
        request={runtime.closeDialog.request}
        onCancel={runtime.closeDialog.onCancel}
        onConfirm={runtime.closeDialog.onConfirm}
      />
      <AgentEnvPanel
        agentProviderStatusService={agentProviderStatusService}
        workspaceId={state.workspace.id}
        workbenchHost={workbenchHost ?? undefined}
      />
    </main>
  );
}

function resolveTemporaryDockRetentionEntry({
  appCenterService,
  entry,
  retainedByEntryId
}: {
  appCenterService: IWorkspaceAppCenterService;
  entry: WorkbenchHostDockEntry;
  retainedByEntryId: Readonly<Record<string, boolean>>;
}): WorkbenchHostDockEntry {
  if (
    entry.id === workspaceLaunchpadDockEntryId ||
    entry.id === workspaceFilesNodeID
  ) {
    return entry;
  }
  const retained =
    retainedByEntryId[entry.id] ??
    resolveTemporaryDockRetentionDefault({ appCenterService, entry });
  return {
    ...entry,
    dockRetention: {
      actionId: `${temporaryWorkspaceAppDockRetentionActionPrefix}${encodeURIComponent(entry.id)}`,
      retained
    },
    visibility: retained ? "always" : "when-open"
  };
}

function resolveTemporaryDockRetentionContribution({
  appCenterService,
  contribution,
  retainedByEntryId
}: {
  appCenterService: IWorkspaceAppCenterService;
  contribution: WorkbenchContribution;
  retainedByEntryId: Readonly<Record<string, boolean>>;
}): WorkbenchContribution {
  if (!contribution.dockEntries?.length) {
    return contribution;
  }
  return {
    ...contribution,
    dockEntries: contribution.dockEntries.map((entry) =>
      resolveTemporaryDockRetentionEntry({
        appCenterService,
        entry,
        retainedByEntryId
      })
    )
  };
}

function resolveTemporaryDockRetentionDefault({
  appCenterService,
  entry
}: {
  appCenterService: IWorkspaceAppCenterService;
  entry: WorkbenchHostDockEntry;
}): boolean {
  const appId = readWorkspaceAppIdFromDockEntryId(entry.id);
  const app = appId ? findWorkspaceApp(appCenterService, appId) : null;
  return app?.installed ?? (entry.visibility ?? "always") === "always";
}

function findTemporaryDockRetentionEntry({
  contributions,
  dockEntries,
  entryId
}: {
  contributions: readonly WorkbenchContribution[] | undefined;
  dockEntries: readonly WorkbenchHostDockEntry[] | undefined;
  entryId: string;
}): WorkbenchHostDockEntry | null {
  return (
    dockEntries?.find((entry) => entry.id === entryId) ??
    contributions
      ?.flatMap((contribution) => contribution.dockEntries ?? [])
      .find((entry) => entry.id === entryId) ??
    null
  );
}

function readWorkspaceAppIdFromDockEntryId(
  value: string | null | undefined
): string | null {
  const prefix = "workspace-app:";
  return value?.startsWith(prefix)
    ? decodeURIComponent(value.slice(prefix.length))
    : null;
}

function publishWorkspaceAppLaunchIntent(input: {
  api: DesktopWorkspaceAppExternalHostApi | undefined;
  payload: unknown;
  typeId: string;
  workspaceId: string;
}): void {
  if (!input.api || input.typeId !== workspaceAppWebviewTypeID) {
    return;
  }
  const event = readWorkspaceAppLaunchIntentEvent(
    input.payload,
    input.workspaceId
  );
  if (!event) {
    return;
  }
  input.api.sendEvent(event);
}

function readWorkspaceAppLaunchIntentEvent(
  payload: unknown,
  workspaceId: string
): DesktopWorkspaceAppExternalRendererEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const appId = typeof record.appId === "string" ? record.appId.trim() : "";
  const intent = readWorkspaceAppOpenRouteIntent(record.intent);
  if (!appId || !intent) {
    return null;
  }
  return {
    appId,
    intent,
    type: "workspace.launchIntent",
    workspaceId
  };
}

function readWorkspaceAppOpenRouteIntent(
  value: unknown
): TuttiExternalWorkspaceOpenRouteIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "open-route" || typeof record.route !== "string") {
    return null;
  }
  const route = record.route.trim();
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://")
  ) {
    return null;
  }
  return {
    kind: "open-route",
    ...(isStringRecord(record.params) ? { params: record.params } : {}),
    route,
    ...(isRecord(record.state) ? { state: record.state } : {})
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldPublishWorkspaceAppLaunchIntentBeforeLaunch(input: {
  appCenterService: IWorkspaceAppCenterService;
  payload: unknown;
  typeId: string;
}): boolean {
  if (input.typeId !== workspaceAppWebviewTypeID) {
    return false;
  }
  const event = readWorkspaceAppLaunchIntentEvent(input.payload, "workspace");
  const app =
    event?.type === "workspace.launchIntent"
      ? findWorkspaceApp(input.appCenterService, event.appId)
      : null;
  return app?.runtimeStatus === "installed_pending_restart";
}

async function openWorkspaceFilesNode(
  host: WorkbenchHostHandle,
  request: WorkspaceFilesLaunchRequest,
  workspaceFileManagerService: IWorkspaceFileManagerService
): Promise<boolean> {
  if (
    request.validateExists &&
    !(await workspaceFileManagerService.entryExists({
      path: request.path,
      workspaceID: request.workspaceId
    }))
  ) {
    // The requested path doesn't exist on this machine (e.g. an imported
    // historical session's recorded working directory has since been deleted
    // or moved — see resolveExternalImportSessionCwd on the import side,
    // which deliberately keeps such sessions instead of dropping them). Surface
    // this instead of silently doing nothing, which previously looked like the
    // Files panel simply refused to open with no explanation.
    Toast.Error(
      translate("workspace.workbenchDesktop.filesLaunch.openFailedTitle"),
      translate("workspace.workbenchDesktop.filesLaunch.openFailedDescription")
    );
    return false;
  }

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
        ...(request.mode ? { mode: request.mode } : {}),
        path: request.path
      },
      type: "reveal-file"
    }
  );
  return true;
}

async function openGroupChatNode(
  host: WorkbenchHostHandle,
  appCenterService: IWorkspaceAppCenterService,
  request: GroupChatLaunchRequest
): Promise<boolean> {
  const app = findWorkspaceApp(appCenterService, "group-chat");
  const launchUrl = app?.launchUrl?.trim() ?? "";
  if (!launchUrl) {
    return false;
  }

  const nodeId = await host.launchNode({
    launchSource: "agent_command",
    payload: { appId: "group-chat" },
    reason: "host",
    typeId: workspaceAppWebviewTypeID
  });
  if (!nodeId) {
    return false;
  }

  const deepLinkUrl = buildGroupChatDeepLinkUrl(launchUrl, request);
  if (deepLinkUrl === launchUrl) {
    return true;
  }

  host.activateNode(
    { nodeId },
    {
      payload: {
        appId: "group-chat",
        url: deepLinkUrl
      },
      type: "open-url"
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
