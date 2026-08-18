import { normalizeWorkspaceFilePath as normalizeLogicalWorkspaceFilePath } from "@tutti-os/workspace-file-manager/services";

const URL_LIKE_LINK_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:|^#/;
const LOCAL_ASSET_ROOT = "/var/cache/tsh/local-assets";

export interface ResolveWorkspaceFilePathCandidateInput {
  path: string;
  workspaceRoot?: string | null;
  basePath?: string | null;
}

export interface ResolvedWorkspaceFilePathCandidate {
  path: string;
  directoryPath: string;
  workspaceRoot: string;
}

/**
 * Pure file-path policy shared by transcript projection and host link actions.
 * It intentionally has no Workspace mention, app, issue, registry, or renderer
 * dependencies.
 */
export function resolveWorkspaceFilePathCandidate({
  path,
  workspaceRoot,
  basePath
}: ResolveWorkspaceFilePathCandidateInput): ResolvedWorkspaceFilePathCandidate | null {
  const rawPath = decodeWorkspaceLinkPath(path.trim());
  if (
    !rawPath ||
    isUrlLikeWorkspaceFilePath(rawPath) ||
    isUncWorkspaceFilePath(rawPath)
  ) {
    return null;
  }

  const selectedRoot = normalizeWorkspaceFilePath(workspaceRoot?.trim() ?? "");
  const sessionRoot = normalizeWorkspaceFilePath(basePath?.trim() ?? "");
  const root = selectedRoot || sessionRoot;
  const normalizedPath = normalizeWorkspaceFilePath(
    stripWorkspaceFileLineAnchor(rawPath),
    sessionRoot || root
  );
  if (isUnsupportedSpecialWorkspaceFilePath(normalizedPath)) {
    return null;
  }
  if (isStagedLocalAssetPath(normalizedPath)) {
    return null;
  }
  if (isHomeRelativeWorkspaceFilePath(normalizedPath)) {
    const directoryPath = dirnameForHomeRelativePath(normalizedPath);
    return {
      path: normalizedPath,
      directoryPath,
      workspaceRoot: selectedRoot || directoryPath
    };
  }
  if (
    isAbsoluteLocalPath(normalizedPath) &&
    (isDirectAgentGeneratedMediaPath(normalizedPath) ||
      isDirectWorkspaceAppDataPath(normalizedPath))
  ) {
    const directoryPath = dirname(normalizedPath);
    return {
      path: normalizedPath,
      directoryPath,
      workspaceRoot: selectedRoot || directoryPath
    };
  }

  if (!root) {
    return null;
  }
  if (isAbsoluteLocalPath(normalizedPath)) {
    const directoryPath = dirname(normalizedPath);
    return {
      path: normalizedPath,
      directoryPath,
      workspaceRoot: root
    };
  }
  const base = normalizeWorkspaceFilePath(basePath?.trim() || root);
  const resolvedPath = normalizeWorkspaceFilePath(`${base}/${normalizedPath}`);
  if (
    !isInsideOrEqualWorkspaceFilePath(resolvedPath, root) &&
    !isDirectAgentGeneratedMediaPath(resolvedPath)
  ) {
    return null;
  }

  return {
    path: resolvedPath,
    directoryPath: resolvedPath === root ? root : dirname(resolvedPath),
    workspaceRoot: root
  };
}

export function normalizeWorkspaceFilePath(
  path: string,
  rootPath?: string | null
): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  const normalizedRootPath = rootPath?.trim().replaceAll("\\", "/");
  if (
    isWindowsAbsolutePath(normalizedPath) ||
    isGitBashWindowsAbsolutePath(normalizedPath, normalizedRootPath)
  ) {
    return normalizeLogicalWorkspaceFilePath(
      normalizedPath,
      normalizedRootPath
    );
  }

  const drive = /^[A-Za-z]:/.exec(normalizedPath)?.[0] ?? "";
  const startsWithSlash = normalizedPath.startsWith("/");
  const pathBody = drive
    ? normalizedPath.slice(drive.length)
    : startsWithSlash
      ? normalizedPath.slice(1)
      : normalizedPath;
  const parts: string[] = [];
  for (const part of pathBody.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (drive) {
    return parts.length > 0 ? `${drive}/${parts.join("/")}` : `${drive}/`;
  }
  if (startsWithSlash) {
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }
  return parts.join("/");
}

