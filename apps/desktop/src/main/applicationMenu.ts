import type {
  BaseWindow,
  MenuItemConstructorOptions,
  MessageBoxOptions
} from "electron";
import {
  desktopIpcChannels,
  type AppUpdateState,
  type ClearDeveloperLogsResult,
  type ExportDeveloperLogsInput
} from "../shared/contracts/ipc.ts";
import { createTranslator, type DesktopLocale } from "../shared/i18n/index.ts";
import { requestDesktopAppQuitFromCommandShortcut } from "./desktopAppLifecycle.ts";
import type { DesktopLogger } from "./logging.ts";

export interface ApplicationMenuOptions {
  allowDeveloperTools?: boolean;
  checkForUpdates?: () => unknown;
  clearDeveloperLogs?: () =>
    | ClearDeveloperLogsResult
    | Promise<ClearDeveloperLogsResult>;
  closeFromCommandShortcut?: (ownerWindow?: BaseWindow | null) => void;
  exportDeveloperLogs?: (input: ExportDeveloperLogsInput) => unknown;
  getLocale?: () => DesktopLocale;
  logger?: DesktopLogger;
  openPerfMonitorDevTools?: (ownerWindow?: BaseWindow | null) => unknown;
  platform?: NodeJS.Platform;
  quitFromCommandShortcut?: () => void;
  showMessageBox?: (options: MessageBoxOptions) => Promise<unknown>;
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === "string" ? error : "Unknown error";
}

async function runExportDeveloperLogsFromMenu(
  options: ApplicationMenuOptions,
  input: ExportDeveloperLogsInput
): Promise<void> {
  if (!options.exportDeveloperLogs) {
    return;
  }

  try {
    await options.exportDeveloperLogs(input);
    options.logger?.info("menu export logs completed", {
      includeAgentSessions: input.includeAgentSessions,
      scope: input.scope
    });
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

function createDeveloperLogsExportMenuItem(
  options: ApplicationMenuOptions,
  label: string,
  input: ExportDeveloperLogsInput
): MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      void runExportDeveloperLogsFromMenu(options, input);
    }
  };
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

async function runCheckForUpdatesFromMenu(
  options: ApplicationMenuOptions
): Promise<void> {
  if (!options.checkForUpdates) {
    return;
  }

  try {
    const result = await options.checkForUpdates();
    if (isUpToDateUpdateState(result)) {
      const translator = createTranslator(options.getLocale?.() ?? "en");
      const showMessageBox =
        options.showMessageBox ??
        (async (messageBoxOptions: MessageBoxOptions) => {
          const { dialog } = await import("electron");
          await dialog.showMessageBox(messageBoxOptions);
        });

      await showMessageBox({
        buttons: [translator.t("common.ok")],
        detail: translator.t("desktop.menu.upToDateDetail", {
          version: result.currentVersion
        }),
        message: translator.t("desktop.menu.upToDateMessage"),
        title: "Tutti",
        type: "info"
      });
    }
    options.logger?.info("menu check for updates completed");
  } catch (error) {
    options.logger?.warn("menu check for updates failed", {
      detail: formatErrorDetail(error)
    });
  }
}

function isUpToDateUpdateState(value: unknown): value is AppUpdateState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "up_to_date" &&
    typeof (value as { currentVersion?: unknown }).currentVersion === "string"
  );
}

