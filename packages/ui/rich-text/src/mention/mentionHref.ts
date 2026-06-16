export type RichTextMentionFileKind = "file" | "directory" | "unknown";
export type RichTextMentionScope = "my_sessions" | "collab_sessions";
export type RichTextMentionHrefKind =
  | "file"
  | "session"
  | "workspace-app"
  | "workspace-app-factory"
  | "workspace-issue";

export interface RichTextMentionFileItem {
  kind: "file";
  path: string;
  href: string;
  name: string;
  entryKind: RichTextMentionFileKind;
  directoryPath: string;
}

export interface RichTextMentionSessionItem {
  kind: "session";
  href: string;
  workspaceId: string;
  targetId: string;
  name: string;
  title: string;
  scope: RichTextMentionScope;
  initiatorName: string;
  agentName: string;
}

export interface RichTextMentionWorkspaceIssueItem {
  kind: "workspace-issue";
  href: string;
  workspaceId: string;
  targetId: string;
  name: string;
  title: string;
}

export interface RichTextMentionWorkspaceAppItem {
  kind: "workspace-app";
  href: string;
  workspaceId: string;
  targetId: string;
  appId: string;
  name: string;
}

export interface RichTextMentionWorkspaceAppFactoryItem {
  kind: "workspace-app-factory";
  href: string;
  workspaceId: string;
  targetId: string;
  jobId: string;
  name: string;
  action?: string;
  contextPath?: string;
}

export type RichTextMentionHrefItem =
  | RichTextMentionFileItem
  | RichTextMentionSessionItem
  | RichTextMentionWorkspaceAppItem
  | RichTextMentionWorkspaceAppFactoryItem
  | RichTextMentionWorkspaceIssueItem;

export interface ParsedMentionMarkdown {
  item: RichTextMentionHrefItem;
  end: number;
}

export function buildAgentSessionMentionHref(
  workspaceId: string,
  agentSessionId: string,
  provider?: string | null
): string {
  const params = workspaceMentionSearchParams(workspaceId, agentSessionId);
  const normalizedProvider = provider?.trim() ?? "";
  if (normalizedProvider) {
    params.set("provider", normalizedProvider);
  }
  return `mention://agent-session?${params.toString()}`;
}

export function buildWorkspaceIssueMentionHref(
  workspaceId: string,
  issueId: string,
  input?: {
    mode?: "breakdown" | "execute";
    outputDir?: string | null;
    runId?: string | null;
    taskId?: string | null;
    topicId?: string | null;
  }
): string {
  const params = workspaceMentionSearchParams(workspaceId, issueId);
  const mode = input?.mode?.trim() ?? "";
  const outputDir = input?.outputDir?.trim() ?? "";
  const topicId = input?.topicId?.trim() ?? "";
  const taskId = input?.taskId?.trim() ?? "";
  const runId = input?.runId?.trim() ?? "";
  if (mode) {
    params.set("mode", mode);
  }
  if (outputDir) {
    params.set("outputDir", outputDir);
  }
  if (topicId) {
    params.set("topicId", topicId);
  }
  if (taskId) {
    params.set("taskId", taskId);
  }
  if (runId) {
    params.set("runId", runId);
  }
  return `mention://workspace-issue?${params.toString()}`;
}

export function buildWorkspaceAppMentionHref(
  workspaceId: string,
  appId: string
): string {
  const params = new URLSearchParams({
    workspaceId: workspaceId.trim(),
    appId: appId.trim()
  });
  return `mention://workspace-app?${params.toString()}`;
}

export function buildWorkspaceAppFactoryMentionHref(
  workspaceId?: string | null,
  jobId?: string | null,
  input?: { action?: string | null; contextPath?: string | null }
): string {
  const params = new URLSearchParams();
  const trimmedWorkspaceId = workspaceId?.trim() ?? "";
  const trimmedJobId = jobId?.trim() ?? "";
  const action = input?.action?.trim() ?? "";
  const contextPath = input?.contextPath?.trim() ?? "";
  if (trimmedWorkspaceId) {
    params.set("workspaceId", trimmedWorkspaceId);
  }
  if (trimmedJobId) {
    params.set("jobId", trimmedJobId);
  }
  if (action) {
    params.set("action", action);
  }
  if (contextPath) {
    params.set("contextPath", contextPath);
  }
  const query = params.toString();
  return query
    ? `mention://workspace-app-factory?${query}`
    : "mention://workspace-app-factory";
}

export function formatMentionMarkdown(input: {
  href: string;
  name: string;
}): string {
  return `[@${escapeMarkdownLinkLabel(input.name)}](${escapeMarkdownLinkTarget(input.href)})`;
}

