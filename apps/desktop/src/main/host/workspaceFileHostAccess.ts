import type { Stats } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path, { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceFilePreviewMaxBytes } from "@tutti-os/workspace-file-preview";
import { desktopErrorCodes } from "../../shared/errors/desktopErrors.ts";
import type {
  DesktopCreateUserDocumentsProjectDirectoryInput,
  DesktopCreateUserDocumentsProjectDirectoryResult,
  DesktopLocalFileTextResult,
  DesktopTerminalLinkPathPayload,
  DesktopWorkspaceFileEntryIconPayload,
  DesktopWorkspaceFileOpenWithOtherPayload,
  DesktopWorkspaceFilePathPayload
} from "../../shared/contracts/ipc";
import {
  listOpenWithApplications,
  openFileWithApplication,
  openFileWithDefaultBrowser,
  openFileWithOtherApplication
} from "./openWithApplications.ts";
import { resolveWorkspaceFileEntryIconUrl } from "./workspaceFileEntryIcon.ts";
import type { WorkspaceFileIconCacheStore } from "./workspaceFileIconCacheStore.ts";
import {
  resolveTerminalLinkAbsolutePath,
  resolveWorkspaceLogicalFilePath,
  workspaceLogicalRoot
} from "./workspaceFilePaths.ts";
import type { DesktopOpenWithApplication } from "../../shared/contracts/ipc.ts";

export interface WorkspaceFileHostAccess {
  createUserDocumentsProjectDirectory(
    payload: DesktopCreateUserDocumentsProjectDirectoryInput
  ): Promise<DesktopCreateUserDocumentsProjectDirectoryResult>;
  openExternal(url: string): Promise<void>;
  listOpenWithApplications(
    payload: DesktopWorkspaceFilePathPayload
  ): Promise<DesktopOpenWithApplication[]>;
  openFile(payload: DesktopWorkspaceFilePathPayload): Promise<void>;
  openFileWithApplication(
    payload: DesktopWorkspaceFilePathPayload & { applicationPath: string }
  ): Promise<void>;
  openFileWithOtherApplication(
    payload: DesktopWorkspaceFileOpenWithOtherPayload
  ): Promise<void>;
  openFileInBrowser(payload: DesktopWorkspaceFilePathPayload): Promise<void>;
  resolveWorkspaceFileFileUrl(
    payload: DesktopWorkspaceFilePathPayload
  ): Promise<string>;
  revealWorkspaceFile(payload: DesktopWorkspaceFilePathPayload): Promise<void>;
  openTerminalLink(payload: DesktopTerminalLinkPathPayload): Promise<void>;
  readLocalFileText(path: string): Promise<DesktopLocalFileTextResult>;
  readLocalPreviewFile(path: string): Promise<Uint8Array>;
  readPreviewFile(
    payload: DesktopWorkspaceFilePathPayload
  ): Promise<Uint8Array>;
  resolveEntryIcon(
    payload: DesktopWorkspaceFileEntryIconPayload
  ): Promise<string | null>;
}

