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
  WorkspaceLaunchAgentWindowInput
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

export interface WorkspaceLaunchDesktopAdapterOptions {
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  getDockPlacement: () => DesktopDockPlacement;
  getLocale: () => DesktopLocale;
  getPrimaryWorkspaceWindowKind: () => WorkspaceLaunchWindowKind;
  getTheme: () => DesktopThemeState;
  preloadPath: string;
  rendererUrl?: string;
  workspaceAppPreloadPath?: string;
}

export function createWorkspaceLaunchDesktopAdapters(
  options: WorkspaceLaunchDesktopAdapterOptions
): WorkspaceLaunchAdapters {
  const durableWorkspaceWindows = createDurableWorkspaceWindowCoordinator({
    activate: activateWorkspaceWindow,
    find: (workspaceID: string) =>
      findWorkspaceWindow(workspaceID, "workspace"),
    open: (workspaceID: string) =>
      createAndShowWorkspaceWindow(options, workspaceID)
  });
  return {
    async showAgentWindow(input) {
      await showStandaloneAgentWindow(options, input);
    },

    async showWorkspaceWindow(workspaceID, input) {
      const windowKind =
        input?.windowKind ?? options.getPrimaryWorkspaceWindowKind();
      if (windowKind === "agent") {
        return await showStandaloneAgentWindow(options, { workspaceID });
      }
      return await durableWorkspaceWindows.show(workspaceID);
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
  workspaceID: string
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
  await awaitWorkspaceWindowReady(workspaceWindow, () => {
    loadWorkspaceWindowContent(workspaceWindow, {
      dockPlacement: options.getDockPlacement(),
      locale: options.getLocale(),
      rendererUrl: options.rendererUrl,
      theme: options.getTheme(),
      workspaceID
    });
  });
  return workspaceWindow;
}

function activateWorkspaceWindow(
  workspaceWindow: Electron.BrowserWindow
): void {
  if (workspaceWindow.isMinimized()) {
    workspaceWindow.restore();
  }
  if (!workspaceWindow.isVisible()) {
    workspaceWindow.show();
  }
  workspaceWindow.focus();
}

async function showStandaloneAgentWindow(
  options: WorkspaceLaunchDesktopAdapterOptions,
  input: WorkspaceLaunchAgentWindowInput
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
        workspaceID: input.workspaceID
      });
    },
    { maximizeOnShow: false }
  );
  return agentWindow;
}
