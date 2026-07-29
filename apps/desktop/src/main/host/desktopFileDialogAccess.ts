import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from "electron";
import { dirname } from "node:path";
import {
  createTranslator,
  type DesktopLocale
} from "../../shared/i18n/index.ts";

export interface DesktopFileDialogAccess {
  selectAppArchive(ownerWindow?: BrowserWindow | null): Promise<string | null>;
  selectAppArchiveExportPath(
    defaultPath: string,
    ownerWindow?: BrowserWindow | null
  ): Promise<string | null>;
  selectAppIconImage(
    ownerWindow?: BrowserWindow | null
  ): Promise<string | null>;
  selectDirectory(ownerWindow?: BrowserWindow | null): Promise<string | null>;
  selectUploadFiles(
    ownerWindow?: BrowserWindow | null,
    input?: DesktopSelectUploadFilesInput
  ): Promise<string[]>;
}

export interface DesktopSelectUploadFilesInput {
  allowDirectories?: boolean;
}

export interface DesktopFileDialogAccessDependencies {
  getDefaultPath?: (name: "documents" | "downloads") => string;
  getLocale: () => DesktopLocale;
  showOpenDialog?: ShowOpenDialog;
  showSaveDialog?: ShowSaveDialog;
}

type ShowOpenDialog = (
  ownerWindow: BrowserWindow | null | undefined,
  options: OpenDialogOptions
) => Promise<OpenDialogReturnValue>;

type ShowSaveDialog = (
  ownerWindow: BrowserWindow | null | undefined,
  options: SaveDialogOptions
) => Promise<SaveDialogReturnValue>;

export function createDesktopFileDialogAccess(
  deps: DesktopFileDialogAccessDependencies
): DesktopFileDialogAccess {
  const showOpenDialog = deps.showOpenDialog ?? defaultShowOpenDialog;
  const showSaveDialog = deps.showSaveDialog ?? defaultShowSaveDialog;
  let lastImportDirectory = deps.getDefaultPath?.("downloads");
  let lastProjectDirectory = deps.getDefaultPath?.("documents");

  return {
    async selectAppArchive(ownerWindow) {
      const translator = createTranslator(deps.getLocale());
      const selection = await showOpenDialog(ownerWindow, {
        ...defaultPathOption(lastImportDirectory),
        filters: [
          {
            extensions: ["zip"],
            name: translator.t("common.zipArchive")
          }
        ],
        properties: ["openFile"]
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }

      const selectedPath = selection.filePaths[0] ?? null;
      lastImportDirectory = selectedPath
        ? dirname(selectedPath)
        : lastImportDirectory;
      return selectedPath;
    },

    async selectAppArchiveExportPath(defaultPath, ownerWindow) {
      const translator = createTranslator(deps.getLocale());
      const selection = await showSaveDialog(ownerWindow, {
        defaultPath,
        filters: [
          {
            extensions: ["zip"],
            name: translator.t("common.zipArchive")
          }
        ]
      });

      if (selection.canceled || !selection.filePath) {
        return null;
      }

      lastImportDirectory = dirname(selection.filePath);
      return selection.filePath;
    },

    async selectAppIconImage(ownerWindow) {
      const selection = await showOpenDialog(ownerWindow, {
        ...defaultPathOption(lastImportDirectory),
        filters: [
          { extensions: ["png", "jpg", "jpeg", "webp"], name: "Image" }
        ],
        properties: ["openFile"]
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }

      const selectedPath = selection.filePaths[0] ?? null;
      lastImportDirectory = selectedPath
        ? dirname(selectedPath)
        : lastImportDirectory;
      return selectedPath;
    },

    async selectDirectory(ownerWindow) {
      const translator = createTranslator(deps.getLocale());
      const selectDirectoryLabel = translator.t("common.selectFolder");
      const selection = await showOpenDialog(ownerWindow, {
        buttonLabel: selectDirectoryLabel,
        ...defaultPathOption(lastProjectDirectory),
        properties: ["openDirectory"],
        title: selectDirectoryLabel
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }

      const selectedPath = selection.filePaths[0] ?? null;
      lastProjectDirectory = selectedPath ?? lastProjectDirectory;
      return selectedPath;
    },

    async selectUploadFiles(ownerWindow, input) {
      const properties: OpenDialogOptions["properties"] = [
        "openFile",
        "multiSelections"
      ];
      if (input?.allowDirectories !== false) {
        properties.splice(1, 0, "openDirectory");
      }
      const selection = await showOpenDialog(ownerWindow, {
        ...defaultPathOption(lastImportDirectory),
        properties
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return [];
      }

      lastImportDirectory = dirname(selection.filePaths[0]!);
      return selection.filePaths;
    }
  };
}

function defaultPathOption(
  defaultPath: string | undefined
): Pick<OpenDialogOptions, "defaultPath"> | Record<never, never> {
  return defaultPath ? { defaultPath } : {};
}

async function defaultShowOpenDialog(
  ownerWindow: BrowserWindow | null | undefined,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  const { dialog } = await import("electron");
  if (ownerWindow) {
    return dialog.showOpenDialog(ownerWindow, options);
  }

  return dialog.showOpenDialog(options);
}

async function defaultShowSaveDialog(
  ownerWindow: BrowserWindow | null | undefined,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> {
  const { dialog } = await import("electron");
  if (ownerWindow) {
    return dialog.showSaveDialog(ownerWindow, options);
  }

  return dialog.showSaveDialog(options);
}
