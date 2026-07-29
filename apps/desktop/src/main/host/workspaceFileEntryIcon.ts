import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceFileDefaultApplicationIconExtension } from "@tutti-os/workspace-file-manager/services";
import { resolveWorkspaceFileVisualKind } from "@tutti-os/workspace-file-preview";
import { requestWorkerIconPngBytes } from "./iconWorker/iconWorkerClient.ts";
import {
  readApplicationIconDataUrl,
  resolveDefaultApplicationForFile
} from "./openWithApplications.ts";
import type { WorkspaceFileIconCacheStore } from "./workspaceFileIconCacheStore.ts";

const entryIconPixelSize = 256;
const imageThumbnailPixelSize = 256;
const imageThumbnailMaxSourceBytes = 20 * 1024 * 1024;

type WorkspaceFileEntryIconStat = {
  isFile(): boolean;
  size: number;
};

type WorkspaceFileEntryIconStatReader = (
  targetPath: string
) => Promise<WorkspaceFileEntryIconStat>;

export interface WorkspaceFileEntryIconInput {
  kind: string;
  mtimeMs: number | null;
  name: string;
  path: string;
  workspaceID: string;
}

interface WorkspaceFileEntryIconResolverDependencies {
  readApplicationIconDataUrl?: typeof readApplicationIconDataUrl;
  readImageThumbnailPngBytes?: typeof readImageThumbnailPngBytes;
  readNativeFileIconPngBytes?: typeof readNativeFileIconPngBytes;
  resolveDefaultApplicationForFile?: typeof resolveDefaultApplicationForFile;
  stat?: WorkspaceFileEntryIconStatReader;
}

export async function resolveWorkspaceFileEntryIconUrl(
  targetPath: string,
  entry: WorkspaceFileEntryIconInput,
  cacheStore: WorkspaceFileIconCacheStore,
  dependencies: WorkspaceFileEntryIconResolverDependencies = {}
): Promise<string | null> {
  if (isImageThumbnailEntry(entry)) {
    return resolveImageThumbnailIconUrl(
      targetPath,
      entry,
      cacheStore,
      dependencies
    );
  }

  if (isApplicationBundleEntry(entry)) {
    return resolveApplicationBundleIconUrl(
      targetPath,
      entry,
      cacheStore,
      dependencies
    );
  }

  return resolveFileTypeDefaultApplicationIconUrl(
    targetPath,
    entry,
    cacheStore,
    dependencies
  );
}

