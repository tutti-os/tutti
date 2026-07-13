import type { BrowserWindow, MessageBoxOptions } from "electron";
import { isFusionModeEnabled } from "../shared/featureFlags/catalog.ts";
import { createTranslator, type DesktopLocale } from "../shared/i18n/index.ts";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import { createFusionModeRestartController } from "./fusionModeRestartController.ts";
import type { DesktopLogger } from "./logging.ts";

type ShowMessageBox = (
  options: MessageBoxOptions
) => Promise<{ response: number }>;

export interface DesktopFusionModeRestartCoordinator {
  dispose(): void;
}

export interface DesktopFusionModeRestartCoordinatorOptions {
  currentProcessModeActive: boolean;
  getLocale(): DesktopLocale;
  logger: Pick<DesktopLogger, "info" | "warn">;
  preferences: Pick<
    DesktopHostPreferencesState,
    "getFeatureFlags" | "subscribe"
  >;
  quit?: () => void;
  readPersistedMode(): Promise<boolean>;
  relaunch?: () => void;
  showMessageBox?: ShowMessageBox;
}

export function connectDesktopFusionModeRestartCoordinator(
  options: DesktopFusionModeRestartCoordinatorOptions
): DesktopFusionModeRestartCoordinator {
  const controller = createFusionModeRestartController({
    currentProcessModeActive: options.currentProcessModeActive,
    onError(error) {
      options.logger.warn("failed to coordinate Fusion Mode restart", {
        error: error instanceof Error ? error.message : String(error)
      });
    },
    prompt: (targetModeActive) => showRestartPrompt(options, targetModeActive),
    readPersistedMode: options.readPersistedMode,
    restart: async () => {
      options.logger.info("restarting Tutti to apply Fusion Mode preference", {
        currentProcessModeActive: options.currentProcessModeActive
      });
      if (options.relaunch && options.quit) {
        options.relaunch();
        options.quit();
        return;
      }
      const { app } = await import("electron");
      app.relaunch();
      app.quit();
    }
  });
  const observeCurrentPreference = () => {
    controller.observePersistedMode(
      isFusionModeEnabled(options.preferences.getFeatureFlags())
    );
  };
  const unsubscribe = options.preferences.subscribe(observeCurrentPreference);
  observeCurrentPreference();

  return {
    dispose() {
      unsubscribe();
      controller.dispose();
    }
  };
}

async function showRestartPrompt(
  options: DesktopFusionModeRestartCoordinatorOptions,
  targetModeActive: boolean
): Promise<"later" | "restart"> {
  const translator = createTranslator(options.getLocale());
  const showMessageBox = options.showMessageBox ?? defaultShowMessageBox;
  const result = await showMessageBox({
    buttons: [
      translator.t("desktop.fusion.modeRestart.restartAction"),
      translator.t("desktop.fusion.modeRestart.laterAction")
    ],
    cancelId: 1,
    defaultId: 0,
    detail: translator.t(
      targetModeActive
        ? "desktop.fusion.modeRestart.enableDetail"
        : "desktop.fusion.modeRestart.disableDetail"
    ),
    message: translator.t(
      targetModeActive
        ? "desktop.fusion.modeRestart.enableMessage"
        : "desktop.fusion.modeRestart.disableMessage"
    ),
    noLink: true,
    title: translator.t("desktop.fusion.modeRestart.title"),
    type: "question"
  });
  return result.response === 0 ? "restart" : "later";
}

function defaultShowMessageBox(
  options: MessageBoxOptions
): Promise<{ response: number }> {
  return import("electron").then(({ app, BrowserWindow, dialog }) => {
    const ownerWindow = resolveFusionModeRestartPromptOwner(
      BrowserWindow.getFocusedWindow(),
      BrowserWindow.getAllWindows()
    );

    // A parentless NSAlert can be created behind the active BrowserWindow on
    // macOS. It then blocks the main run loop while looking as though the Labs
    // toggle did nothing. This prompt is caused by a direct user action, so it
    // is appropriate to activate Tutti and attach the alert to that window.
    app.focus({ steal: true });
    if (!ownerWindow) {
      return dialog.showMessageBox(options);
    }
    if (ownerWindow.isMinimized()) {
      ownerWindow.restore();
    }
    ownerWindow.show();
    ownerWindow.focus();
    return dialog.showMessageBox(ownerWindow, options);
  });
}

export function resolveFusionModeRestartPromptOwner(
  focusedWindow: BrowserWindow | null,
  windows: readonly BrowserWindow[]
): BrowserWindow | null {
  if (focusedWindow && !focusedWindow.isDestroyed()) {
    return focusedWindow;
  }
  return (
    windows.find((window) => !window.isDestroyed() && window.isVisible()) ??
    null
  );
}
