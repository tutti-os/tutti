import { dirname } from "node:path";
import type { MessageBoxOptions } from "electron";
import {
  createTranslator,
  type DesktopLocale,
  type Translator
} from "../shared/i18n/index.ts";
import type { DesktopLogger } from "./logging.ts";

type ShowMessageBox = (
  options: MessageBoxOptions
) => Promise<{ response: number }>;

type MoveToApplicationsFolder = () => boolean | Promise<boolean>;

export interface MacosApplicationInstallGuardOptions {
  appPath: string;
  isPackaged: boolean;
  locale: DesktopLocale;
  logger?: Pick<DesktopLogger, "error" | "info" | "warn">;
  moveToApplicationsFolder?: MoveToApplicationsFolder;
  platform?: NodeJS.Platform;
  quit?: () => void | Promise<void>;
  showItemInFolder?: (path: string) => void | Promise<void>;
  showMessageBox?: ShowMessageBox;
}

export function shouldPromptToInstallMacosApplication(options: {
  appPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || !options.isPackaged) {
    return false;
  }

  return isPathOnMountedVolume(options.appPath);
}

export async function ensureMacosApplicationInstalled(
  options: MacosApplicationInstallGuardOptions
): Promise<boolean> {
  if (!shouldPromptToInstallMacosApplication(options)) {
    return true;
  }

  const translator = createTranslator(options.locale);
  const appBundlePath = resolveMacAppBundlePath(options.appPath);
  const showMessageBox = options.showMessageBox ?? defaultShowMessageBox;
  const moveToApplicationsFolder =
    options.moveToApplicationsFolder ?? defaultMoveToApplicationsFolder;
  const quit = options.quit ?? defaultQuit;
  const showItemInFolder = options.showItemInFolder ?? defaultShowItemInFolder;

  options.logger?.warn(
    "macOS app launched from mounted disk image; prompting to install",
    {
      appPath: options.appPath,
      appBundlePath
    }
  );

  const promptResult = await showMessageBox({
    buttons: [
      translator.t("desktop.installGuard.moveAction"),
      translator.t("desktop.installGuard.quitAction")
    ],
    cancelId: 1,
    defaultId: 0,
    detail: translator.t("desktop.installGuard.detail"),
    message: translator.t("desktop.installGuard.message"),
    noLink: true,
    title: translator.t("desktop.installGuard.title"),
    type: "warning"
  });

  if (promptResult.response !== 0) {
    await quit();
    return false;
  }

  try {
    if (await moveToApplicationsFolder()) {
      options.logger?.info(
        "macOS app moved to Applications; waiting for relaunch",
        {
          appPath: options.appPath,
          appBundlePath
        }
      );
      return false;
    }
  } catch (error) {
    options.logger?.error("failed to move macOS app to Applications", {
      appPath: options.appPath,
      appBundlePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const failureResult = await showInstallFailureDialog({
    appBundlePath,
    showMessageBox,
    translator
  });

  if (failureResult.response === 0) {
    await showItemInFolder(appBundlePath);
  }
  await quit();
  return false;
}

function isPathOnMountedVolume(path: string): boolean {
  return path === "/Volumes" || path.startsWith("/Volumes/");
}

function resolveMacAppBundlePath(executablePath: string): string {
  let candidate = executablePath;

  for (let index = 0; index < 6; index += 1) {
    if (candidate.endsWith(".app")) {
      return candidate;
    }

    const next = dirname(candidate);
    if (next === candidate) {
      break;
    }
    candidate = next;
  }

  return executablePath;
}

async function showInstallFailureDialog(options: {
  appBundlePath: string;
  showMessageBox: ShowMessageBox;
  translator: Translator;
}): Promise<{ response: number }> {
  return options.showMessageBox({
    buttons: [
      options.translator.t("desktop.installGuard.showInFinderAction"),
      options.translator.t("desktop.installGuard.quitAction")
    ],
    cancelId: 1,
    defaultId: 0,
    detail: options.translator.t("desktop.installGuard.failureDetail", {
      appPath: options.appBundlePath
    }),
    message: options.translator.t("desktop.installGuard.failureMessage"),
    noLink: true,
    title: options.translator.t("desktop.installGuard.title"),
    type: "error"
  });
}

function defaultShowMessageBox(
  options: MessageBoxOptions
): Promise<{ response: number }> {
  return import("electron").then(({ dialog }) =>
    dialog.showMessageBox(options)
  );
}

function defaultMoveToApplicationsFolder(): Promise<boolean> {
  return import("electron").then(({ app }) => app.moveToApplicationsFolder());
}

async function defaultQuit(): Promise<void> {
  const { app } = await import("electron");
  app.quit();
}

async function defaultShowItemInFolder(path: string): Promise<void> {
  const { shell } = await import("electron");
  shell.showItemInFolder(path);
}
