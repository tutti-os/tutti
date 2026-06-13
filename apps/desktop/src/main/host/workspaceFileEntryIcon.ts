import { resolveWorkspaceFileVisualKind } from "@tutti-os/workspace-file-preview";
import { stat } from "node:fs/promises";
import {
  readApplicationIconDataUrl,
  readDefaultApplicationIconDataUrl
} from "./openWithApplications.ts";

const entryIconMaxBytes = 5 * 1024 * 1024;
const entryIconPixelSize = 128;

export interface WorkspaceFileEntryIconInput {
  kind: string;
  name: string;
  path: string;
}

export async function resolveWorkspaceFileEntryIconDataUrl(
  targetPath: string,
  entry: WorkspaceFileEntryIconInput
): Promise<string | null> {
  if (isApplicationBundleName(entry.name)) {
    const nativeIcon = await readNativeFileIconDataUrl(targetPath);
    if (nativeIcon) {
      return nativeIcon;
    }
    if (process.platform === "darwin") {
      return readApplicationIconDataUrl(targetPath, entry.name);
    }
    return null;
  }

  const visualKind = resolveWorkspaceFileVisualKind({
    kind: entry.kind,
    name: entry.name,
    path: entry.path
  });
  if (visualKind === "image" && entry.kind === "file") {
    return readImageThumbnailDataUrl(targetPath);
  }

  if (entry.kind === "file") {
    if (process.platform === "darwin") {
      return readDefaultApplicationIconDataUrl(targetPath);
    }
    return readNativeFileIconDataUrl(targetPath);
  }

  return null;
}

export function isApplicationBundleName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".app");
}

export function isMacOSApplicationBundle(
  entry: Pick<WorkspaceFileEntryIconInput, "name">,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" && isApplicationBundleName(entry.name);
}

async function readImageThumbnailDataUrl(
  targetPath: string
): Promise<string | null> {
  try {
    const fileStat = await stat(targetPath);
    if (!fileStat.isFile() || fileStat.size > entryIconMaxBytes) {
      return null;
    }

    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromPath(targetPath);
    if (image.isEmpty()) {
      return null;
    }

    const { height, width } = image.getSize();
    if (width <= 0 || height <= 0) {
      return null;
    }

    const scale = Math.min(
      entryIconPixelSize / width,
      entryIconPixelSize / height,
      1
    );
    const resized =
      scale < 1
        ? image.resize({
            height: Math.max(1, Math.round(height * scale)),
            width: Math.max(1, Math.round(width * scale))
          })
        : image;
    return resized.toDataURL();
  } catch {
    return null;
  }
}

async function readNativeFileIconDataUrl(
  targetPath: string
): Promise<string | null> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }

  try {
    const { app } = await import("electron");
    const icon = await app.getFileIcon(targetPath, { size: "large" });
    if (icon.isEmpty()) {
      return null;
    }
    return icon
      .resize({ height: entryIconPixelSize, width: entryIconPixelSize })
      .toDataURL();
  } catch {
    return null;
  }
}