export interface WorkspaceFileHostAccessDependencies {
  getDocumentsPath?: () => string | Promise<string>;
  mkdir?: typeof mkdir;
  openExternal?: (url: string) => Promise<void>;
  openFileWithDefaultBrowser?: (path: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  readFile?: typeof readFile;
  showItemInFolder?: (path: string) => void;
  stat?: typeof stat;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
}

export function createWorkspaceFileHostAccess(
  deps: WorkspaceFileHostAccessDependencies
): WorkspaceFileHostAccess {
  const openExternal = deps.openExternal ?? defaultOpenExternal;
  const openFileWithDefaultBrowserImpl =
    deps.openFileWithDefaultBrowser ?? openFileWithDefaultBrowser;
  const openPath = deps.openPath ?? defaultOpenPath;
  const getDocumentsPath = deps.getDocumentsPath ?? defaultGetDocumentsPath;
  const mkdirImpl = deps.mkdir ?? mkdir;
  const readFileImpl = deps.readFile ?? readFile;
  const showItemInFolder = deps.showItemInFolder ?? defaultShowItemInFolder;
  const statImpl = deps.stat ?? stat;

  return {
    async createUserDocumentsProjectDirectory(payload) {
      const targetPath = resolveUserDocumentsProjectPath({
        documentsPath: await getDocumentsPath(),
        name: payload.name
      });
      await ensureProjectDirectoryRoot(path.dirname(targetPath), targetPath, {
        mkdir: mkdirImpl
      });
      try {
        await mkdirImpl(targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          if (payload.allowExisting === true) {
            return { path: targetPath };
          }
          throw createProjectDirectoryAlreadyExistsError(targetPath);
        }
        if (code === "EACCES" || code === "EPERM") {
          throw createProjectDirectoryPermissionDeniedError(targetPath);
        }
        if (code === "ENOENT") {
          throw createProjectDocumentsUnavailableError(targetPath);
        }
        throw error;
      }
      return { path: targetPath };
    },

    async openExternal(url) {
      await openExternal(url);
    },

    async listOpenWithApplications(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      return listOpenWithApplications(targetPath);
    },

    async openFile(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      const openError = await openPath(targetPath);
      if (
        openError &&
        !(await shouldTreatSystemOpenFailureAsHandled(openError, targetPath, {
          stat: statImpl
        }))
      ) {
        throw new Error(openError);
      }
    },

    async openFileWithApplication(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      await openFileWithApplication(targetPath, payload.applicationPath);
    },

    async openFileWithOtherApplication(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      await openFileWithOtherApplication(
        targetPath,
        payload.applicationPickerPrompt
      );
    },

    async openFileInBrowser(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      await openFileWithDefaultBrowserImpl(targetPath);
    },

    resolveWorkspaceFileFileUrl(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      return Promise.resolve(pathToFileURL(targetPath).href);
    },

    async revealWorkspaceFile(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      await revealPathInOsFileManager(targetPath, {
        openPath,
        showItemInFolder,
        stat: statImpl
      });
    },

    async openTerminalLink(payload) {
      const targetPath = resolveTerminalLinkAbsolutePath({
        cwd: payload.cwd,
        defaultDirectory: homedir(),
        homeDirectory: homedir(),
        path: payload.path
      });
      const openError = await openPath(targetPath);
      if (openError) {
        throw new Error(openError);
      }
    },

    async readLocalFileText(path) {
      await ensureFileWithinPreviewBudget(path, statImpl);
      const content = await readFileImpl(path, "utf8");
      return {
        content,
        name: basename(path),
        path
      };
    },

    async readLocalPreviewFile(path) {
      await ensureFileWithinPreviewBudget(path, statImpl);
      const bytes = await readFileImpl(path);
      return Uint8Array.from(bytes);
    },

    async readPreviewFile(payload) {
      const targetPath = resolveWorkspaceTargetPath(payload);
      await ensureFileWithinPreviewBudget(targetPath, statImpl);

      const bytes = await readFileImpl(targetPath);
      return Uint8Array.from(bytes);
    },

    async resolveEntryIcon(payload) {
      if (!deps.workspaceFileIconCache) {
        return null;
      }
      const targetPath = resolveWorkspaceTargetPath(payload);
      return resolveWorkspaceFileEntryIconUrl(
        targetPath,
        {
          kind: payload.entryKind,
          mtimeMs: payload.entryMtimeMs,
          name: payload.entryName,
          path: payload.path,
          workspaceID: payload.workspaceID
        },
        deps.workspaceFileIconCache
      );
    }
  };
}

async function ensureProjectDirectoryRoot(
  rootPath: string,
  targetPath: string,
  deps: { mkdir: typeof mkdir }
): Promise<void> {
  try {
    await deps.mkdir(rootPath, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw createProjectDirectoryPermissionDeniedError(targetPath);
    }
    if (code === "ENOENT") {
      throw createProjectDocumentsUnavailableError(targetPath);
    }
    throw error;
  }
}

function resolveUserDocumentsProjectPath(input: {
  documentsPath: string;
  name: string;
}): string {
  const documentsPathInput = input.documentsPath.trim();
  if (!documentsPathInput) {
    throw createProjectDocumentsUnavailableError(input.documentsPath);
  }

  const documentsPath = path.resolve(documentsPathInput);
  const projectName = normalizeProjectDirectoryName(input.name);
  const tuttiProjectsPath = path.resolve(documentsPath, "tutti");
  const targetPath = path.resolve(tuttiProjectsPath, projectName);
  if (!isPathWithinRoot(documentsPath, targetPath)) {
    throw createProjectNameInvalidError();
  }
  return targetPath;
}

function normalizeProjectDirectoryName(name: string): string {
  const normalized = String(name).trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw createProjectNameInvalidError();
  }
  return normalized;
}

