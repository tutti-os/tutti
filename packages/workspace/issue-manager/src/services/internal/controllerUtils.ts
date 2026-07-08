import type {
  IssueManagerIssueSummary,
  IssueManagerFileReference,
  IssueManagerPriority,
  IssueManagerTaskSummary
} from "../../contracts/index.ts";
import type { IssueManagerWorkspaceFileLinkInput } from "../../core/index.ts";
import type { IssueManagerI18nRuntime } from "../../i18n/issueManagerI18n.ts";

export const defaultTaskPriority: IssueManagerPriority = "medium";

export function resolveIssueManagerSelectedIssueId(
  currentSelectedIssueId: string | null | undefined,
  issues: readonly IssueManagerIssueSummary[]
): string | null {
  if (
    currentSelectedIssueId &&
    issues.some((issue) => issue.issueId === currentSelectedIssueId)
  ) {
    return currentSelectedIssueId;
  }
  return issues[0]?.issueId ?? null;
}

export function resolveIssueManagerSelectedTaskId(
  currentSelectedTaskId: string | null | undefined,
  tasks: readonly IssueManagerTaskSummary[]
): string | null {
  if (
    currentSelectedTaskId &&
    tasks.some((task) => task.taskId === currentSelectedTaskId)
  ) {
    return currentSelectedTaskId;
  }
  return null;
}

export function toContextRefInput(ref: IssueManagerFileReference) {
  return {
    displayName: ref.displayName,
    path: ref.path,
    refType: ref.kind === "folder" ? "folder" : "file"
  };
}

export function toIssueManagerWorkspaceFileLinkInput(
  ref: IssueManagerFileReference
): IssueManagerWorkspaceFileLinkInput {
  return {
    kind: ref.kind === "folder" ? "folder" : "file",
    name: ref.displayName,
    path: ref.path
  };
}

export function confirmIssueManagerMessage(message: string): boolean {
  try {
    return globalThis.confirm?.(message) ?? true;
  } catch {
    return true;
  }
}

export function resolveIssueManagerErrorMessage(
  error: unknown,
  copy?: IssueManagerI18nRuntime,
  fallbackKey?: string
): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);

  if (!copy) {
    return raw;
  }

  if (raw === "issue_manager.upload_type_conflict") {
    return copy.t("messages.uploadTypeConflict");
  }
  if (raw === "issue_manager.clipboard_unavailable") {
    return copy.t("messages.clipboardUnavailable");
  }
  if (raw === "issue_manager.workspace_path_unavailable") {
    return copy.t("messages.workspacePathUnavailable");
  }
  if (raw === "issue_manager.agent_gui_launch_unavailable") {
    return copy.t("messages.agentGuiLaunchUnavailable");
  }
  if (raw === "issue_manager.run_status_missing") {
    return copy.t("messages.runStatusMissing");
  }
  if (raw === "issue_manager.run_timed_out") {
    return copy.t("messages.runTimedOut");
  }
  if (raw.startsWith("issue_manager.run_exit_code:")) {
    return copy.t("messages.runExitCode", {
      code: raw.slice("issue_manager.run_exit_code:".length)
    });
  }

  return fallbackKey ? copy.t(fallbackKey) : raw;
}

export function resolveIssueManagerTopicDeleteErrorMessage(
  error: unknown,
  copy: IssueManagerI18nRuntime
): string {
  const protocolError = extractProtocolErrorShape(error);
  if (!protocolError) {
    return resolveIssueManagerErrorMessage(
      error,
      copy,
      "messages.topicDeleteFailed"
    );
  }

  if (protocolError.reason === "workspace_issue_topic_not_empty") {
    return copy.t("messages.topicDeleteNotEmpty");
  }

  if (protocolError.reason === "workspace_issue_topic_not_found") {
    return copy.t("messages.topicDeleteNotFound");
  }

  if (
    protocolError.code === "invalid_request" &&
    protocolError.reason === "malformed_request"
  ) {
    return copy.t("messages.topicDeleteDefaultForbidden");
  }

  return copy.t("messages.topicDeleteFailed");
}

interface ProtocolErrorShape {
  code: string;
  reason?: string;
}

function extractProtocolErrorShape(error: unknown): ProtocolErrorShape | null {
  if (isProtocolErrorShape(error)) {
    return error;
  }

  if (typeof error !== "object" || error === null || !("error" in error)) {
    return null;
  }

  const nestedError = (error as { error?: unknown }).error;
  return isProtocolErrorShape(nestedError) ? nestedError : null;
}

function isProtocolErrorShape(value: unknown): value is ProtocolErrorShape {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    (!("reason" in value) ||
      typeof (value as { reason?: unknown }).reason === "string" ||
      typeof (value as { reason?: unknown }).reason === "undefined")
  );
}