export function isUrlLikeWorkspaceFilePath(path: string): boolean {
  if (path.startsWith("#")) {
    return true;
  }
  if (isWindowsAbsolutePath(path.trim().replaceAll("\\", "/"))) {
    return false;
  }
  return URL_LIKE_LINK_PATTERN.test(path);
}

export function decodeWorkspaceLinkPath(path: string): string {
  if (!path.includes("%")) {
    return path;
  }
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * Agent Markdown source links use a terminal `:line` suffix. File launchers
 * operate on filesystem paths, so remove that presentation-only location
 * anchor before resolving the path.
 */
function stripWorkspaceFileLineAnchor(path: string): string {
  return path.replace(/:[1-9]\d*$/, "");
}

export function workspaceFilePathBasename(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function isInsideOrEqualWorkspaceFilePath(
  path: string,
  root: string
): boolean {
  if (root === "/") {
    return path.startsWith("/");
  }
  const comparison =
    isWindowsAbsolutePath(root) || isWindowsAbsolutePath(path)
      ? { path: path.toLowerCase(), root: root.toLowerCase() }
      : { path, root };
  return (
    comparison.path === comparison.root ||
    comparison.path.startsWith(`${comparison.root}/`)
  );
}

export function isDirectAgentGeneratedMediaPath(path: string): boolean {
  if (!isAbsoluteLocalPath(path)) {
    return false;
  }
  const statePath = getTuttiStatePathSegments(path);
  if (!statePath) {
    return false;
  }
  if (
    statePath[1] !== "agent" ||
    statePath[2] !== "runs" ||
    (!statePath.includes("generated_images") &&
      !statePath.includes("generated_videos"))
  ) {
    return false;
  }
  return /\.(?:png|jpe?g|gif|webp|bmp|mp4|webm)$/i.test(path);
}

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function isHomeRelativeWorkspaceFilePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

function dirnameForHomeRelativePath(path: string): string {
  return path === "~" ? "~" : dirname(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^\/?[A-Za-z]:\//.test(path);
}

function isGitBashWindowsAbsolutePath(
  path: string,
  rootPath?: string | null
): boolean {
  const rootDrive = readWindowsDrive(rootPath ?? "");
  const pathDrive = /^\/([A-Za-z])(?=\/|$)/.exec(path)?.[1];
  return Boolean(
    rootDrive && pathDrive && `${pathDrive}:`.toUpperCase() === rootDrive
  );
}

function readWindowsDrive(path: string): string {
  return /^\/?([A-Za-z]:)(?=\/|$)/.exec(path)?.[1]?.toUpperCase() ?? "";
}

function isUncWorkspaceFilePath(path: string): boolean {
  return /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(path);
}

function isUnsupportedSpecialWorkspaceFilePath(path: string): boolean {
  const comparisonPath = cleanWorkspaceFilePathForComparison(path);
  return (
    comparisonPath === "/dev/null" ||
    comparisonPath.split("/").some((segment) => {
      const normalized = segment.trim().replace(/[. ]+$/g, "");
      const deviceName = normalized.split(".", 1)[0]?.toUpperCase();
      return deviceName === "NUL";
    })
  );
}

function cleanWorkspaceFilePathForComparison(path: string): string {
  const normalized = path.replace(/\/+/g, "/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return normalized.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return path.slice(0, index);
}

function isStagedLocalAssetPath(path: string): boolean {
  return (
    path !== LOCAL_ASSET_ROOT &&
    isInsideOrEqualWorkspaceFilePath(path, LOCAL_ASSET_ROOT)
  );
}

function isDirectWorkspaceAppDataPath(path: string): boolean {
  if (!isAbsoluteLocalPath(path)) {
    return false;
  }
  const statePath = getTuttiStatePathSegments(path);
  if (!statePath) {
    return false;
  }
  return (
    statePath[1] === "apps" &&
    statePath[2] === "workspaces" &&
    statePath.length > 5
  );
}

function getTuttiStatePathSegments(path: string): string[] | null {
  const segments = path.split("/").filter(Boolean);
  const stateRootIndex = segments.findIndex(
    (segment) => segment === ".tutti" || segment === ".tutti-dev"
  );
  if (stateRootIndex < 0) {
    return null;
  }
  return segments.slice(stateRootIndex);
}
