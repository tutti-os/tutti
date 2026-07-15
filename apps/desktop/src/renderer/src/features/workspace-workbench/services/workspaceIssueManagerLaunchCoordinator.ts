import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry.ts";

export interface WorkspaceIssueManagerLaunchRequest {
  issueId?: string | null;
  mode?: "breakdown" | "execute";
  outputDir?: string | null;
  runId?: string | null;
  taskId?: string | null;
  topicId?: string | null;
  workspaceId: string;
}

export interface WorkspaceIssueManagerLaunchPresenter {
  present(
    request: WorkspaceIssueManagerLaunchRequest
  ): Promise<boolean> | boolean;
}

const presenters =
  new WorkspaceScopedRegistrationRegistry<WorkspaceIssueManagerLaunchPresenter>();

export function registerWorkspaceIssueManagerLaunchPresenter(
  workspaceId: string,
  presenter: WorkspaceIssueManagerLaunchPresenter
): () => void {
  return presenters.register(workspaceId, presenter);
}

export async function requestWorkspaceIssueManagerLaunch(
  request: WorkspaceIssueManagerLaunchRequest
): Promise<boolean> {
  const normalized = normalizeWorkspaceIssueManagerLaunchRequest(request);
  if (!normalized) {
    return false;
  }

  const presenter = presenters.get(normalized.workspaceId);
  if (!presenter) {
    return false;
  }

  return presenter.present(normalized);
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