export function parseMentionMarkdown(
  value: string,
  start = 0
): ParsedMentionMarkdown | null {
  if (!value.startsWith("[", start)) {
    return null;
  }

  let index = start + 1;
  const prefixedMention = value[index] === "@";
  if (prefixedMention) {
    index += 1;
  }
  let name = "";
  while (index < value.length) {
    const current = value[index];
    if (current === "\\") {
      const escaped = value[index + 1];
      if (escaped === "\\" || escaped === "[" || escaped === "]") {
        name += escaped;
        index += 2;
        continue;
      }
      name += current;
      index += 1;
      continue;
    }
    if (current === "]") {
      break;
    }
    name += current;
    index += 1;
  }

  if (value[index] !== "]" || value[index + 1] !== "(") {
    return null;
  }

  index += 2;
  let href = "";
  while (index < value.length) {
    const current = value[index];
    if (current === "\\") {
      const escaped = value[index + 1];
      if (escaped === "\\" || escaped === ")") {
        href += escaped;
        index += 2;
        continue;
      }
      href += current;
      index += 1;
      continue;
    }
    if (current === ")") {
      const item = parseMentionItemFromHref({ name, href });
      if (!item) {
        return null;
      }
      if (item.kind !== "file" && !prefixedMention) {
        return null;
      }
      return {
        item,
        end: index + 1
      };
    }
    href += current;
    index += 1;
  }

  return null;
}

export function parseMentionMarkdownHref(
  href: string,
  label: string
): RichTextMentionHrefItem | null {
  return parseMentionItemFromHref({
    href,
    name: label.replace(/^@+/, "").trim()
  });
}

export function parseMentionItemFromHref(input: {
  name: string;
  href: string;
}): RichTextMentionHrefItem | null {
  const href = input.href.trim();
  if (!href) {
    return null;
  }
  if (!href.startsWith("mention://")) {
    return {
      kind: "file",
      href,
      path: href,
      name: input.name,
      entryKind: isLocalDirectoryMentionHref(href) ? "directory" : "unknown",
      directoryPath: dirnameFromPath(href)
    };
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const resource = url.hostname.trim().toLowerCase();
  const workspaceId = workspaceIdFromMentionUrl(url);
  const targetId =
    resource === "workspace-app"
      ? (url.searchParams.get("appId")?.trim() ?? "")
      : resource === "workspace-app-factory"
        ? (url.searchParams.get("jobId")?.trim() ?? "")
        : (url.searchParams.get("id")?.trim() ?? "");
  if (resource !== "workspace-app-factory" && (!workspaceId || !targetId)) {
    return null;
  }
  if (resource === "agent-session") {
    return {
      kind: "session",
      href,
      workspaceId,
      targetId,
      name: input.name,
      title: input.name,
      scope: "collab_sessions",
      initiatorName: "",
      agentName: ""
    };
  }
  if (resource === "workspace-issue") {
    return {
      kind: "workspace-issue",
      href,
      workspaceId,
      targetId,
      name: input.name,
      title: input.name
    };
  }
  if (resource === "workspace-app") {
    return {
      kind: "workspace-app",
      href,
      workspaceId,
      targetId,
      appId: targetId,
      name: input.name
    };
  }
  if (resource === "workspace-app-factory") {
    return {
      kind: "workspace-app-factory",
      href,
      workspaceId,
      targetId,
      jobId: targetId,
      name: input.name || "Workspace App Factory",
      action: url.searchParams.get("action")?.trim() || undefined,
      contextPath: url.searchParams.get("contextPath")?.trim() || undefined
    };
  }
  return null;
}

export function workspaceIdFromMentionHref(href: string): string {
  try {
    return workspaceIdFromMentionUrl(new URL(href));
  } catch {
    return "";
  }
}

/** @deprecated Use buildWorkspaceIssueMentionHref. */
export const buildAgentWorkspaceIssueMentionHref =
  buildWorkspaceIssueMentionHref;
/** @deprecated Use buildWorkspaceAppMentionHref. */
export const buildAgentWorkspaceAppMentionHref = buildWorkspaceAppMentionHref;
/** @deprecated Use buildWorkspaceAppFactoryMentionHref. */
export const buildAgentWorkspaceAppFactoryMentionHref =
  buildWorkspaceAppFactoryMentionHref;
/** @deprecated Use parseMentionMarkdown. */
export const parseAgentMentionMarkdown = parseMentionMarkdown;

function workspaceMentionSearchParams(
  workspaceId: string,
  targetId: string
): URLSearchParams {
  const normalizedWorkspaceId = workspaceId.trim();
  return new URLSearchParams({
    workspaceId: normalizedWorkspaceId,
    id: targetId
  });
}

function workspaceIdFromMentionUrl(url: URL): string {
  return url.searchParams.get("workspaceId")?.trim() ?? "";
}

function isLocalDirectoryMentionHref(href: string): boolean {
  return href.endsWith("/") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href);
}

function dirnameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return path.startsWith("/") ? "/" : "";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownLinkTarget(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}
