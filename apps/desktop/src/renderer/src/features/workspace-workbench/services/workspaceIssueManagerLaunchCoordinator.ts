export interface WorkspaceIssueManagerLaunchRequest {
  issueId?: string | null;
  mode?: "breakdown" | "execute";
  outputDir?: string | null;
  runId?: string | null;
  taskId?: string | null;
  topicId?: string | null;
  workspaceId: string;
}

export type WorkspaceIssueManagerLaunchHandler = (
  request: WorkspaceIssueManagerLaunchRequest
) => Promise<boolean> | boolean;

const launchHandlersByWorkspaceId = new Map<
  string,
  WorkspaceIssueManagerLaunchHandler
>();

export function registerWorkspaceIssueManagerLaunchHandler(
  workspaceId: string,
  handler: WorkspaceIssueManagerLaunchHandler
): () => void {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return noop;
  }

  launchHandlersByWorkspaceId.set(normalizedWorkspaceId, handler);
  return () => {
    if (launchHandlersByWorkspaceId.get(normalizedWorkspaceId) === handler) {
      launchHandlersByWorkspaceId.delete(normalizedWorkspaceId);
    }
  };
}

export async function requestWorkspaceIssueManagerLaunch(
  request: WorkspaceIssueManagerLaunchRequest
): Promise<boolean> {
  const normalized = normalizeWorkspaceIssueManagerLaunchRequest(request);
  if (!normalized) {
    return false;
  }

  const handler = launchHandlersByWorkspaceId.get(normalized.workspaceId);
  if (!handler) {
    return false;
  }

  return handler(normalized);
}

function normalizeWorkspaceIssueManagerLaunchRequest(
  request: WorkspaceIssueManagerLaunchRequest
): WorkspaceIssueManagerLaunchRequest | null {
  const workspaceId = request.workspaceId.trim();
  if (!workspaceId) {
    return null;
  }
  const issueId = normalizeOptionalString(request.issueId);
  if (!issueId) {
    return { workspaceId };
  }

  const mode =
    request.mode === "breakdown" || request.mode === "execute"
      ? request.mode
      : undefined;
  const outputDir = normalizeOptionalString(request.outputDir);
  const runId = normalizeOptionalString(request.runId);
  const taskId = normalizeOptionalString(request.taskId);
  const topicId = normalizeOptionalString(request.topicId);

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

function normalizeOptionalString(
  value: string | null | undefined
): string | undefined {
  const normalized = value?.trim() || "";
  return normalized || undefined;
}

function noop(): void {}