export function createApplicationMenuTemplate({
  allowDeveloperTools = process.env.NODE_ENV === "development",
  checkForUpdates,
  clearDeveloperLogs,
  closeFromCommandShortcut,
  exportDeveloperLogs,
  getLocale = () => "en",
  logger,
  openPerfMonitorDevTools,
  platform = process.platform,
  quitFromCommandShortcut,
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
        {
          label: translator.t("desktop.menu.checkForUpdates"),
          click: () => {
            void runCheckForUpdatesFromMenu({
              allowDeveloperTools,
              checkForUpdates,
              getLocale,
              logger,
              platform,
              showMessageBox
            });
          }
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        quitFromCommandShortcut
          ? {
              accelerator: "Command+Q",
              label: translator.t("desktop.menu.quit"),
              click: () => quitFromCommandShortcut()
            }
          : { role: "quit" }
      ]
    });
  }

  template.push(
    {
      label: translator.t("desktop.menu.file"),
      submenu: isMac
        ? [
            closeFromCommandShortcut
              ? {
                  accelerator: "Command+W",
                  label: translator.t("common.close"),
                  click: (_menuItem, browserWindow) =>
                    closeFromCommandShortcut(browserWindow)
                }
              : { role: "close" }
          ]
        : [{ role: "quit" }]
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
        ...(!isMac
          ? ([
              {
                label: translator.t("desktop.menu.checkForUpdates"),
                click: () => {
                  void runCheckForUpdatesFromMenu({
                    allowDeveloperTools,
                    checkForUpdates,
                    getLocale,
                    logger,
                    platform,
                    showMessageBox
                  });
                }
              },
              { type: "separator" }
            ] satisfies MenuItemConstructorOptions[])
          : []),
        {
          label: translator.t("desktop.menu.exportServiceLogs"),
          submenu: [
            {
              label: translator.t("desktop.menu.exportRecentTenMinutesLogs"),
              submenu: [
                createDeveloperLogsExportMenuItem(
                  {
                    allowDeveloperTools,
                    exportDeveloperLogs,
                    getLocale,
                    logger,
                    platform
                  },
                  translator.t("desktop.menu.logsOnly"),
                  {
                    includeAgentSessions: false,
                    scope: "recent-10-minutes"
                  }
                ),
                createDeveloperLogsExportMenuItem(
                  {
                    allowDeveloperTools,
                    exportDeveloperLogs,
                    getLocale,
                    logger,
                    platform
                  },
                  translator.t("desktop.menu.logsWithAgentSessions"),
                  {
                    includeAgentSessions: true,
                    scope: "recent-10-minutes"
                  }
                )
              ]
            },
            {
              label: translator.t("desktop.menu.exportRecentThreeDaysLogs"),
              submenu: [
                createDeveloperLogsExportMenuItem(
                  {
                    allowDeveloperTools,
                    exportDeveloperLogs,
                    getLocale,
                    logger,
                    platform
                  },
                  translator.t("desktop.menu.logsOnly"),
                  {
                    includeAgentSessions: false,
                    scope: "recent-3-days"
                  }
                ),
                createDeveloperLogsExportMenuItem(
                  {
                    allowDeveloperTools,
                    exportDeveloperLogs,
                    getLocale,
                    logger,
                    platform
                  },
                  translator.t("desktop.menu.logsWithAgentSessions"),
                  {
                    includeAgentSessions: true,
                    scope: "recent-3-days"
                  }
                )
              ]
            }
          ]
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
  const { app, BrowserWindow, Menu } = await import("electron");
  app.setAboutPanelOptions({
    applicationName: "Tutti",
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "Copyright © 2026 Tutti"
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createApplicationMenuTemplate({
        quitFromCommandShortcut: () =>
          requestDesktopAppQuitFromCommandShortcut({
            now: () => Date.now(),
            quit: () => app.quit(),
            showQuitShortcutToast: () => {
              for (const window of BrowserWindow.getAllWindows()) {
                if (!window.webContents.isDestroyed()) {
                  window.webContents.send(
                    desktopIpcChannels.host.window.quitShortcutToast
                  );
                }
              }
            }
          }),
        closeFromCommandShortcut: (ownerWindow) => {
          if (ownerWindow instanceof BrowserWindow) {
            void import("./windows/workspaceWindow.ts").then(
              ({ requestWorkspaceWindowCloseFromCommandShortcut }) => {
                requestWorkspaceWindowCloseFromCommandShortcut(ownerWindow);
              }
            );
          }
        },
        ...options
      })
    )
  );
}
