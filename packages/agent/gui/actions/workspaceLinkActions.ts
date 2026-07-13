import { resolveWebsiteNavigationUrl } from "../shared/utils/websiteUrl";
import type { WorkspaceIssueMentionMode } from "@tutti-os/workspace-issue-manager/core";
import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { getAgentCustomMentionKind } from "../shared/agentCustomMentionKinds";

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
  mode?: "reveal" | "open-directory";
  path: string;
  directoryPath: string;
  workspaceRoot: string;
  source: WorkspaceLinkActionSource;
  prefetchedDirectoryListing?: WorkspaceFileLinkDirectoryListing | null;
}

export interface OpenLocalAssetPreviewLinkAction {
  type: "open-local-asset-preview";
  path: string;
  name: string;
  source: WorkspaceLinkActionSource;
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
  agentTargetId?: string | null;
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

export interface OpenWorkspaceAppLinkAction {
  type: "open-workspace-app";
  workspaceId: string;
  appId: string;
  conversationId?: string | null;
  messageId?: string | null;
  summaryTaskId?: string | null;
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

// 宿主注册的自定义 mention(shared/agentCustomMentionKinds,clickable=true)的点击动作:
// 携带原始 href 原样上抛,由宿主自行二次解析(包内不理解业务语义)。
export interface OpenCustomMentionLinkAction {
  type: "open-custom-mention";
  /** 注册表里的 kind(= mention:// providerId)。 */
  kind: string;
  href: string;
  source: WorkspaceLinkActionSource;
}

export type WorkspaceLinkAction =
  | OpenWorkspaceFileLinkAction
  | OpenLocalAssetPreviewLinkAction
  | OpenWorkspaceUrlLinkAction
  | OpenAgentSessionLinkAction
  | OpenWorkspaceIssueLinkAction
  | OpenWorkspaceAppLinkAction
  | OpenCustomMentionLinkAction;

const URL_LIKE_LINK_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:|^#/;
const LOCAL_ASSET_ROOT = "/var/cache/tsh/local-assets";

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

  const normalizedPath = normalizeWorkspaceFilePath(rawPath);
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
      workspaceRoot:
        normalizeWorkspaceFilePath(workspaceRoot?.trim() ?? "") || directoryPath
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
      workspaceRoot:
        normalizeWorkspaceFilePath(workspaceRoot?.trim() ?? "") || directoryPath
    };
  }

  const selectedRoot = normalizeWorkspaceFilePath(workspaceRoot?.trim() ?? "");
  const sessionRoot = normalizeWorkspaceFilePath(basePath?.trim() ?? "");
  const root = selectedRoot || sessionRoot;
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
  const resolvedPath = isAbsoluteLocalPath(normalizedPath)
    ? normalizedPath
    : normalizeWorkspaceFilePath(`${base}/${normalizedPath}`);
  if (
    !isInsideOrEqual(resolvedPath, root) &&
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

export function resolveLocalAssetPreviewLinkAction({
  path,
  source
}: {
  path: string;
  source: WorkspaceLinkActionSource;
}): OpenLocalAssetPreviewLinkAction | null {
  const rawPath = decodeWorkspaceLinkPath(path.trim());
  if (!rawPath || isUrlLikeWorkspaceFilePath(rawPath)) {
    return null;
  }

  const resolvedPath = normalizeWorkspaceFilePath(rawPath);
  if (
    resolvedPath === LOCAL_ASSET_ROOT ||
    !isInsideOrEqual(resolvedPath, LOCAL_ASSET_ROOT)
  ) {
    return null;
  }
  if (resolvedPath.endsWith(".metadata.json")) {
    return null;
  }

  return {
    type: "open-local-asset-preview",
    path: resolvedPath,
    name: basename(resolvedPath),
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
  | OpenWorkspaceAppLinkAction
  | OpenCustomMentionLinkAction
  | null {
  const mention = parseRichTextMentionHref(href, "");
  if (!mention) {
    return null;
  }

  // 注册的自定义 kind 的 scope 键由宿主约定(未必带 workspaceId),
  // 必须在下面的 workspaceId 必填检查之前处理。
  const customDefinition = getAgentCustomMentionKind(mention.providerId);
  if (customDefinition) {
    if (!customDefinition.clickable) {
      return null;
    }
    return {
      type: "open-custom-mention",
      kind: mention.providerId.trim().toLowerCase(),
      href: href.trim(),
      source
    };
  }

  const workspaceId = mention.scope?.workspaceId?.trim() || "";
  const targetId = mention.entityId.trim();
  if (!workspaceId || !targetId) {
    return null;
  }

  if (mention.providerId === "agent-session") {
    const agentTargetId = mention.scope?.agentTargetId?.trim() || null;
    return {
      type: "open-agent-session",
      workspaceId,
      agentSessionId: targetId,
      ...(agentTargetId ? { agentTargetId } : {}),
      source
    };
  }

  if (mention.providerId === "workspace-issue") {
    const mode = parseWorkspaceIssueMentionMode(mention.scope?.mode ?? null);
    const outputDir = mention.scope?.outputDir?.trim() || "";
    const runId = mention.scope?.runId?.trim() || "";
    const taskId = mention.scope?.taskId?.trim() || "";
    const topicId = mention.scope?.topicId?.trim() || "";
    return {
      type: "open-workspace-issue",
      workspaceId,
      issueId: targetId,
      ...(mode ? { mode } : {}),
      ...(outputDir ? { outputDir } : {}),
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(topicId ? { topicId } : {}),
      source
    };
  }

  if (mention.providerId === "workspace-app") {
    const messageId = mention.scope?.messageId?.trim() || null;
    const summaryTaskId = mention.scope?.summaryTaskId?.trim() || null;
    const conversationId = mention.scope?.conversationId?.trim() || null;
    return {
      type: "open-workspace-app",
      workspaceId,
      appId: targetId,
      ...(messageId ? { messageId } : {}),
      ...(summaryTaskId ? { summaryTaskId } : {}),
      ...(conversationId ? { conversationId } : {}),
      source
    };
  }

  return null;
}

function parseWorkspaceIssueMentionMode(
  value: string | null
): WorkspaceIssueMentionMode | null {
  const trimmed = value?.trim();
  return trimmed === "breakdown" || trimmed === "execute" ? trimmed : null;
}

export function resolveWorkspaceLinkAction({
  href,
  workspaceRoot,
  basePath,
  source
}: ResolveWorkspaceLinkActionInput): WorkspaceLinkAction | null {
  return (
    resolveWorkspaceMentionLinkAction({ href, source }) ??
    resolveLocalAssetPreviewLinkAction({
      path: href,
      source
    }) ??
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

function isHomeRelativeWorkspaceFilePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

function dirnameForHomeRelativePath(path: string): string {
  return path === "~" ? "~" : dirname(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path);
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

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
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

function isStagedLocalAssetPath(path: string): boolean {
  return path !== LOCAL_ASSET_ROOT && isInsideOrEqual(path, LOCAL_ASSET_ROOT);
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
