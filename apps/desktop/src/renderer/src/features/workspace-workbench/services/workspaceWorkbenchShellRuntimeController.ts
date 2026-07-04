import type { ReactNode } from "react";
import type { AgentGUIProviderTarget } from "@tutti-os/agent-gui";
import type {
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter,
  WorkbenchMissionControlMode
} from "@tutti-os/workbench-surface";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import type {
  DesktopAgentDockLayout,
  DesktopDockIconStyle
} from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { createWorkspaceCloseGuardDialogController } from "./internal/workspaceCloseGuardDialogController.ts";
import {
  createWorkspaceMissionControlController,
  type WorkspaceMissionControlOpenRequest,
  type WorkspaceMissionControlTrigger
} from "./internal/workspaceMissionControlController.ts";
import { createWorkspaceWallpaperSelectionController } from "./internal/workspaceWallpaperSelectionController.ts";
import { createWorkspaceWindowCloseRequestController } from "./internal/workspaceWindowCloseRequestController.ts";
import type {
  IWorkspaceWorkbenchHostService,
  WorkspaceWorkbenchBodyRendererContext,
  WorkspaceWorkbenchCapabilitySettingsTarget,
  WorkspaceWorkbenchHostInput
} from "./workspaceWorkbenchHostService.interface";
import type { WorkbenchSurfaceWallpaperFit } from "@tutti-os/workbench-surface";
import type {
  WorkspaceWallpaperAppearance,
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "./workspaceWallpaper";

export interface WorkspaceWorkbenchShellRuntimeControllerSnapshot {
  closeDialog: WorkspaceWorkbenchShellCloseDialogSnapshot;
  hostInput: WorkspaceWorkbenchHostInput;
  missionControl: WorkspaceWorkbenchShellMissionControlSnapshot;
  wallpaperSelection: WorkspaceWorkbenchShellWallpaperSelectionSnapshot;
}

export interface WorkspaceWorkbenchShellCloseDialogSnapshot {
  request: WorkbenchHostCloseDialogRequest | null;
}

export interface WorkspaceWorkbenchShellMissionControlSnapshot {
  canOpen: boolean;
  isOpen: boolean;
  mode: WorkbenchMissionControlMode | null;
  nodeIds: readonly string[] | null;
  shortcutsEnabled: boolean;
  visibleWindowCount: number;
}

export interface WorkspaceWorkbenchShellWallpaperSelectionSnapshot {
  displayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  wallpaper: {
    appearance: WorkspaceWallpaperAppearance;
    fit: WorkbenchSurfaceWallpaperFit;
    url: string;
  };
}

export interface WorkspaceWorkbenchWallpaperSelectionInput {
  appearance: WorkspaceWallpaperAppearance;
  customWallpaperUrl: string | null;
  readDisplayMode(workspaceId: string): WorkspaceWallpaperDisplayMode;
  readWallpaperId(workspaceId: string): WorkspaceWallpaperId;
  workspaceId: string;
  writeDisplayMode(
    workspaceId: string,
    displayMode: WorkspaceWallpaperDisplayMode
  ): void;
  writeWallpaperId(
    workspaceId: string,
    wallpaperId: WorkspaceWallpaperId
  ): void;
}

export interface WorkspaceWorkbenchShellRuntimeController {
  closeDialog: {
    cancel: () => void;
    confirm: () => void;
    requestConfirmation: (
      request: WorkbenchHostCloseDialogRequest
    ) => Promise<boolean>;
  };
  dispose: () => void;
  getSnapshot: () => WorkspaceWorkbenchShellRuntimeControllerSnapshot;
  missionControl: {
    close: () => void;
    open: (
      mode: WorkbenchMissionControlMode,
      request?:
        | WorkspaceMissionControlOpenRequest
        | WorkspaceMissionControlTrigger
    ) => void;
    setAdapter: (
      adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null
    ) => void;
  };
  requestWindowClose: (
    input?: Pick<
      Parameters<IWorkspaceWorkbenchHostService["requestWindowClose"]>[0],
      "reason"
    >
  ) => Promise<"approved" | "blocked">;
  setWorkbenchHost: (host: WorkbenchHostHandle | null) => void;
  subscribe: (listener: () => void) => () => void;
  updateHostInput: (input: WorkspaceWorkbenchShellHostInput) => void;
  updateWallpaperSelection: (
    input: WorkspaceWorkbenchWallpaperSelectionInput
  ) => void;
  wallpaperSelection: {
    selectDisplayMode: (displayMode: WorkspaceWallpaperDisplayMode) => void;
    selectWallpaper: (wallpaperID: WorkspaceWallpaperId) => void;
  };
}

export interface WorkspaceWorkbenchShellHostInput {
  appI18n: I18nRuntime<string>;
  agentDockLayout: DesktopAgentDockLayout;
  appCenterRevision?: number;
  createHostInput: IWorkspaceWorkbenchHostService["createHostInput"];
  defaultAgentProvider?: string | null;
  defaultProviderTargetId?: string | null;
  dockIconStyle: DesktopDockIconStyle;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  onCapabilitySettingsRequest?: (
    target: WorkspaceWorkbenchCapabilitySettingsTarget
  ) => void;
  providerTargets?: readonly AgentGUIProviderTarget[];
  providerTargetsLoading?: boolean;
  renderFilesNodeBody: (
    context: WorkspaceWorkbenchBodyRendererContext
  ) => ReactNode;
  requestWindowClose: IWorkspaceWorkbenchHostService["requestWindowClose"];
  themeAppearance: DesktopThemeAppearance;
  workspaceId: string;
}

export function createWorkspaceWorkbenchShellRuntimeController(input: {
  hostInput: WorkspaceWorkbenchShellHostInput;
  reporterService?: Pick<IReporterService, "trackEvents">;
  reporterNow?: () => number;
  wallpaperSelection: WorkspaceWorkbenchWallpaperSelectionInput;
}): WorkspaceWorkbenchShellRuntimeController {
  const closeDialog = createWorkspaceCloseGuardDialogController({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const missionControl = createWorkspaceMissionControlController({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const wallpaperSelection = createWorkspaceWallpaperSelectionController({
    ...input.wallpaperSelection,
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  let hostInput = createHostInput({
    closeDialog,
    input: input.hostInput
  });
  let currentHost: WorkbenchHostHandle | null = null;
  const windowCloseRequestController = createWindowCloseRequestController({
    closeDialog,
    hostInput,
    input: input.hostInput
  });
  const listeners = new Set<() => void>();
  let snapshot = createSnapshot({
    closeDialog,
    hostInput,
    missionControl,
    wallpaperSelection
  });

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const refreshSnapshot = () => {
    snapshot = createSnapshot({
      closeDialog,
      hostInput,
      missionControl,
      wallpaperSelection
    });
    notify();
  };
  closeDialog.subscribe(refreshSnapshot);
  missionControl.subscribe(refreshSnapshot);
  wallpaperSelection.subscribe(refreshSnapshot);

  return {
    closeDialog: {
      cancel: closeDialog.cancel,
      confirm: closeDialog.confirm,
      requestConfirmation: closeDialog.requestConfirmation
    },
    dispose: () => {
      closeDialog.dispose();
    },
    getSnapshot: () => snapshot,
    missionControl: {
      close: missionControl.close,
      open: missionControl.open,
      setAdapter: missionControl.setAdapter
    },
    requestWindowClose: (input = { reason: "window-close" }) =>
      windowCloseRequestController.requestClose(input),
    setWorkbenchHost: (host) => {
      currentHost = host;
      windowCloseRequestController.setHost(host);
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    updateHostInput: (nextInput) => {
      const nextHostInput = createHostInput({
        closeDialog,
        input: nextInput
      });
      const hostInputChanged = hostInput !== nextHostInput;
      hostInput = nextHostInput;
      windowCloseRequestController.update({
        confirmCloseGuard: closeDialog.requestConfirmation,
        hostInput,
        requestWindowClose: nextInput.requestWindowClose
      });
      windowCloseRequestController.setHost(currentHost);

      if (hostInputChanged) {
        refreshSnapshot();
      }
    },
    updateWallpaperSelection: (nextInput) => {
      wallpaperSelection.update({
        ...nextInput,
        reporterNow: input.reporterNow,
        reporterService: input.reporterService
      });
    },
    wallpaperSelection: {
      selectDisplayMode: wallpaperSelection.selectDisplayMode,
      selectWallpaper: wallpaperSelection.selectWallpaper
    }
  };
}

function createSnapshot(input: {
  closeDialog: WorkspaceCloseGuardDialogControllerInstance;
  hostInput: WorkspaceWorkbenchHostInput;
  missionControl: WorkspaceMissionControlControllerInstance;
  wallpaperSelection: WorkspaceWallpaperSelectionControllerInstance;
}): WorkspaceWorkbenchShellRuntimeControllerSnapshot {
  return {
    closeDialog: input.closeDialog.getSnapshot(),
    hostInput: input.hostInput,
    missionControl: input.missionControl.getSnapshot(),
    wallpaperSelection: input.wallpaperSelection.getSnapshot()
  };
}

function createHostInput(input: {
  closeDialog: WorkspaceCloseGuardDialogControllerInstance;
  input: WorkspaceWorkbenchShellHostInput;
}): WorkspaceWorkbenchHostInput {
  return input.input.createHostInput({
    appI18n: input.input.appI18n,
    agentDockLayout: input.input.agentDockLayout,
    appCenterRevision: input.input.appCenterRevision,
    confirmCloseGuard: input.closeDialog.requestConfirmation,
    defaultAgentProvider: input.input.defaultAgentProvider,
    defaultProviderTargetId: input.input.defaultProviderTargetId,
    dockIconStyle: input.input.dockIconStyle,
    i18n: input.input.i18n,
    onCapabilitySettingsRequest: input.input.onCapabilitySettingsRequest,
    providerTargets: input.input.providerTargets,
    providerTargetsLoading: input.input.providerTargetsLoading,
    renderFilesNodeBody: input.input.renderFilesNodeBody,
    themeAppearance: input.input.themeAppearance,
    workspaceId: input.input.workspaceId
  });
}

function createWindowCloseRequestController(input: {
  closeDialog: WorkspaceCloseGuardDialogControllerInstance;
  hostInput: WorkspaceWorkbenchHostInput;
  input: WorkspaceWorkbenchShellHostInput;
}): WorkspaceWindowCloseRequestControllerInstance {
  return createWorkspaceWindowCloseRequestController({
    confirmCloseGuard: input.closeDialog.requestConfirmation,
    hostInput: input.hostInput,
    requestWindowClose: input.input.requestWindowClose
  });
}

type WorkspaceCloseGuardDialogControllerInstance = ReturnType<
  typeof createWorkspaceCloseGuardDialogController
>;
type WorkspaceMissionControlControllerInstance = ReturnType<
  typeof createWorkspaceMissionControlController
>;
type WorkspaceWallpaperSelectionControllerInstance = ReturnType<
  typeof createWorkspaceWallpaperSelectionController
>;
type WorkspaceWindowCloseRequestControllerInstance = ReturnType<
  typeof createWorkspaceWindowCloseRequestController
>;
