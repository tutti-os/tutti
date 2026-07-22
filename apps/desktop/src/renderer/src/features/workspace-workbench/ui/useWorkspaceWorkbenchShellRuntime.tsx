import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
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
  IWorkspaceAppSurfaceHost,
  resolveWorkspaceAppDisplayName,
  useWorkspaceAppCenterService,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "@renderer/features/workspace-app-center";
import { IReporterService } from "@renderer/features/analytics";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager/ui/useWorkspaceFileManagerService";
import { IWorkspaceFilePreviewSurfaceHost } from "@renderer/features/workspace-file-preview";
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
import {
  classifyWorkspaceFilePreviewKind,
  resolveWorkspaceFileBuiltinRenderKind
} from "@tutti-os/workspace-file-preview";
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
import type {
  WorkspaceWorkbenchCapabilitySettingsTarget,
  WorkspaceWorkbenchHostSessionBinding
} from "../services/workspaceWorkbenchHostService.interface";
import type {
  WorkspaceMissionControlOpenRequest,
  WorkspaceMissionControlTrigger
} from "../services/workspaceMissionControlController.ts";
import { renderWorkspaceFilesNodeBody } from "./WorkspaceFilesNodeBody";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { createWorkbenchWorkspaceAppSurfacePresenter } from "../services/workbenchWorkspaceAppSurfacePresenter.ts";
import { createWorkbenchWorkspaceFilePreviewPresenter } from "../services/workbenchWorkspaceFilePreviewPresenter.ts";

