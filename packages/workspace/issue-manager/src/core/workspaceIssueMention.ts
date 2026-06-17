export type WorkspaceIssueMentionMode = "breakdown" | "execute";

export interface BuildWorkspaceIssueMentionHrefInput {
  issueId: string;
  mode?: WorkspaceIssueMentionMode;
  outputDir?: string | null;
  runId?: string | null;
  taskId?: string | null;
  topicId?: string | null;
  workspaceId: string;
}

export interface ParsedWorkspaceIssueMention {
  issueId: string;
  mode?: WorkspaceIssueMentionMode;
  outputDir?: string;
  runId?: string;
  taskId?: string;
  topicId?: string;
  workspaceId: string;
}

export function buildWorkspaceIssueMentionHref(
  input: BuildWorkspaceIssueMentionHrefInput
): string {
  const workspaceId = input.workspaceId.trim();
  const issueId = input.issueId.trim();
  if (!workspaceId || !issueId) {
    return "";
  }

  const params = new URLSearchParams({
    workspaceId
  });
  appendWorkspaceIssueMentionParam(params, "topicId", input.topicId);
  appendWorkspaceIssueMentionParam(
    params,
    "mode",
    normalizeMentionMode(input.mode)
  );
  appendWorkspaceIssueMentionParam(params, "taskId", input.taskId);
  appendWorkspaceIssueMentionParam(params, "runId", input.runId);
  appendWorkspaceIssueMentionParam(params, "outputDir", input.outputDir);
  return [
    `mention://workspace-issue/${encodeURIComponent(issueId)}`,
    params.toString()
  ].join("?");
}

export function parseWorkspaceIssueMentionHref(
  href: string
): ParsedWorkspaceIssueMention | null {
  const trimmedHref = href.trim();
  if (!trimmedHref.toLowerCase().startsWith("mention://workspace-issue")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmedHref);
  } catch {
    return null;
  }
  if (url.protocol !== "mention:" || url.hostname !== "workspace-issue") {
    return null;
  }
  if (hasUnsupportedWorkspaceIssueMentionParam(url.searchParams)) {
    return null;
  }

  const workspaceId = url.searchParams.get("workspaceId")?.trim() || "";
  const issueId = safeDecodeURIComponent(
    url.pathname.replace(/^\/+/, "")
  ).trim();
  if (!workspaceId || !issueId) {
    return null;
  }

  const mode = normalizeMentionMode(url.searchParams.get("mode"));
  const topicId = optionalSearchParam(url.searchParams, "topicId");
  const taskId = optionalSearchParam(url.searchParams, "taskId");
  const runId = optionalSearchParam(url.searchParams, "runId");
  const outputDir = optionalSearchParam(url.searchParams, "outputDir");

  return {
    issueId,
    ...(mode ? { mode } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(topicId ? { topicId } : {}),
    workspaceId
  };
}

function appendWorkspaceIssueMentionParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined
): void {
  const normalized = value?.trim() || "";
  if (normalized) {
    params.set(key, normalized);
  }
}

function optionalSearchParam(
  params: URLSearchParams,
  key: string
): string | undefined {
  const value = params.get(key)?.trim() || "";
  return value || undefined;
}

const workspaceIssueMentionQueryParams = new Set([
  "workspaceId",
  "topicId",
  "mode",
  "taskId",
  "runId",
  "outputDir"
]);

function hasUnsupportedWorkspaceIssueMentionParam(
  params: URLSearchParams
): boolean {
  return [...params.keys()].some((key) => {
    const normalizedKey = key.trim();
    return (
      !workspaceIssueMentionQueryParams.has(normalizedKey) ||
      normalizedKey.startsWith("meta.")
    );
  });
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function normalizeMentionMode(
  value: string | null | undefined
): WorkspaceIssueMentionMode | undefined {
  return value === "breakdown" || value === "execute" ? value : undefined;
}
