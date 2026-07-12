import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from "electron";
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

  return {
    async selectAppArchive(ownerWindow) {
      const translator = createTranslator(deps.getLocale());
      const selection = await showOpenDialog(ownerWindow, {
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

      return selection.filePaths[0] ?? null;
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

      return selection.filePath;
    },

    async selectAppIconImage(ownerWindow) {
      const selection = await showOpenDialog(ownerWindow, {
        filters: [
          { extensions: ["png", "jpg", "jpeg", "webp"], name: "Image" }
        ],
        properties: ["openFile"]
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }

      return selection.filePaths[0] ?? null;
    },

    async selectDirectory(ownerWindow) {
      const translator = createTranslator(deps.getLocale());
      const selectDirectoryLabel = translator.t("common.selectFolder");
      const selection = await showOpenDialog(ownerWindow, {
        buttonLabel: selectDirectoryLabel,
        properties: ["openDirectory"],
        title: selectDirectoryLabel
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }

      return selection.filePaths[0] ?? null;
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
        properties
      });

      if (selection.canceled || selection.filePaths.length === 0) {
        return [];
      }

      return selection.filePaths;
    }
  };
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
