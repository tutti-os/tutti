import {
  desktopIpcChannels,
  type DesktopArchiveAgentPromptFileInput,
  type DesktopArchiveAgentPromptFileResult,
  type DesktopClipboardImagePayload,
  type DesktopCreateUserDocumentsProjectDirectoryInput,
  type DesktopTerminalLinkPathPayload,
  type DesktopWorkspaceFileEntryIconPayload,
  type DesktopWorkspaceFilePathPayload
} from "../../shared/contracts/ipc";
import { app, shell } from "electron";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  writeFilesToSystemClipboard,
  writeImageToSystemClipboard
} from "../host/clipboardFiles.ts";
import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess";
import { createWorkspaceFileHostAccess } from "../host/workspaceFileHostAccess.ts";
import type { WorkspaceFileIconCacheStore } from "../host/workspaceFileIconCacheStore.ts";
import { registerDesktopIpcHandler } from "./handle";
import { resolveOwnerWindowFromEvent } from "./ownerWindow";

export interface HostFilesIpcDependencies {
  fileDialogs: Pick<
    DesktopFileDialogAccess,
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
    | "selectDirectory"
    | "selectUploadFiles"
  >;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
}

export function registerHostFilesIpc(deps: HostFilesIpcDependencies): void {
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => app.getPath("documents"),
    workspaceFileIconCache: deps.workspaceFileIconCache
  });

  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.createUserDocumentsProjectDirectory,
    (_event, payload: DesktopCreateUserDocumentsProjectDirectoryInput) =>
      hostAccess.createUserDocumentsProjectDirectory(payload)
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.openFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.listOpenWithApplications,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.listOpenWithApplications(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileWithApplication,
    (
      _event,
      payload: DesktopWorkspaceFilePathPayload & { applicationPath: string }
    ) => hostAccess.openFileWithApplication(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileWithOtherApplication,
    (
      _event,
      payload: DesktopWorkspaceFilePathPayload & {
        applicationPickerPrompt?: string;
      }
    ) => hostAccess.openFileWithOtherApplication(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileInBrowser,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.openFileInBrowser(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.resolveWorkspaceFileFileUrl,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.resolveWorkspaceFileFileUrl(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.revealInFolder,
    (_event, payload: string) => shell.showItemInFolder(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.revealWorkspaceFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.revealWorkspaceFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openTerminalLink,
    (_event, payload: DesktopTerminalLinkPathPayload) =>
      hostAccess.openTerminalLink(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openExternal,
    (_event, payload: string) => hostAccess.openExternal(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readLocalFileText,
    (_event, payload: string) => hostAccess.readLocalFileText(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readLocalPreviewFile,
    (_event, payload: string) => hostAccess.readLocalPreviewFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.archiveAgentPromptFile,
    (_event, payload: DesktopArchiveAgentPromptFileInput) =>
      archiveAgentPromptFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readPreviewFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.readPreviewFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.resolveEntryIcon,
    (_event, payload: DesktopWorkspaceFileEntryIconPayload) =>
      hostAccess.resolveEntryIcon(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectDirectory,
    (event) =>
      deps.fileDialogs.selectDirectory(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppArchive,
    (event) =>
      deps.fileDialogs.selectAppArchive(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppArchiveExportPath,
    (event, payload) =>
      deps.fileDialogs.selectAppArchiveExportPath(
        payload.defaultPath,
        resolveOwnerWindowFromEvent(event)
      )
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppIconImage,
    (event) =>
      deps.fileDialogs.selectAppIconImage(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectUploadFiles,
    (event, input) =>
      deps.fileDialogs.selectUploadFiles(
        resolveOwnerWindowFromEvent(event),
        input
      )
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.copyImageToClipboard,
    (_event, payload: DesktopClipboardImagePayload) => {
      writeImageToSystemClipboard(payload);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.copyFilesToClipboard,
    (_event, payload: string[]) => {
      writeFilesToSystemClipboard(payload);
    }
  );
}

async function archiveAgentPromptFile(
  input: DesktopArchiveAgentPromptFileInput
): Promise<DesktopArchiveAgentPromptFileResult> {
  const workspaceID = sanitizeAgentPromptAssetSegment(input.workspaceID);
  const displayName = normalizeAgentPromptAssetDisplayName(
    input.displayName ?? input.hostPath ?? "attachment"
  );
  const dataBase64 = input.dataBase64?.trim() ?? "";
  const hostPath = input.hostPath?.trim() ?? "";
  let bytes: Buffer | null = null;
  let sourcePath = "";
  let sizeBytes = 0;
  if (dataBase64) {
    bytes = Buffer.from(dataBase64, "base64");
    sizeBytes = bytes.byteLength;
  } else if (hostPath) {
    const sourceStat = await stat(hostPath);
    if (!sourceStat.isFile()) {
      throw new Error("Only regular files can be archived as prompt assets.");
    }
    sourcePath = hostPath;
    sizeBytes = sourceStat.size;
  } else {
    throw new Error("Prompt asset archive requires hostPath or dataBase64.");
  }
  const hash = createHash("sha256");
  if (bytes) {
    hash.update(bytes);
  } else {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(sourcePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }
  const sha256 = hash.digest("hex");
  const extension =
    safeAgentPromptAssetExtension(displayName) ??
    safeAgentPromptAssetExtension(input.mimeType ?? "") ??
    "";
  const archiveDir = path.join(
    app.getPath("userData"),
    "agent-prompt-assets",
    workspaceID,
    sha256.slice(0, 2)
  );
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(archiveDir, `${sha256}${extension}`);
  if (bytes) {
    await writeFile(archivePath, bytes, { mode: 0o600 });
  } else {
    await copyFile(sourcePath, archivePath);
    await chmod(archivePath, 0o600);
  }
  return {
    name: displayName,
    path: archivePath,
    sizeBytes
  };
}

function normalizeAgentPromptAssetDisplayName(value: string): string {
  const baseName = path.basename(value.trim()) || "attachment";
  return baseName.replace(/[\r\n]/g, " ").trim() || "attachment";
}

function sanitizeAgentPromptAssetSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("workspaceID is required to archive prompt assets.");
  }
  return normalized;
}

function safeAgentPromptAssetExtension(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const fromMimeType = normalized.includes("/")
    ? promptAssetExtensionFromMimeType(normalized)
    : "";
  const extension = fromMimeType || path.extname(normalized);
  if (!extension || extension.length > 16) {
    return null;
  }
  return /^\.[a-z0-9]+$/.test(extension) ? extension : null;
}

function promptAssetExtensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    default:
      return "";
  }
}
