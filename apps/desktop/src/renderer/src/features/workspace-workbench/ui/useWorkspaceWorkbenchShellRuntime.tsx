import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { AgentGUIProvider, AgentGUIAgent } from "@tutti-os/agent-gui";
import { useService } from "@tutti-os/infra/di";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchDockPlacement,
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlMode
} from "@tutti-os/workbench-surface";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import {
  resolveWorkspaceAppDisplayName,
  useWorkspaceAppCenterService,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "@renderer/features/workspace-app-center";
import { IReporterService } from "@renderer/features/analytics";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager/ui/useWorkspaceFileManagerService";
import { useTranslation } from "@renderer/i18n";
import { createWorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import type {
  DesktopDockIconStyle,
  DesktopFeatureFlags,
  DesktopMinimizeAnimation,
  DesktopWorkbenchShortcuts
} from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import { createWorkspaceFilePreviewLaunchRequest } from "../services/workspaceFilePreviewLaunch";
import { requestWorkspaceFilesLaunch } from "../services/workspaceFilesLaunchCoordinator";
import { classifyWorkspaceFilePreviewKind } from "@tutti-os/workspace-file-preview";
import type { WorkbenchSurfaceWallpaperFit } from "@tutti-os/workbench-surface";
import type { DesktopWorkbenchWindowSnapping } from "@shared/preferences";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";
import {
  createWorkspaceWorkbenchShellRuntimeController,
  type WorkspaceWorkbenchShellRuntimeController
} from "../services/workspaceWorkbenchShellRuntimeController";
import type { WorkspaceWorkbenchCapabilitySettingsTarget } from "../services/workspaceWorkbenchHostService.interface";
import type {
  WorkspaceMissionControlOpenRequest,
  WorkspaceMissionControlTrigger
} from "../services/workspaceMissionControlController.ts";
import { renderWorkspaceFilesNodeBody } from "./WorkspaceFilesNodeBody";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { workspaceOnboardingAppId } from "../services/workspaceOnboarding.ts";
import { filterWorkspaceAgentGuiAgents } from "./workspaceAgentGuiAgentFilter.ts";

export interface WorkspaceWorkbenchShellRuntime {
  appI18n: I18nRuntime<string>;
  closeDialog: {
    onCancel: () => void;
    onConfirm: () => void;
    request: WorkbenchHostCloseDialogRequest | null;
  };
  defaultAgentTargetId: string | null;
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: WorkbenchDockPlacement;
  defaultAgentProvider: WorkspaceAgentProvider;
  featureFlags: DesktopFeatureFlags;
  minimizeAnimation: DesktopMinimizeAnimation;
  hostInput: ReturnType<
    WorkspaceWorkbenchShellRuntimeController["getSnapshot"]
  >["hostInput"];
  missionControl: {
    canOpen: boolean;
    close: () => void;
    isOpen: boolean;
    mode: WorkbenchMissionControlMode | null;
    nodeIds: readonly string[] | null;
    open: (
      mode: WorkbenchMissionControlMode,
      request?:
        | WorkspaceMissionControlOpenRequest
        | WorkspaceMissionControlTrigger
    ) => void;
    visibleWindowCount: number;
  };
  onMissionControlAdapterReady: (
    adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null
  ) => void;
  onWorkbenchHostHandleReady: (host: WorkbenchHostHandle | null) => void;
  selectWallpaper: (wallpaperId: WorkspaceWallpaperId) => void;
  selectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  shortcutsEnabled: boolean;
  themeAppearance: DesktopThemeAppearance;
  wallpaper: {
    appearance: "light" | "dark";
    fit: WorkbenchSurfaceWallpaperFit;
    url: string;
  };
  workspaceFileManagerService: ReturnType<
    typeof useWorkspaceFileManagerService
  >;
  workbenchShortcuts: DesktopWorkbenchShortcuts;
  workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
  workbenchHostService: ReturnType<typeof useWorkspaceWorkbenchHostService>;
}

export function useWorkspaceWorkbenchShellRuntime({
  enableWindowCloseGuard,
  state
}: {
  enableWindowCloseGuard: boolean;
  state: {
    platform: NodeJS.Platform;
    workspace: WorkspaceSummary;
  };
}): WorkspaceWorkbenchShellRuntime {
  const { i18n: appI18n, locale } = useTranslation();
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const { service: workspaceSettingsService, state: workspaceSettingsState } =
    useWorkspaceSettingsService();
  const workspaceFileManagerService = useWorkspaceFileManagerService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [agentGuiAgents, setAgentGuiAgents] = useState<
    readonly AgentGUIAgent[] | undefined
  >(undefined);
  const agentGuiAgentsLoading = agentGuiAgents === undefined;
  // The daemon /agents directory is the complete new-entry source of truth.
  const resolvedAgentGuiAgents = useMemo(() => {
    if (!agentGuiAgents) {
      return [];
    }
    return filterWorkspaceAgentGuiAgents(agentGuiAgents, {
      tuttiAgentSwitchEnabled:
        workspaceSettingsState.tuttiAgentSwitchEnabled === true
    });
  }, [agentGuiAgents, workspaceSettingsState.tuttiAgentSwitchEnabled]);
  const comingSoonAgentProviders = useMemo<readonly AgentGUIProvider[]>(
    () => [
      ...(desktopPreferencesState.enableCursorAgent ? [] : ["cursor" as const]),
      ...(desktopPreferencesState.enableOpenCodeAgent
        ? []
        : ["opencode" as const])
    ],
    [
      desktopPreferencesState.enableCursorAgent,
      desktopPreferencesState.enableOpenCodeAgent
    ]
  );
  const defaultAgentTargetId = useMemo(
    () =>
      resolveDefaultAgentTargetId({
        defaultProvider: desktopPreferencesState.defaultAgentProvider,
        agents: resolvedAgentGuiAgents
      }),
    [desktopPreferencesState.defaultAgentProvider, resolvedAgentGuiAgents]
  );
  const reporterService = useService(IReporterService);
  const wallpaperRevision = useSyncExternalStore(
    (listener) => workbenchHostService.subscribeWallpaperChanges(listener),
    () => workbenchHostService.getWallpaperRevision(),
    () => workbenchHostService.getWallpaperRevision()
  );
  const workbenchDesktopI18n = useMemo(
    () => createWorkspaceWorkbenchDesktopI18nRuntime(appI18n),
    [appI18n]
  );
  const handleCapabilitySettingsRequest = useCallback(
    (target: WorkspaceWorkbenchCapabilitySettingsTarget) => {
      workspaceSettingsService.openPanel(
        { id: state.workspace.id },
        {
          anchor: target === "computerUse" ? "computer-use" : "browser-use",
          section: "general"
        }
      );
    },
    [state.workspace.id, workspaceSettingsService]
  );
  const shellRuntimeControllerRef =
    useRef<WorkspaceWorkbenchShellRuntimeController | null>(null);
  const workbenchHostRef = useRef<WorkbenchHostHandle | null>(null);
  if (!shellRuntimeControllerRef.current) {
    shellRuntimeControllerRef.current =
      createWorkspaceWorkbenchShellRuntimeController({
        hostInput: {
          appI18n,
          appLocale: locale,
          appCenterRevision: appCenterState.revision,
          createHostInput: (hostInput) =>
            workbenchHostService.createHostInput(hostInput),
          defaultAgentProvider: desktopPreferencesState.defaultAgentProvider,
          defaultAgentTargetId: defaultAgentTargetId,
          agents: resolvedAgentGuiAgents,
          agentsLoading: agentGuiAgentsLoading,
          comingSoonAgentProviders,
          dockIconStyle: desktopPreferencesState.dockIconStyle,
          i18n: workbenchDesktopI18n,
          onCapabilitySettingsRequest: handleCapabilitySettingsRequest,
          renderFilesNodeBody: renderWorkspaceFilesNodeBody,
          requestWindowClose: (request) =>
            workbenchHostService.requestWindowClose(request),
          themeAppearance: desktopPreferencesState.theme.appearance,
          workspaceId: state.workspace.id
        },
        reporterService,
        wallpaperSelection: {
          appearance: desktopPreferencesState.theme.appearance,
          customWallpaperUrl: workbenchHostService.getCustomWallpaperUrl(),
          readDisplayMode: (workspaceId) =>
            workbenchHostService.readWallpaperDisplayMode(workspaceId),
          readWallpaperId: (workspaceId) =>
            workbenchHostService.readWallpaperId(workspaceId),
          workspaceId: state.workspace.id,
          writeDisplayMode: (workspaceId, displayMode) => {
            workbenchHostService.writeWallpaperDisplayMode(
              workspaceId,
              displayMode
            );
          },
          writeWallpaperId: (workspaceId, wallpaperId) => {
            workbenchHostService.writeWallpaperId(workspaceId, wallpaperId);
          }
        }
      });
  }
  const shellRuntimeController = shellRuntimeControllerRef.current;
  const shellRuntimeSnapshot = useSyncExternalStore(
    shellRuntimeController.subscribe,
    shellRuntimeController.getSnapshot,
    shellRuntimeController.getSnapshot
  );

  useEffect(() => {
    shellRuntimeController.updateWallpaperSelection({
      appearance: desktopPreferencesState.theme.appearance,
      customWallpaperUrl: workbenchHostService.getCustomWallpaperUrl(),
      readDisplayMode: (workspaceId) =>
        workbenchHostService.readWallpaperDisplayMode(workspaceId),
      readWallpaperId: (workspaceId) =>
        workbenchHostService.readWallpaperId(workspaceId),
      workspaceId: state.workspace.id,
      writeDisplayMode: (workspaceId, displayMode) => {
        workbenchHostService.writeWallpaperDisplayMode(
          workspaceId,
          displayMode
        );
      },
      writeWallpaperId: (workspaceId, wallpaperId) => {
        workbenchHostService.writeWallpaperId(workspaceId, wallpaperId);
      }
    });
  }, [
    desktopPreferencesState.theme.appearance,
    shellRuntimeController,
    state.workspace.id,
    wallpaperRevision,
    workbenchHostService
  ]);

  useEffect(() => {
    void workbenchHostService.ensureAgentProviderStatusesLoaded();
  }, [state.workspace.id, workbenchHostService]);

  useEffect(() => {
    let disposed = false;
    setAgentGuiAgents(undefined);
    const loadAgents = () => {
      void workbenchHostService
        .loadAgentGuiAgents()
        .then((targets) => {
          if (!disposed) {
            setAgentGuiAgents(targets);
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
    // comingSoonAgentProviders: the provider gate disables gated targets in
    // the daemon target list, so a gate flip must reload it (the host service
    // cache is invalidated by the same preference change).
  }, [comingSoonAgentProviders, state.workspace.id, workbenchHostService]);

  useEffect(() => {
    return workbenchHostService.onOpenFileRequest((request) => {
      const host = workbenchHostRef.current;
      if (!host || request.workspaceId !== state.workspace.id) {
        return;
      }

      if (request.mode === "reveal") {
        void requestWorkspaceFilesLaunch({
          homeDirectory: workbenchHostService.getHomeDirectory(),
          path: request.absolutePath,
          workspaceId: request.workspaceId
        });
        return;
      }

      const fileKind = classifyWorkspaceFilePreviewKind({
        kind: "file",
        name: request.name,
        path: request.absolutePath
      });
      if (!fileKind || request.mode === "auto") {
        void requestWorkspaceFilesLaunch({
          homeDirectory: workbenchHostService.getHomeDirectory(),
          path: request.absolutePath,
          workspaceId: request.workspaceId
        });
        return;
      }

      void host.launchNode(
        createWorkspaceFilePreviewLaunchRequest({
          fileKind,
          mtimeMs: request.mtimeMs,
          name: request.name,
          path: request.absolutePath,
          sizeBytes: request.sizeBytes
        })
      );
    });
  }, [state.workspace.id, workbenchHostService]);

  useEffect(() => {
    shellRuntimeController.updateHostInput({
      appI18n,
      appLocale: locale,
      appCenterRevision: appCenterState.revision,
      createHostInput: (hostInput) =>
        workbenchHostService.createHostInput(hostInput),
      defaultAgentProvider: desktopPreferencesState.defaultAgentProvider,
      defaultAgentTargetId: defaultAgentTargetId,
      agents: resolvedAgentGuiAgents,
      agentsLoading: agentGuiAgentsLoading,
      comingSoonAgentProviders,
      dockIconStyle: desktopPreferencesState.dockIconStyle,
      i18n: workbenchDesktopI18n,
      onCapabilitySettingsRequest: handleCapabilitySettingsRequest,
      renderFilesNodeBody: renderWorkspaceFilesNodeBody,
      requestWindowClose: (request) =>
        workbenchHostService.requestWindowClose(request),
      themeAppearance: desktopPreferencesState.theme.appearance,
      workspaceId: state.workspace.id
    });
  }, [
    appI18n,
    appCenterState.revision,
    agentGuiAgentsLoading,
    comingSoonAgentProviders,
    defaultAgentTargetId,
    resolvedAgentGuiAgents,
    desktopPreferencesState.defaultAgentProvider,
    desktopPreferencesState.dockIconStyle,
    desktopPreferencesState.theme.appearance,
    handleCapabilitySettingsRequest,
    locale,
    shellRuntimeController,
    state.workspace.id,
    workbenchDesktopI18n,
    workbenchHostService
  ]);

  useEffect(() => {
    syncWorkspaceAppWebviewNodes({
      apps: appCenterState.apps,
      canCloseUnavailableApps:
        appCenterState.loadStatus === "ready" &&
        appCenterState.workspaceId === state.workspace.id,
      host: workbenchHostRef.current,
      locale
    });
  }, [
    appCenterState.apps,
    appCenterState.loadStatus,
    appCenterState.workspaceId,
    locale,
    state.workspace.id
  ]);

  useEffect(() => {
    return shellRuntimeController.dispose;
  }, [shellRuntimeController.dispose]);

  useEffect(() => {
    return () => {
      workspaceFileManagerService.setCanvasFilePreviewLauncher(
        state.workspace.id,
        null
      );
    };
  }, [state.workspace.id, workspaceFileManagerService]);

  useEffect(() => {
    if (!enableWindowCloseGuard) {
      return;
    }

    return workbenchHostService.onWindowCloseRequest((payload) => {
      void shellRuntimeController
        .requestWindowClose({
          reason: payload.reason
        })
        .then((outcome) => {
          if (payload.requestId) {
            workbenchHostService.resolveWindowCloseRequest({
              outcome,
              requestId: payload.requestId
            });
          }
        });
    });
  }, [enableWindowCloseGuard, shellRuntimeController, workbenchHostService]);

  const handleWorkbenchHostReady = useCallback(
    (host: WorkbenchHostHandle | null) => {
      workbenchHostRef.current = host;
      shellRuntimeController.setWorkbenchHost(host);
      syncWorkspaceAppWebviewNodes({
        apps: appCenterState.apps,
        canCloseUnavailableApps:
          appCenterState.loadStatus === "ready" &&
          appCenterState.workspaceId === state.workspace.id,
        host,
        locale
      });
      workspaceFileManagerService.setCanvasFilePreviewLauncher(
        state.workspace.id,
        host
          ? async (target) =>
              (await host.launchNode(
                createWorkspaceFilePreviewLaunchRequest(target)
              )) !== null
          : null
      );
      appCenterService.setWorkspaceAppLauncher(
        host
          ? async ({ appId, intent, prepared, prevStatus }) => {
              return (
                (await host.launchNode({
                  payload: {
                    appId,
                    ...(intent ? { intent } : {}),
                    prepared,
                    prevStatus
                  },
                  reason: "host",
                  typeId: workspaceAppWebviewTypeID,
                  // 让 onboarding 应用打开时播放“从底部进入并展开”的动画。
                  ...(appId === workspaceOnboardingAppId
                    ? { launchSource: "onboarding-auto" }
                    : {})
                })) !== null
              );
            }
          : null
      );
      appCenterService.setWorkspaceAppViewCloser(
        host ? (input) => closeWorkspaceAppWebviews(host, input.appId) : null
      );
      appCenterService.setWorkspaceAppViewOpenChecker(
        host
          ? (input) =>
              input.workspaceId === state.workspace.id &&
              isWorkspaceAppWebviewOpen(host, input.appId)
          : null
      );
    },
    [
      appCenterService,
      appCenterState.apps,
      appCenterState.loadStatus,
      appCenterState.workspaceId,
      locale,
      shellRuntimeController,
      state.workspace.id,
      workspaceFileManagerService
    ]
  );

  return {
    appI18n,
    closeDialog: {
      onCancel: shellRuntimeController.closeDialog.cancel,
      onConfirm: shellRuntimeController.closeDialog.confirm,
      request: shellRuntimeSnapshot.closeDialog.request
    },
    defaultAgentTargetId,
    dockIconStyle: desktopPreferencesState.dockIconStyle,
    dockPlacement: desktopPreferencesState.dockPlacement,
    defaultAgentProvider: desktopPreferencesState.defaultAgentProvider,
    featureFlags: desktopPreferencesState.featureFlags,
    hostInput: shellRuntimeSnapshot.hostInput,
    missionControl: {
      canOpen: shellRuntimeSnapshot.missionControl.canOpen,
      close: shellRuntimeController.missionControl.close,
      isOpen: shellRuntimeSnapshot.missionControl.isOpen,
      mode: shellRuntimeSnapshot.missionControl.mode,
      nodeIds: shellRuntimeSnapshot.missionControl.nodeIds,
      open: shellRuntimeController.missionControl.open,
      visibleWindowCount: shellRuntimeSnapshot.missionControl.visibleWindowCount
    },
    minimizeAnimation: desktopPreferencesState.minimizeAnimation,
    onMissionControlAdapterReady:
      shellRuntimeController.missionControl.setAdapter,
    onWorkbenchHostHandleReady: handleWorkbenchHostReady,
    selectWallpaper: shellRuntimeController.wallpaperSelection.selectWallpaper,
    selectWallpaperDisplayMode:
      shellRuntimeController.wallpaperSelection.selectDisplayMode,
    selectedWallpaperDisplayMode:
      shellRuntimeSnapshot.wallpaperSelection.displayMode,
    selectedWallpaperID:
      shellRuntimeSnapshot.wallpaperSelection.selectedWallpaperID,
    shortcutsEnabled: shellRuntimeSnapshot.missionControl.shortcutsEnabled,
    themeAppearance: desktopPreferencesState.theme.appearance,
    wallpaper: {
      appearance: shellRuntimeSnapshot.wallpaperSelection.wallpaper.appearance,
      fit: shellRuntimeSnapshot.wallpaperSelection.wallpaper.fit,
      url: shellRuntimeSnapshot.wallpaperSelection.wallpaper.url
    },
    workspaceFileManagerService,
    workbenchShortcuts: desktopPreferencesState.workbenchShortcuts,
    workbenchWindowSnapping: desktopPreferencesState.workbenchWindowSnapping,
    workbenchHostService
  };
}

function resolveDefaultAgentTargetId(input: {
  agents?: readonly AgentGUIAgent[];
  defaultProvider?: string | null;
}): string | null {
  const defaultProvider = input.defaultProvider?.trim() ?? "";
  const agents = input.agents ?? [];
  return (
    agents.find(
      (agent) =>
        defaultProvider !== "" &&
        agent.provider === defaultProvider &&
        agent.availability.status === "ready"
    )?.agentTargetId ??
    agents.find((agent) => agent.availability.status === "ready")
      ?.agentTargetId ??
    null
  );
}

function closeWorkspaceAppWebviews(
  host: WorkbenchHostHandle,
  appId: string
): void {
  const instanceId = workspaceAppWebviewInstanceId(appId);
  for (const node of host.getSnapshot().nodes) {
    if (
      node.data.typeId === workspaceAppWebviewTypeID &&
      node.data.instanceId === instanceId
    ) {
      host.closeNode(node.id);
    }
  }
}

function isWorkspaceAppWebviewOpen(
  host: WorkbenchHostHandle,
  appId: string
): boolean {
  const instanceId = workspaceAppWebviewInstanceId(appId);
  return host
    .getSnapshot()
    .nodes.some(
      (node) =>
        node.data.typeId === workspaceAppWebviewTypeID &&
        node.data.instanceId === instanceId
    );
}

function syncWorkspaceAppWebviewNodes(input: {
  apps: readonly WorkspaceAppCenterApp[];
  canCloseUnavailableApps: boolean;
  host: WorkbenchHostHandle | null;
  locale: "en" | "zh-CN";
}): void {
  if (!input.host) {
    return;
  }

  const appByInstanceId = new Map(
    input.apps.map((app) => [workspaceAppWebviewInstanceId(app.appId), app])
  );
  for (const node of input.host.getSnapshot().nodes) {
    if (node.data.typeId !== workspaceAppWebviewTypeID) {
      continue;
    }
    const app = appByInstanceId.get(node.data.instanceId);
    if (!app || !app.installed) {
      if (input.canCloseUnavailableApps) {
        input.host.closeNode(node.id);
      }
      continue;
    }
    input.host.setNodeTitle(
      node.id,
      resolveWorkspaceAppDisplayName(app, input.locale)
    );
    input.host.setNodeSizeConstraints(node.id, null);
  }
}
