import type {
  BaseWindow,
  MenuItemConstructorOptions,
  MessageBoxOptions
} from "electron";
import type { ClearDeveloperLogsResult } from "../shared/contracts/ipc.ts";
import { createTranslator, type DesktopLocale } from "../shared/i18n/index.ts";
import type { DesktopLogger } from "./logging.ts";

export interface ApplicationMenuOptions {
  allowDeveloperTools?: boolean;
  clearDeveloperLogs?: () =>
    | ClearDeveloperLogsResult
    | Promise<ClearDeveloperLogsResult>;
  exportDeveloperLogs?: () => unknown;
  getLocale?: () => DesktopLocale;
  logger?: DesktopLogger;
  openPerfMonitorDevTools?: (ownerWindow?: BaseWindow | null) => unknown;
  platform?: NodeJS.Platform;
  showMessageBox?: (options: MessageBoxOptions) => Promise<unknown>;
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === "string" ? error : "Unknown error";
}

async function runExportDeveloperLogsFromMenu(
  options: ApplicationMenuOptions
): Promise<void> {
  if (!options.exportDeveloperLogs) {
    return;
  }

  try {
    await options.exportDeveloperLogs();
    options.logger?.info("menu export logs completed");
  } catch (error) {
    const detail = formatErrorDetail(error);
    const translator = createTranslator(options.getLocale?.() ?? "en");
    options.logger?.error("menu export logs failed", { detail });
    const { dialog } = await import("electron");
    await dialog.showMessageBox({
      type: "error",
      title: translator.t("desktop.menu.exportLogsTitle"),
      message: translator.t("desktop.menu.exportLogsFailed"),
      detail
    });
  }
}

async function runClearDeveloperLogsFromMenu(
  options: ApplicationMenuOptions
): Promise<void> {
  if (!options.clearDeveloperLogs) {
    return;
  }

  try {
    const result = await options.clearDeveloperLogs();
    const translator = createTranslator(options.getLocale?.() ?? "en");
    const showMessageBox =
      options.showMessageBox ??
      (async (messageBoxOptions: MessageBoxOptions) => {
        const { dialog } = await import("electron");
        await dialog.showMessageBox(messageBoxOptions);
      });

    await showMessageBox({
      buttons: [translator.t("common.ok")],
      detail: translator.t("desktop.menu.clearLogsCompletedDetail", {
        count: String(result.clearedFiles)
      }),
      message: translator.t("desktop.menu.clearLogsCompletedMessage"),
      title: translator.t("desktop.menu.clearLogsTitle"),
      type: "info"
    });
    options.logger?.info("menu clear logs completed");
  } catch (error) {
    const detail = formatErrorDetail(error);
    const translator = createTranslator(options.getLocale?.() ?? "en");
    options.logger?.error("menu clear logs failed", { detail });
    const { dialog } = await import("electron");
    await dialog.showMessageBox({
      type: "error",
      title: translator.t("desktop.menu.clearLogsTitle"),
      message: translator.t("desktop.menu.clearLogsFailed"),
      detail
    });
  }
}

export function createApplicationMenuTemplate({
  allowDeveloperTools = process.env.NODE_ENV === "development",
  clearDeveloperLogs,
  exportDeveloperLogs,
  getLocale = () => "en",
  logger,
  openPerfMonitorDevTools,
  platform = process.platform,
  showMessageBox
}: ApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const translator = createTranslator(getLocale());
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: "Tutti",
      submenu: [
        { role: "about" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  template.push(
    {
      label: translator.t("desktop.menu.file"),
      submenu: isMac ? [{ role: "close" }] : [{ role: "quit" }]
    },
    {
      label: translator.t("desktop.menu.edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" }
      ]
    },
    {
      label: translator.t("desktop.menu.view"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(allowDeveloperTools
          ? ([
              { role: "toggleDevTools" },
              ...(openPerfMonitorDevTools
                ? ([
                    {
                      label: translator.t("desktop.menu.openPerfMonitor"),
                      click: (_item, browserWindow) => {
                        void openPerfMonitorDevTools(browserWindow);
                      }
                    }
                  ] satisfies MenuItemConstructorOptions[])
                : []),
              { type: "separator" }
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: translator.t("desktop.menu.window"),
      submenu: isMac
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" }
          ]
        : [{ role: "minimize" }, { role: "close" }]
    },
    {
      label: translator.t("desktop.menu.help"),
      submenu: [
        {
          label: translator.t("desktop.menu.exportServiceLogs"),
          click: () => {
            void runExportDeveloperLogsFromMenu({
              allowDeveloperTools,
              exportDeveloperLogs,
              getLocale,
              logger,
              platform
            });
          }
        },
        {
          label: translator.t("desktop.menu.clearServiceLogs"),
          click: () => {
            void runClearDeveloperLogsFromMenu({
              allowDeveloperTools,
              clearDeveloperLogs,
              getLocale,
              logger,
              platform,
              showMessageBox
            });
          }
        }
      ]
    }
  );

  return template;
}

export async function configureApplicationMenu(
  options: ApplicationMenuOptions = {}
): Promise<void> {
  const { app, Menu } = await import("electron");
  app.setAboutPanelOptions({
    applicationName: "Tutti",
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "Copyright © 2026 Tutti"
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(createApplicationMenuTemplate(options))
  );
}
