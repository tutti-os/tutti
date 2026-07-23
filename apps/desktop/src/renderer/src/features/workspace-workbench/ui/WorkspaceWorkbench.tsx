import type * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { defaultIssueManagerWorkbenchTypeId } from "@tutti-os/workspace-issue-manager/workbench";
import {
  isEditableShortcutTarget,
  type WorkbenchContribution,
  type WorkbenchHostDockEntry,
  type WorkbenchHostDockEntryPresentationOverride,
  type WorkbenchHostDockEntryPresentationOverrides,
  type WorkbenchHostHandle,
  type WorkbenchWindowManagementConfig,
  WorkbenchHost
} from "@tutti-os/workbench-surface";
import {
  useWorkspaceAppCenterService,
  WorkspaceAppCenterIntegration,
  workspaceAppCenterNodeID
} from "@renderer/features/workspace-app-center";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import { AgentEnvPanel } from "@renderer/features/workspace-agent/ui/AgentEnvPanel.tsx";
import { DesktopAgentProviderManageDialog } from "@renderer/features/workspace-agent/ui/DesktopAgentProviderManageDialog.tsx";
import { IAgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { IAgentEnvService } from "@renderer/features/workspace-agent/services/agentEnvService.interface.ts";
import {
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { registerWorkspaceTerminalLoginLaunchHandler } from "@renderer/features/workspace-agent/services/workspaceTerminalLoginLaunchCoordinator.ts";
import {
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { useService } from "@tutti-os/infra/di";
import { RichTextMentionServiceProvider } from "@tutti-os/ui-rich-text/editor";
import {
  createDesktopRichTextMentionService,
  IDesktopRichTextAtService
} from "@renderer/features/rich-text-at";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import {
  createWorkspaceAgentGuiDraftLaunchRequest,
  createWorkspaceAgentGuiSessionLaunchRequest
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
import { showWorkspaceFileMissingToast } from "../services/workspaceFilesLaunchFeedback.ts";
import { registerWorkspaceIssueManagerLaunchPresenter } from "../services/workspaceIssueManagerLaunchCoordinator.ts";
import { createWorkbenchWorkspaceIssueManagerPresenter } from "../services/workbenchWorkspaceIssueManagerPresenter.ts";
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
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { WorkspaceCloseGuardDialog } from "./WorkspaceCloseGuardDialog.tsx";
import { WorkspaceFallbackState } from "./WorkspaceFallbackState.tsx";
import type { WorkspaceWorkbenchHostSessionBinding } from "../services/workspaceWorkbenchHostService.interface.ts";
import { useWorkspaceOnboardingAutoOpen } from "./useWorkspaceOnboardingAutoOpen.ts";
import { resolveWorkspaceWorkbenchLayoutConstraints } from "./workspaceWorkbenchLayoutConstraints.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "../services/workspaceWorkbenchNodeIds.ts";
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

const workspaceDockRetentionActionPrefix = "workspace-dock-retention:";

interface WorkspaceWorkbenchProps {
  enableWindowCloseGuard: boolean;
  headerSlot?: React.ReactNode;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceID: string | null;
}
export function WorkspaceWorkbench({
  enableWindowCloseGuard,
  headerSlot,
  workspaceAppExternalApi,
  workspaceID
}: WorkspaceWorkbenchProps) {
  const { service, state } = useWorkspaceCatalogService();
  const { t } = useTranslation();
  const loadWorkspaceWindow = useCallback(() => {
    void service.loadWorkspaceWindow(workspaceID, "workspace");
  }, [service, workspaceID]);

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

interface ReadyWorkspaceWorkbenchProps {
  enableWindowCloseGuard: boolean;
  headerSlot?: React.ReactNode;
  state: {
    platform: NodeJS.Platform;
    workspace: WorkspaceSummary;
  };
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
}

function ReadyWorkspaceWorkbench(props: ReadyWorkspaceWorkbenchProps) {
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const workspaceId = props.state.workspace.id;
  const [hostSession, setHostSession] =
    useState<WorkspaceWorkbenchHostSessionBinding | null>(null);

  useLayoutEffect(() => {
    const binding = workbenchHostService.openHostSession(workspaceId);
    setHostSession(binding);
    return () => {
      binding.release();
    };
  }, [workbenchHostService, workspaceId]);

  if (
    !hostSession ||
    !hostSession.isActive ||
    hostSession.workspaceId !== workspaceId
  ) {
    return <main className="h-screen min-h-0 bg-background" />;
  }

  return (
    <ReadyWorkspaceWorkbenchWithSession
      {...props}
      key={hostSession.bindingId}
      hostSession={hostSession}
    />
  );
}

function ReadyWorkspaceWorkbenchWithSession({
  enableWindowCloseGuard,
  headerSlot,
  hostSession,
  state,
  workspaceAppExternalApi
}: ReadyWorkspaceWorkbenchProps & {
  hostSession: WorkspaceWorkbenchHostSessionBinding;
}) {
  const { service: appCenterService } = useWorkspaceAppCenterService();
  const agentsService = useService(IAgentsService);
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const richTextAtService = useService(IDesktopRichTextAtService);
  const mentionService = useMemo(
    () =>
      createDesktopRichTextMentionService({
        invalidationSources: [
          {
            selector: {
              providerId: "workspace-app",
              workspaceId: state.workspace.id
            },
            subscribe: (listener) => appCenterService.subscribe(listener)
          },
          {
            selector: {
              providerId: "agent-target",
              workspaceId: state.workspace.id
            },
            subscribe: (listener) => agentsService.subscribe(listener)
          },
          {
            debounceMs: 100,
            selector: {
              providerId: "agent-session",
              workspaceId: state.workspace.id
            },
            subscribe: (listener) =>
              workspaceAgentActivityService.subscribe(
                state.workspace.id,
                listener
              )
          }
        ],
        richTextAtService,
        workspaceId: state.workspace.id
      }),
    [
      agentsService,
      appCenterService,
      richTextAtService,
      state.workspace.id,
      workspaceAgentActivityService
    ]
  );
  useEffect(() => () => mentionService.dispose(), [mentionService]);
  const agentEnvService = useService(IAgentEnvService);
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const runtime = useWorkspaceWorkbenchShellRuntime({
    enableWindowCloseGuard,
    hostSession,
    state
  });
  const hostInput = runtime.hostInput;
  const [workbenchHost, setWorkbenchHost] =
    useState<WorkbenchHostHandle | null>(null);
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
  const unregisterTerminalLoginLaunchRef = useRef<(() => void) | null>(null);
  const releaseAgentEnvHostRef = useRef<(() => void) | null>(null);
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
      if (request.actionId.startsWith(workspaceDockRetentionActionPrefix)) {
        const entry = findWorkspaceDockRetentionEntry({
          contributions: hostInput.contributions,
          dockEntries: hostInput.dockEntries,
          entryId: request.entryId
        });
        const retained =
          runtime.dockRetentionByEntryId[request.entryId] ??
          (entry
            ? resolveWorkspaceDockRetentionDefault({
                appCenterService,
                entry
              })
            : false);
        return runtime.setDockEntryRetained(request.entryId, !retained);
      }
      return hostInput.onDockEntryAction?.(request);
    },
    [
      appCenterService,
      hostInput.contributions,
      hostInput.dockEntries,
      hostInput.onDockEntryAction,
      runtime.dockRetentionByEntryId,
      runtime.setDockEntryRetained
    ]
  );
  const dockEntryPresentationOverrides = useMemo(
    () =>
      resolveWorkspaceDockEntryPresentationOverrides({
        appCenterService,
        contributions: hostInput.contributions,
        dockEntries: hostInput.dockEntries,
        retainedByEntryId: runtime.dockRetentionByEntryId
      }),
    [
      appCenterService,
      hostInput.contributions,
      hostInput.dockEntries,
      runtime.dockRetentionByEntryId
    ]
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
      unregisterTerminalLoginLaunchRef.current?.();
      unregisterTerminalLoginLaunchRef.current = null;
      releaseAgentEnvHostRef.current?.();
      releaseAgentEnvHostRef.current = null;

      if (!host) {
        return;
      }

      releaseAgentEnvHostRef.current = agentEnvService.bindWorkbenchHost(host);

      unregisterTerminalLoginLaunchRef.current =
        registerWorkspaceTerminalLoginLaunchHandler(
          state.workspace.id,
          async ({ command, cwd }) => {
            const nodeId = await host.launchNode({
              payload: {
                cwd,
                initialInput: /[\r\n]$/u.test(command)
                  ? command
                  : `${command}\n`
              },
              reason: "host",
              typeId: defaultWorkspaceTerminalWorkbenchTypeId
            });
            if (!nodeId) {
              throw new Error("Terminal login did not open a workbench node.");
            }
            return {
              close: () => {
                host.closeNode(nodeId);
              }
            };
          }
        );

      unregisterAgentGuiLaunchRef.current =
        registerWorkspaceAgentGuiLaunchHandler(
          state.workspace.id,
          async ({
            agentSessionId,
            agentTargetId,
            autoSubmit,
            draftPrompt,
            model,
            modelPlanId,
            openInNewWindow,
            provider,
            userProjectPath
          }) => {
            const normalizedDraftPrompt = draftPrompt?.trim() ?? "";
            await host.launchNode(
              normalizedDraftPrompt
                ? createWorkspaceAgentGuiDraftLaunchRequest({
                    agentTargetId,
                    autoSubmit,
                    draftPrompt: normalizedDraftPrompt,
                    model,
                    modelPlanId,
                    openInNewWindow,
                    provider,
                    userProjectPath
                  })
                : createWorkspaceAgentGuiSessionLaunchRequest({
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
        registerWorkspaceIssueManagerLaunchPresenter(
          state.workspace.id,
          createWorkbenchWorkspaceIssueManagerPresenter({ host })
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
    [
      agentEnvService,
      appCenterService,
      runtime,
      state.workspace.id,
      workspaceAppExternalApi
    ]
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
      releaseAgentEnvHostRef.current?.();
      releaseAgentEnvHostRef.current = null;
      unregisterIssueManagerLaunchRef.current = null;
      unregisterGroupChatLaunchRef.current?.();
      unregisterGroupChatLaunchRef.current = null;
      unregisterWorkbenchNodeLaunchRef.current?.();
      unregisterWorkbenchNodeLaunchRef.current = null;
      unregisterTerminalLoginLaunchRef.current?.();
      unregisterTerminalLoginLaunchRef.current = null;
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
                context: { workbenchHost, workspaceId },
                origin: "user"
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
              context: { workbenchHost, workspaceId },
              origin: "user"
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
    <RichTextMentionServiceProvider service={mentionService}>
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
          dockEntryPresentationOverrides={dockEntryPresentationOverrides}
          dockStateSource={hostInput.dockStateSource}
          externalStateSource={hostInput.externalStateSource}
          i18n={runtime.appI18n}
          layoutConstraints={layoutConstraints}
          missionControl={{
            mode: runtime.missionControl.mode,
            nodeIds: runtime.missionControl.nodeIds ?? undefined,
            onRequestClose: runtime.missionControl.close,
            onRequestMode: (mode) => runtime.missionControl.open(mode, "button")
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
              selectedWallpaperDisplayMode={
                runtime.selectedWallpaperDisplayMode
              }
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
        <AgentEnvPanel />
      </main>
    </RichTextMentionServiceProvider>
  );
}

function resolveWorkspaceDockEntryPresentationOverrides({
  appCenterService,
  contributions,
  dockEntries,
  retainedByEntryId
}: {
  appCenterService: IWorkspaceAppCenterService;
  contributions: readonly WorkbenchContribution[] | undefined;
  dockEntries: readonly WorkbenchHostDockEntry[] | undefined;
  retainedByEntryId: Readonly<Record<string, boolean>>;
}): WorkbenchHostDockEntryPresentationOverrides {
  const overrides = new Map<
    string,
    WorkbenchHostDockEntryPresentationOverride
  >();
  const entries = [
    ...(contributions?.flatMap(
      (contribution) => contribution.dockEntries ?? []
    ) ?? []),
    ...(dockEntries ?? [])
  ];
  for (const entry of entries) {
    const presentationOverride = resolveWorkspaceDockRetentionPresentation({
      appCenterService,
      entry,
      retainedByEntryId
    });
    if (presentationOverride) {
      overrides.set(entry.id, presentationOverride);
    }
  }
  return Object.fromEntries(overrides);
}

function resolveWorkspaceDockRetentionPresentation({
  appCenterService,
  entry,
  retainedByEntryId
}: {
  appCenterService: IWorkspaceAppCenterService;
  entry: WorkbenchHostDockEntry;
  retainedByEntryId: Readonly<Record<string, boolean>>;
}): WorkbenchHostDockEntryPresentationOverride | null {
  if (
    entry.id === workspaceLaunchpadDockEntryId ||
    entry.id === workspaceFilesNodeID
  ) {
    return null;
  }
  const retained =
    retainedByEntryId[entry.id] ??
    resolveWorkspaceDockRetentionDefault({ appCenterService, entry });
  return {
    dockRetention: {
      actionId: `${workspaceDockRetentionActionPrefix}${encodeURIComponent(entry.id)}`,
      retained
    },
    visibility: retained ? "always" : "when-open"
  };
}

function resolveWorkspaceDockRetentionDefault({
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

function findWorkspaceDockRetentionEntry({
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
    showWorkspaceFileMissingToast();
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