export interface WorkspaceWorkbenchShellRuntime {
  appI18n: I18nRuntime<string>;
  closeDialog: {
    onCancel: () => void;
    onConfirm: () => void;
    request: WorkbenchHostCloseDialogRequest | null;
  };
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: WorkbenchDockPlacement;
  defaultAgentProvider: WorkspaceAgentProvider;
  dockRetentionByEntryId: Readonly<Record<string, boolean>>;
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
  onWorkbenchCloseGuardHostReady: (host: WorkbenchHostHandle | null) => void;
  requestWindowClose: () => Promise<"approved" | "blocked">;
  setDockEntryRetained: (entryId: string, retained: boolean) => Promise<void>;
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
  hostSession,
  state
}: {
  enableWindowCloseGuard: boolean;
  hostSession: WorkspaceWorkbenchHostSessionBinding;
  state: {
    platform: NodeJS.Platform;
    workspace: WorkspaceSummary;
  };
}): WorkspaceWorkbenchShellRuntime {
  const { i18n: appI18n, locale } = useTranslation();
  const { service: workspaceAppCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const agentsService = useService(IAgentsService);
  const workspaceAppSurfaceHost = useService(IWorkspaceAppSurfaceHost);
  const workspaceFilePreviewSurfaceHost = useService(
    IWorkspaceFilePreviewSurfaceHost
  );
  const workspaceFileManagerService = useWorkspaceFileManagerService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const reporterService = useService(IReporterService);
  const wallpaperRevision = useSyncExternalStore(
    (listener) => workbenchHostService.subscribeWallpaperChanges(listener),
    () => workbenchHostService.getWallpaperRevision(),
    () => workbenchHostService.getWallpaperRevision()
  );
  const dockRetentionRevision = useSyncExternalStore(
    workbenchHostService.dockRetention.subscribe,
    workbenchHostService.dockRetention.getRevision,
    workbenchHostService.dockRetention.getRevision
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
  const [workbenchHost, setWorkbenchHost] =
    useState<WorkbenchHostHandle | null>(null);
  if (!shellRuntimeControllerRef.current) {
    shellRuntimeControllerRef.current =
      createWorkspaceWorkbenchShellRuntimeController({
        hostInput: {
          appI18n,
          appLocale: locale,
          appCenterRevision: appCenterState.revision,
          createHostInput: hostSession.createHostInput,
          defaultAgentProvider: desktopPreferencesState.defaultAgentProvider,
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
    void agentsService.load().catch(() => undefined);
  }, [agentsService, state.workspace.id]);

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

      const previewKind = classifyWorkspaceFilePreviewKind({
        kind: "file",
        name: request.name,
        path: request.absolutePath
      });
      if (
        resolveWorkspaceFileBuiltinRenderKind(previewKind) === null ||
        request.mode === "auto"
      ) {
        void requestWorkspaceFilesLaunch({
          homeDirectory: workbenchHostService.getHomeDirectory(),
          path: request.absolutePath,
          workspaceId: request.workspaceId
        });
        return;
      }

      void host.launchNode(
        createWorkspaceFilePreviewLaunchRequest({
          previewKind,
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
      createHostInput: hostSession.createHostInput,
      defaultAgentProvider: desktopPreferencesState.defaultAgentProvider,
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
    desktopPreferencesState.defaultAgentProvider,
    desktopPreferencesState.dockIconStyle,
    desktopPreferencesState.theme.appearance,
    handleCapabilitySettingsRequest,
    hostSession,
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
      host: workbenchHost,
      locale
    });
  }, [
    appCenterState.apps,
    appCenterState.loadStatus,
    appCenterState.workspaceId,
    locale,
    state.workspace.id,
    workbenchHost
  ]);

  useEffect(() => {
    return shellRuntimeController.dispose;
  }, [shellRuntimeController.dispose]);

  useEffect(() => {
    if (!workbenchHost) {
      return;
    }
    return workspaceFilePreviewSurfaceHost.registerPresenter(
      state.workspace.id,
      createWorkbenchWorkspaceFilePreviewPresenter({ host: workbenchHost })
    );
  }, [state.workspace.id, workbenchHost, workspaceFilePreviewSurfaceHost]);

  useEffect(() => {
    if (!workbenchHost) {
      return;
    }
    return workspaceAppSurfaceHost.registerPresenter(
      createWorkbenchWorkspaceAppSurfacePresenter({
        getViewState: (workspaceId) =>
          workspaceAppCenterService.getViewState(workspaceId),
        host: workbenchHost,
        setViewState: (request) =>
          workspaceAppCenterService.setViewState(request),
        workspaceId: state.workspace.id
      })
    );
  }, [
    workbenchHost,
    state.workspace.id,
    workspaceAppCenterService,
    workspaceAppSurfaceHost
  ]);

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
      setWorkbenchHost(host);
      hostSession.attachSurface(host);
      shellRuntimeController.setWorkbenchHost(host);
    },
    [hostSession, shellRuntimeController]
  );
  const handleWorkbenchCloseGuardHostReady = useCallback(
    (host: WorkbenchHostHandle | null) => {
      hostSession.attachSurface(host);
      shellRuntimeController.setWorkbenchHost(host);
    },
    [hostSession, shellRuntimeController]
  );
  const setDockEntryRetained = useCallback(
    (entryId: string, retained: boolean) =>
      workbenchHostService.dockRetention.setRetained(
        state.workspace.id,
        entryId,
        retained
      ),
    [state.workspace.id, workbenchHostService]
  );
  const dockRetentionByEntryId = useMemo(
    () =>
      workbenchHostService.dockRetention.readRetainedByEntryId(
        state.workspace.id
      ),
    [dockRetentionRevision, state.workspace.id, workbenchHostService]
  );

  return {
    appI18n,
    closeDialog: {
      onCancel: shellRuntimeController.closeDialog.cancel,
      onConfirm: shellRuntimeController.closeDialog.confirm,
      request: shellRuntimeSnapshot.closeDialog.request
    },
    dockIconStyle: desktopPreferencesState.dockIconStyle,
    dockPlacement: desktopPreferencesState.dockPlacement,
    dockRetentionByEntryId,
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
    onWorkbenchCloseGuardHostReady: handleWorkbenchCloseGuardHostReady,
    requestWindowClose: () => shellRuntimeController.requestWindowClose(),
    setDockEntryRetained,
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
