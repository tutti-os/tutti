import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import {
  classifyDesktopErrorCode,
  formatErrorMessage
} from "../../shared/errors/desktopErrors.ts";
import { getDesktopLogger } from "../logging";
import type { WorkspaceLaunchAdapters } from "./workspaceLaunch";
import {
  createWorkspaceWindow,
  loadAgentWindowContent,
  loadWorkspaceWindowContent
} from "../windows/workspaceWindow";
import { awaitWorkspaceWindowReady } from "./workspaceWindowReady.ts";

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
  return {
    async showAgentWindow(input) {
      const agentWindow = createWorkspaceWindow({
        browserNodeGuestPreloadPath: options.browserNodeGuestPreloadPath,
        enableDevelopmentReloadShortcut:
          options.enableDevelopmentReloadShortcut === true,
        locale: options.getLocale(),
        preloadPath: options.preloadPath,
        rendererUrl: options.rendererUrl,
        theme: options.getTheme(),
        windowKind: "agent",
        workspaceAppPreloadPath: options.workspaceAppPreloadPath,
        workspaceID: input.workspaceID
      });
      await awaitWorkspaceWindowReady(
        agentWindow,
        () => {
          loadAgentWindowContent(agentWindow, {
            agentSessionID: input.agentSessionID,
            agentTargetID: input.agentTargetID,
            dockPlacement: options.getDockPlacement(),
            locale: options.getLocale(),
            providerStatusSnapshot: input.providerStatusSnapshot,
            agents: input.agents,
            provider: input.provider,
            rendererUrl: options.rendererUrl,
            theme: options.getTheme(),
            workspaceID: input.workspaceID
          });
        },
        { maximizeOnShow: false }
      );
    },

    async showWorkspaceWindow(workspaceID) {
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
    },

    warnStartupWindowResolutionFailure(error) {
      getDesktopLogger().warn("failed to resolve startup desktop window", {
        error: formatErrorMessage(error),
        error_code: classifyDesktopErrorCode(error)
      });
    }
  };
}
