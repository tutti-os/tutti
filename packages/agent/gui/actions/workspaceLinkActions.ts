import { resolveWebsiteNavigationUrl } from "../shared/utils/websiteUrl";
import {
  parseWorkspaceIssueMentionHref,
  type WorkspaceIssueMentionMode
} from "@tutti-os/workspace-issue-manager/core";

export type WorkspaceLinkActionSource =
  | "agent-markdown"
  | "agent-file-change"
  | string;

export interface ResolveWorkspaceFileLinkActionInput {
  path: string;
  workspaceRoot?: string | null;
  basePath?: string | null;
  source: WorkspaceLinkActionSource;
}

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

export interface OpenWorkspaceFileLinkAction {
  type: "open-workspace-file";
  path: string;
  directoryPath: string;
  workspaceRoot: string;
  source: WorkspaceLinkActionSource;
  prefetchedDirectoryListing?: WorkspaceFileLinkDirectoryListing | null;
}

export interface WorkspaceFileLinkDirectoryEntry {
  path: string;
  name: string;
  kind: "file" | "directory" | "unknown";
  hasChildren: boolean | null;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

export interface WorkspaceFileLinkDirectoryListing {
  workspaceId: string;
  root: string;
  directoryPath: string;
  entries: WorkspaceFileLinkDirectoryEntry[];
}

export interface OpenWorkspaceUrlLinkAction {
  type: "open-url";
  url: string;
  source: WorkspaceLinkActionSource;
}

export interface OpenAgentSessionLinkAction {
  type: "open-agent-session";
  workspaceId: string;
  agentSessionId: string;
  provider?: string | null;
  source: WorkspaceLinkActionSource;
}

export interface OpenWorkspaceIssueLinkAction {
  type: "open-workspace-issue";
  workspaceId: string;
  issueId: string | null;
  mode?: WorkspaceIssueMentionMode;
  outputDir?: string | null;
  runId?: string | null;
  taskId?: string | null;
  topicId?: string | null;
  source: WorkspaceLinkActionSource;
}

export interface ResolveWorkspaceUrlLinkActionInput {
  url: string;
  source: WorkspaceLinkActionSource;
}

export interface ResolveWorkspaceMentionLinkActionInput {
  href: string;
  source: WorkspaceLinkActionSource;
}

export interface ResolveWorkspaceLinkActionInput {
  href: string;
  workspaceRoot?: string | null;
  basePath?: string | null;
  source: WorkspaceLinkActionSource;
}

export type WorkspaceLinkAction =
  | OpenWorkspaceFileLinkAction
  | OpenWorkspaceUrlLinkAction
  | OpenAgentSessionLinkAction
  | OpenWorkspaceIssueLinkAction;

const URL_LIKE_LINK_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:|^#/;

export function resolveWorkspaceFilePathCandidate({
  path,
  workspaceRoot,
  basePath
}: ResolveWorkspaceFilePathCandidateInput): ResolvedWorkspaceFilePathCandidate | null {
  const rawPath = decodeWorkspaceLinkPath(path.trim());
  const root = normalizeWorkspaceFilePath(workspaceRoot?.trim() ?? "");
  if (!rawPath || !root || isUrlLikeWorkspaceFilePath(rawPath)) {
    return null;
  }

  const normalizedPath = normalizeWorkspaceFilePath(rawPath);
  const base = normalizeWorkspaceFilePath(basePath?.trim() || root);
  const resolvedPath = isAbsoluteLocalPath(normalizedPath)
    ? normalizedPath
    : normalizeWorkspaceFilePath(`${base}/${normalizedPath}`);
  if (
    !isInsideOrEqual(resolvedPath, root) &&
    !isDirectAgentGeneratedImagePath(resolvedPath)
  ) {
    return null;
  }

  return {
    path: resolvedPath,
    directoryPath: resolvedPath === root ? root : dirname(resolvedPath),
    workspaceRoot: root
  };
}

export function resolveWorkspaceFileLinkAction({
  path,
  workspaceRoot,
  basePath,
  source
}: ResolveWorkspaceFileLinkActionInput): OpenWorkspaceFileLinkAction | null {
  const candidate = resolveWorkspaceFilePathCandidate({
    path,
    workspaceRoot,
    basePath
  });
  if (!candidate) {
    return null;
  }

  return {
    type: "open-workspace-file",
    path: candidate.path,
    directoryPath: candidate.directoryPath,
    workspaceRoot: candidate.workspaceRoot,
    source
  };
}

export function resolveWorkspaceUrlLinkAction({
  url,
  source
}: ResolveWorkspaceUrlLinkActionInput): OpenWorkspaceUrlLinkAction | null {
  const resolved = resolveWebsiteNavigationUrl(url);
  if (!resolved.url || resolved.error) {
    return null;
  }

  return {
    type: "open-url",
    url: resolved.url,
    source
  };
}

export function resolveWorkspaceMentionLinkAction({
  href,
  source
}: ResolveWorkspaceMentionLinkActionInput):
  | OpenAgentSessionLinkAction
  | OpenWorkspaceIssueLinkAction
  | null {
  const rawHref = href.trim();
  if (!rawHref.toLowerCase().startsWith("mention://")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawHref);
  } catch {
    return null;
  }