function createProjectDirectoryAlreadyExistsError(targetPath: string): Error {
  const error = new Error(`Project directory already exists: ${targetPath}`);
  (error as NodeJS.ErrnoException).code =
    desktopErrorCodes.projectDirectoryAlreadyExists;
  return error;
}

function createProjectDirectoryPermissionDeniedError(
  targetPath: string
): Error {
  const error = new Error(
    `Permission denied creating project directory: ${targetPath}`
  );
  (error as NodeJS.ErrnoException).code =
    desktopErrorCodes.projectDirectoryPermissionDenied;
  return error;
}

function createProjectDocumentsUnavailableError(targetPath: string): Error {
  const error = new Error(`Documents directory is unavailable: ${targetPath}`);
  (error as NodeJS.ErrnoException).code =
    desktopErrorCodes.projectDocumentsUnavailable;
  return error;
}

function createProjectNameInvalidError(): Error {
  const error = new Error("Project name is invalid.");
  (error as NodeJS.ErrnoException).code = desktopErrorCodes.projectNameInvalid;
  return error;
}

async function defaultOpenPath(targetPath: string): Promise<string> {
  const { shell } = await import("electron");
  return shell.openPath(targetPath);
}

async function defaultGetDocumentsPath(): Promise<string> {
  const { app } = await import("electron");
  return app.getPath("documents");
}

async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import("electron");
  await shell.openExternal(url);
}

function defaultShowItemInFolder(path: string): void {
  void import("electron").then(({ shell }) => {
    shell.showItemInFolder(path);
  });
}

function resolveWorkspaceTargetPath(
  payload: DesktopWorkspaceFilePathPayload
): string {
  const rootDirectory = resolveWorkspaceTargetRoot(payload.path);
  const targetPath = resolveWorkspaceLogicalFilePath({
    logicalPath: payload.path,
    logicalRoot: workspaceLogicalRoot,
    physicalRootDirectory: rootDirectory
  });
  return targetPath;
}

function resolveWorkspaceTargetRoot(logicalPath: string): string {
  const normalizedPath = logicalPath.trim().replaceAll("\\", "/");
  if (
    isWorkspaceLogicalPath(normalizedPath) ||
    !path.isAbsolute(normalizedPath)
  ) {
    return homedir();
  }
  return path.parse(normalizedPath).root || path.resolve(path.sep);
}

function isWorkspaceLogicalPath(value: string): boolean {
  return (
    value === workspaceLogicalRoot ||
    value.startsWith(`${workspaceLogicalRoot}/`)
  );
}

async function shouldTreatSystemOpenFailureAsHandled(
  message: string,
  targetPath: string,
  deps: { stat: (path: string) => Promise<Stats> }
): Promise<boolean> {
  if (!isExpectedSystemOpenFailure(message)) {
    return false;
  }

  if (!isGenericOpenPathFailure(message)) {
    return true;
  }

  try {
    const fileStat = await deps.stat(targetPath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function isExpectedSystemOpenFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    isGenericOpenPathFailure(message) ||
    normalized.includes("klsapplicationnotfounderr") ||
    normalized.includes("code=-10814") ||
    normalized.includes("no application knows how to open") ||
    normalized.includes("no application claims the file") ||
    normalized.includes("there is no application set to open")
  );
}

function isGenericOpenPathFailure(message: string): boolean {
  return message.trim().toLowerCase() === "failed to open path";
}

async function revealPathInOsFileManager(
  targetPath: string,
  deps: {
    openPath: (path: string) => Promise<string>;
    showItemInFolder: (path: string) => void;
    stat: (path: string) => Promise<Stats>;
  }
): Promise<void> {
  let fileStat: Stats;
  try {
    fileStat = await deps.stat(targetPath);
  } catch {
    throw new Error(`workspace file does not exist: ${targetPath}`);
  }

  if (fileStat.isDirectory()) {
    const openError = await deps.openPath(targetPath);
    if (openError) {
      throw new Error(openError);
    }
    return;
  }

  deps.showItemInFolder(targetPath);
}

async function ensureFileWithinPreviewBudget(
  path: string,
  statImpl: typeof stat
): Promise<void> {
  const fileStat = await statImpl(path);
  if (fileStat.size <= workspaceFilePreviewMaxBytes) {
    return;
  }
  const error = new Error("Preview file is too large to read safely.");
  (error as NodeJS.ErrnoException).code = desktopErrorCodes.previewFileTooLarge;
  throw error;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
