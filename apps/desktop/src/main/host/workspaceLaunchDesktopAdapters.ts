import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import {
  classifyDesktopErrorCode,
  formatErrorMessage
} from "../../shared/errors/desktopErrors.ts";
import { getDesktopLogger } from "../logging";
import type {
  WorkspaceLaunchAdapters,
  WorkspaceLaunchResolvedAgentWindowInput,
  WorkspaceLaunchWorkspaceWindowOptions
} from "./workspaceLaunch";
import {
  createWorkspaceWindow,
  findWorkspaceWindow,
  loadAgentWindowContent,
  loadWorkspaceWindowContent
} from "../windows/workspaceWindow";
import { awaitWorkspaceWindowReady } from "./workspaceWindowReady.ts";
import type { WorkspaceLaunchWindowKind } from "./workspaceLaunchMode.ts";
import { createDurableWorkspaceWindowCoordinator } from "./durableWorkspaceWindowCoordinator.ts";
import { resolveDesktopPerformanceHeadless } from "../defaults.ts";

export interface WorkspaceLaunchDesktopAdapterOptions {
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  getDockPlacement: () => DesktopDockPlacement;
  getLocale: () => DesktopLocale;
  getTheme: () => DesktopThemeState;
  preloadPath: string;
  rendererUrl?: string;
  workspaceAppPreloadPath?: string;
}

export function createWorkspaceLaunchDesktopAdapters(
  options: WorkspaceLaunchDesktopAdapterOptions
): WorkspaceLaunchAdapters {
  const pendingAgentBrowserHosts = new Map<string, Promise<void>>();
  const performanceHeadless = resolveDesktopPerformanceHeadless();
  const durableWorkspaceWindows = createDurableWorkspaceWindowCoordinator<
    Electron.BrowserWindow,
    [WorkspaceLaunchWorkspaceWindowOptions]
  >({
    activate: (workspaceWindow) =>
      activateWorkspaceWindow(workspaceWindow, performanceHeadless),
    find: (workspaceID: string) =>
      findWorkspaceWindow(workspaceID, "workspace"),
    open: (workspaceID, windowOptions) =>
      createAndShowWorkspaceWindow(options, workspaceID, windowOptions)
  });
  return {
    async ensureAgentBrowserHost(input) {
      if (findWorkspaceWindow(input.workspaceID, "agent")) return;
      const existing = pendingAgentBrowserHosts.get(input.workspaceID);
      if (existing) return existing;
      const opening = showStandaloneAgentWindow(options, input, {
        showOnReady: false
      }).then(() => undefined);
      pendingAgentBrowserHosts.set(input.workspaceID, opening);
      try {
        await opening;
      } finally {
        if (pendingAgentBrowserHosts.get(input.workspaceID) === opening) {
          pendingAgentBrowserHosts.delete(input.workspaceID);
        }
      }
    },
    async showAgentWindow(input) {
      await showStandaloneAgentWindow(options, input);
    },

    async showWorkspaceWindow(workspaceID, input) {
      const windowKind: WorkspaceLaunchWindowKind = input.windowKind;
      try {
        if (windowKind === "agent") {
          return await showStandaloneAgentWindow(options, {
            workspaceID,
            workspaceUiMode: input.workspaceUiMode
          });
        }
        return await durableWorkspaceWindows.show(workspaceID, input);
      } catch (error) {
        getDesktopLogger().warn("failed to show workspace window", {
          error: formatErrorMessage(error),
          error_code: classifyDesktopErrorCode(error),
          window_kind: windowKind,
          workspace_id: workspaceID
        });
        throw error;
      }
    },

    warnStartupWindowResolutionFailure(error) {
      getDesktopLogger().warn("failed to resolve startup desktop window", {
        error: formatErrorMessage(error),
        error_code: classifyDesktopErrorCode(error)
      });
    }
  };
}

async function createAndShowWorkspaceWindow(
  options: WorkspaceLaunchDesktopAdapterOptions,
  workspaceID: string,
  windowOptions: WorkspaceLaunchWorkspaceWindowOptions
): Promise<Electron.BrowserWindow> {
  const workspaceWindow = createWorkspaceWindow({
    browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
    enableDevelopmentReloadShortcut:
      options.enableDevelopmentReloadShortcut === true,
    locale: options.getLocale(),
    preloadPath: options.preloadPath,
    rendererUrl: options.rendererUrl,
    theme: options.getTheme(),
    workspaceAppPreloadPath: options.workspaceAppPreloadPath,
    workspaceID
  });
  await awaitWorkspaceWindowReady(
    workspaceWindow,
    () => {
      loadWorkspaceWindowContent(workspaceWindow, {
        dockPlacement: options.getDockPlacement(),
        locale: options.getLocale(),
        rendererUrl: options.rendererUrl,
        theme: options.getTheme(),
        workspaceUiMode: windowOptions.workspaceUiMode,
        workspaceID
      });
    },
    { showInactive: resolveDesktopPerformanceHeadless() }
  );
  return workspaceWindow;
}

function activateWorkspaceWindow(
  workspaceWindow: Electron.BrowserWindow,
  performanceHeadless: boolean
): void {
  if (workspaceWindow.isMinimized()) {
    workspaceWindow.restore();
  }
  if (!workspaceWindow.isVisible()) {
    if (performanceHeadless) {
      workspaceWindow.showInactive();
    } else {
      workspaceWindow.show();
    }
  }
  if (!performanceHeadless) {
    workspaceWindow.focus();
  }
}

async function showStandaloneAgentWindow(
  options: WorkspaceLaunchDesktopAdapterOptions,
  input: WorkspaceLaunchResolvedAgentWindowInput,
  readyOptions: { showOnReady?: boolean } = {}
): Promise<Electron.BrowserWindow> {
  const agentWindow = createWorkspaceWindow({
    browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
    enableDevelopmentReloadShortcut:
      options.enableDevelopmentReloadShortcut === true,
    locale: options.getLocale(),
    preloadPath: options.preloadPath,
    rendererUrl: options.rendererUrl,
    theme: options.getTheme(),
    openerBounds: input.openerBounds,
    openerWindowKind: input.openerWindowKind,
    offsetFromSourceWindow: input.offsetFromSourceWindow,
    windowKind: "agent",
    workspaceAppPreloadPath: options.workspaceAppPreloadPath,
    workspaceID: input.workspaceID
  });
  await awaitWorkspaceWindowReady(
    agentWindow,
    () => {
      loadAgentWindowContent(agentWindow, {
        agentDirectorySnapshot: input.agentDirectorySnapshot,
        agentSessionID: input.agentSessionID,
        agentTargetID: input.agentTargetID,
        autoSubmit: input.autoSubmit,
        dockPlacement: options.getDockPlacement(),
        draftPrompt: input.draftPrompt,
        locale: options.getLocale(),
        providerStatusSnapshot: input.providerStatusSnapshot,
        provider: input.provider,
        rendererUrl: options.rendererUrl,
        theme: options.getTheme(),
        userProjectPath: input.userProjectPath,
        workspaceUiMode: input.workspaceUiMode,
        workspaceID: input.workspaceID
      });
    },
    {
      maximizeOnShow: false,
      showOnReady: readyOptions.showOnReady,
      showInactive: resolveDesktopPerformanceHeadless()
    }
  );
  return agentWindow;
}
