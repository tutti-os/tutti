import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  DesktopWorkspaceAppOpenFileRequest,
  DesktopWorkspaceAppOpenFileResolvedPayload
} from "../../shared/contracts/ipc";
import { resolveDesktopDefaultsFromEnv } from "../defaults.ts";
import {
  resolveWorkspaceLogicalFilePath,
  workspaceLogicalRoot
} from "./workspaceFilePaths.ts";
import { resolveWorkspaceAppFolderPath } from "./workspaceAppFolderPaths.ts";

export async function resolveWorkspaceAppOpenFilePayload(input: {
  appId: string;
  request: DesktopWorkspaceAppOpenFileRequest;
  workspaceId: string;
}): Promise<DesktopWorkspaceAppOpenFileResolvedPayload> {
  const stateRootDir = resolveDesktopDefaultsFromEnv().state.rootDir;
  const absolutePath = await resolveWorkspaceAppOpenFileAbsolutePath(
    stateRootDir,
    input
  );
  const name =
    input.request.name?.trim() ||
    basename(absolutePath) ||
    input.request.path.trim();
  return {
    absolutePath,
    appId: input.appId,
    mode: input.request.mode ?? "preview",
    mtimeMs: input.request.mtimeMs ?? null,
    name,
    sizeBytes: input.request.sizeBytes ?? null,
    workspaceId: input.workspaceId
  };
}

async function resolveWorkspaceAppOpenFileAbsolutePath(
  stateRootDir: string,
  input: {
    appId: string;
    request: DesktopWorkspaceAppOpenFileRequest;
    workspaceId: string;
  }
): Promise<string> {
  const rawPath = input.request.path.trim();
  if (!rawPath) {
    throw new Error("Workspace app open file path is required.");
  }

  if (isAbsolute(rawPath)) {
    await assertAllowedWorkspaceAppAbsolutePath(stateRootDir, input, rawPath);
    return rawPath;
  }

  const location = input.request.location;
  const relativePath = location?.path?.trim() || rawPath;
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("..")
  ) {
    throw new Error("Workspace app open file path is invalid.");
  }

  const locationType = location?.type ?? "app-data-relative";
  let absolutePath = "";
  switch (locationType) {
    case "app-data-relative":
      absolutePath = join(
        resolveWorkspaceAppFolderPath(stateRootDir, {
          appId: input.appId,
          folderKind: "data",
          workspaceId: input.workspaceId
        }),
        relativePath
      );
      break;
    case "app-package-relative":
      absolutePath = join(
        resolveWorkspaceAppFolderPath(stateRootDir, {
          appId: input.appId,
          folderKind: "package",
          version: input.request.packageVersion ?? null,
          workspaceId: input.workspaceId
        }),
        relativePath
      );
      break;
    case "workspace-relative":
      absolutePath = resolveWorkspaceLogicalFilePath({
        logicalPath: relativePath,
        logicalRoot: workspaceLogicalRoot,
        physicalRootDirectory: homedir()
      });
      break;
    default:
      throw new Error("Workspace app open file location type is unsupported.");
  }

  await access(absolutePath);
  return absolutePath;
}

async function assertAllowedWorkspaceAppAbsolutePath(
  stateRootDir: string,
  input: { appId: string; workspaceId: string },
  absolutePath: string
): Promise<void> {
  const allowedRoots = [
    resolveWorkspaceAppFolderPath(stateRootDir, {
      appId: input.appId,
      folderKind: "data",
      workspaceId: input.workspaceId
    }),
    resolve(homedir())
  ];
  const resolvedPath = resolve(absolutePath);
  if (
    !allowedRoots.some((root) => isPathWithinRoot(resolvedPath, resolve(root)))
  ) {
    throw new Error("Workspace app open file path is outside allowed roots.");
  }
  await access(resolvedPath);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