  const workspaceId = url.searchParams.get("workspaceId")?.trim() || "";
  const targetId = url.searchParams.get("id")?.trim() || "";
  if (!workspaceId || !targetId) {
    return null;
  }

  if (url.hostname === "agent-session") {
    const provider = url.searchParams.get("provider")?.trim() || null;
    return {
      type: "open-agent-session",
      workspaceId,
      agentSessionId: targetId,
      ...(provider ? { provider } : {}),
      source
    };
  }

  if (url.hostname === "workspace-issue") {
    const parsedIssueMention = parseWorkspaceIssueMentionHref(rawHref);
    if (!parsedIssueMention) {
      return null;
    }
    return {
      type: "open-workspace-issue",
      workspaceId: parsedIssueMention.workspaceId,
      issueId: parsedIssueMention.issueId,
      ...(parsedIssueMention.mode ? { mode: parsedIssueMention.mode } : {}),
      ...(parsedIssueMention.outputDir
        ? { outputDir: parsedIssueMention.outputDir }
        : {}),
      ...(parsedIssueMention.runId ? { runId: parsedIssueMention.runId } : {}),
      ...(parsedIssueMention.taskId
        ? { taskId: parsedIssueMention.taskId }
        : {}),
      ...(parsedIssueMention.topicId
        ? { topicId: parsedIssueMention.topicId }
        : {}),
      source
    };
  }

  return null;
}

export function resolveWorkspaceLinkAction({
  href,
  workspaceRoot,
  basePath,
  source
}: ResolveWorkspaceLinkActionInput): WorkspaceLinkAction | null {
  return (
    resolveWorkspaceMentionLinkAction({ href, source }) ??
    resolveWorkspaceFileLinkAction({
      path: href,
      workspaceRoot,
      basePath,
      source
    }) ??
    resolveWorkspaceUrlLinkAction({ url: href, source })
  );
}

function normalizeWorkspaceFilePath(path: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
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

function isUrlLikeWorkspaceFilePath(path: string): boolean {
  if (path.startsWith("#")) {
    return true;
  }
  if (isWindowsAbsolutePath(path.trim().replaceAll("\\", "/"))) {
    return false;
  }
  return URL_LIKE_LINK_PATTERN.test(path);
}

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path);
}

function decodeWorkspaceLinkPath(path: string): string {
  if (!path.includes("%")) {
    return path;
  }
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return path.slice(0, index);
}

function isInsideOrEqual(path: string, root: string): boolean {
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

function isDirectAgentGeneratedImagePath(path: string): boolean {
  if (!isAbsoluteLocalPath(path)) {
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  const stateRootIndex = segments.findIndex(
    (segment) => segment === ".tutti" || segment === ".tutti-dev"
  );
  if (stateRootIndex < 0) {
    return false;
  }
  const statePath = segments.slice(stateRootIndex);
  if (
    statePath[1] !== "agent" ||
    statePath[2] !== "runs" ||
    !statePath.includes("generated_images")
  ) {
    return false;
  }
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path);
}
