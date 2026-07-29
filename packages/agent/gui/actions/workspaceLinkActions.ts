import type { WorkspaceIssueMentionMode } from "@tutti-os/workspace-issue-manager/core";
import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { getAgentCustomMentionKind } from "../shared/agentCustomMentionKinds";
import {
  AGENT_EXTERNAL_LINK_ACTION_SOURCE,
  resolveAgentSessionMentionLinkAction,
  resolveWorkspaceUrlLinkAction,
  type OpenAgentSessionLinkAction,
  type OpenWorkspaceUrlLinkAction,
  type WorkspaceLinkActionSource
} from "./portableWorkspaceNavigationActions";
import {
  decodeWorkspaceLinkPath,
  isInsideOrEqualWorkspaceFilePath,
  isUrlLikeWorkspaceFilePath,
  normalizeWorkspaceFilePath,
  resolveWorkspaceFilePathCandidate,
  workspaceFilePathBasename
} from "./workspaceFilePathCandidate";

export { AGENT_EXTERNAL_LINK_ACTION_SOURCE, resolveWorkspaceUrlLinkAction };
export {
  isDirectAgentGeneratedMediaPath,
  resolveWorkspaceFilePathCandidate
} from "./workspaceFilePathCandidate";
export type {
  OpenAgentSessionLinkAction,
  OpenWorkspaceUrlLinkAction,
  ResolveWorkspaceUrlLinkActionInput,
  WorkspaceLinkActionSource
} from "./portableWorkspaceNavigationActions";
export type {
  ResolvedWorkspaceFilePathCandidate,
  ResolveWorkspaceFilePathCandidateInput
} from "./workspaceFilePathCandidate";

export interface ResolveWorkspaceFileLinkActionInput {
  path: string;
  workspaceRoot?: string | null;
  basePath?: string | null;
  source: WorkspaceLinkActionSource;
}

export interface OpenWorkspaceFileLinkAction {
  type: "open-workspace-file";
  mode?: "select" | "open";
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

const LOCAL_ASSET_ROOT = "/var/cache/tsh/local-assets";

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
    !isInsideOrEqualWorkspaceFilePath(resolvedPath, LOCAL_ASSET_ROOT)
  ) {
    return null;
  }
  if (resolvedPath.endsWith(".metadata.json")) {
    return null;
  }

  return {
    type: "open-local-asset-preview",
    path: resolvedPath,
    name: workspaceFilePathBasename(resolvedPath),
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

  const agentSessionAction = resolveAgentSessionMentionLinkAction({
    href,
    source
  });
  if (agentSessionAction) {
    return agentSessionAction;
  }

  const workspaceId = mention.scope?.workspaceId?.trim() || "";
  const targetId = mention.entityId.trim();
  if (!workspaceId || !targetId) {
    return null;
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

  if (
    mention.providerId === "workspace-reference" &&
    mention.scope?.source?.trim() === "app"
  ) {
    return {
      type: "open-workspace-app",
      workspaceId,
      appId: targetId,
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