async function resolveImageThumbnailIconUrl(
  targetPath: string,
  entry: WorkspaceFileEntryIconInput,
  cacheStore: WorkspaceFileIconCacheStore,
  dependencies: WorkspaceFileEntryIconResolverDependencies
): Promise<string | null> {
  const cacheKey = {
    assetKind: "image-thumbnail" as const,
    mtimeMs: entry.mtimeMs,
    path: entry.path,
    sizePx: imageThumbnailPixelSize,
    workspaceID: entry.workspaceID
  };
  const cachedUrl = await cacheStore.readUrl(cacheKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  let sourceStats: WorkspaceFileEntryIconStat;
  try {
    sourceStats = await (dependencies.stat ?? statFile)(targetPath);
  } catch {
    return null;
  }
  if (
    !sourceStats.isFile() ||
    sourceStats.size <= 0 ||
    sourceStats.size > imageThumbnailMaxSourceBytes
  ) {
    return null;
  }

  const thumbnailBytes = await (
    dependencies.readImageThumbnailPngBytes ?? readImageThumbnailPngBytes
  )(targetPath, imageThumbnailPixelSize);
  if (!thumbnailBytes) {
    return pathToFileURL(targetPath).href;
  }

  const cachedThumbnailUrl = await cacheStore.write({
    bytes: thumbnailBytes,
    key: cacheKey,
    mimeType: "image/png"
  });

  return cachedThumbnailUrl ?? pathToFileURL(targetPath).href;
}

async function statFile(
  targetPath: string
): Promise<WorkspaceFileEntryIconStat> {
  return stat(targetPath);
}

async function resolveApplicationBundleIconUrl(
  targetPath: string,
  entry: WorkspaceFileEntryIconInput,
  cacheStore: WorkspaceFileIconCacheStore,
  dependencies: WorkspaceFileEntryIconResolverDependencies
): Promise<string | null> {
  const cacheKey = {
    assetKind: "application-icon" as const,
    mtimeMs: entry.mtimeMs,
    path: entry.path,
    sizePx: entryIconPixelSize,
    workspaceID: entry.workspaceID
  };
  const cachedUrl = await cacheStore.readUrl(cacheKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  const nativeIcon = await (
    dependencies.readNativeFileIconPngBytes ?? readNativeFileIconPngBytes
  )(targetPath);
  const iconBytes =
    nativeIcon ??
    dataUrlToPngBytes(
      await (
        dependencies.readApplicationIconDataUrl ?? readApplicationIconDataUrl
      )(targetPath, entry.name)
    );
  if (!iconBytes) {
    return null;
  }

  return cacheStore.write({
    bytes: iconBytes,
    key: cacheKey,
    mimeType: "image/png"
  });
}

async function resolveFileTypeDefaultApplicationIconUrl(
  targetPath: string,
  entry: WorkspaceFileEntryIconInput,
  cacheStore: WorkspaceFileIconCacheStore,
  dependencies: WorkspaceFileEntryIconResolverDependencies
): Promise<string | null> {
  const fileExtension =
    resolveWorkspaceFileDefaultApplicationIconExtension(entry);
  if (!fileExtension) {
    return null;
  }

  const defaultApplication = await (
    dependencies.resolveDefaultApplicationForFile ??
    resolveDefaultApplicationForFile
  )(targetPath);
  if (!defaultApplication) {
    return null;
  }

  const cacheKey = {
    applicationPath: defaultApplication.applicationPath,
    assetKind: "file-type-default-application-icon" as const,
    fileExtension,
    platform: "darwin" as const,
    sizePx: entryIconPixelSize
  };
  const cachedUrl = await cacheStore.readUrl(cacheKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  const iconBytes = dataUrlToPngBytes(
    await (
      dependencies.readApplicationIconDataUrl ?? readApplicationIconDataUrl
    )(defaultApplication.applicationPath, defaultApplication.name)
  );
  if (!iconBytes) {
    return null;
  }

  return cacheStore.write({
    bytes: iconBytes,
    key: cacheKey,
    mimeType: "image/png"
  });
}

function isApplicationBundleEntry(
  entry: Pick<WorkspaceFileEntryIconInput, "kind" | "name">
): boolean {
  return entry.kind !== "file" && isApplicationBundleName(entry.name);
}

function isImageThumbnailEntry(
  entry: Pick<WorkspaceFileEntryIconInput, "kind" | "name" | "path">
): boolean {
  return (
    entry.kind === "file" && resolveWorkspaceFileVisualKind(entry) === "image"
  );
}

function isApplicationBundleName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".app");
}

function dataUrlToPngBytes(dataUrl: string | null): Buffer | null {
  if (!dataUrl) {
    return null;
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  const encodedBytes = match?.[1];
  if (!encodedBytes) {
    return null;
  }

  const bytes = Buffer.from(encodedBytes, "base64");
  return bytes.byteLength > 0 ? bytes : null;
}

// Native icon generation runs in a disposable worker process: `app.getFileIcon`
// can hard-abort on malformed bundles, which a try/catch here cannot contain.
async function readNativeFileIconPngBytes(
  targetPath: string
): Promise<Buffer | null> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }
  return requestWorkerIconPngBytes({
    mode: "fileIcon",
    path: targetPath,
    sizePx: entryIconPixelSize
  });
}

// Decoding arbitrary image files is likewise isolated in the worker process.
async function readImageThumbnailPngBytes(
  targetPath: string,
  maxEdgePx: number
): Promise<Buffer | null> {
  return requestWorkerIconPngBytes({
    mode: "imageThumbnail",
    path: targetPath,
    sizePx: maxEdgePx
  });
}
