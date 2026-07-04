import type {
  IssueManagerContextRef,
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../i18n/issueManagerI18n.ts";
import { buildWorkspaceIssueMentionHref } from "./workspaceIssueMention.ts";

type IssueManagerPromptCopy = Pick<IssueManagerI18nRuntime, "t">;

export function resolveIssueManagerWorkspaceRuntimePath(
  workspaceRoot: string,
  requestedPath: string
): string {
  const normalizedWorkspaceRoot = workspaceRoot.trim().replace(/\/+$/, "");
  const normalizedRequestedPath = requestedPath.trim();

  if (!normalizedWorkspaceRoot || !normalizedRequestedPath) {
    return normalizedRequestedPath;
  }

  if (
    normalizedRequestedPath === normalizedWorkspaceRoot ||
    normalizedRequestedPath.startsWith(`${normalizedWorkspaceRoot}/`)
  ) {
    return normalizedRequestedPath;
  }

  if (normalizedRequestedPath === "/workspace") {
    return normalizedWorkspaceRoot;
  }

  if (normalizedRequestedPath.startsWith("/workspace/")) {
    return `${normalizedWorkspaceRoot}/${normalizedRequestedPath.slice("/workspace/".length)}`;
  }

  if (!normalizedRequestedPath.startsWith("/")) {
    return `${normalizedWorkspaceRoot}/${normalizedRequestedPath.replace(/^\/+/, "")}`;
  }

  return normalizedRequestedPath;
}

export function buildIssueManagerRunPrompt(input: {
  copy?: IssueManagerPromptCopy;
  issue: IssueManagerIssueSummary;
  task?: IssueManagerTaskSummary;
  workspaceRoot: string;
}): string {
  const mentionMarkdown = buildIssueManagerIssueMention({
    issue: input.issue,
    task: input.task,
    mode: "execute"
  });
  const intro =
    input.copy?.t("runPrompts.executeIntro") ?? "Handle this task reference.";
  return `${intro} ${mentionMarkdown}`;
}

export function buildIssueManagerTaskBreakdownPrompt(input: {
  copy?: IssueManagerPromptCopy;
  issueDetail: {
    contextRefs: readonly IssueManagerContextRef[];
    issue: IssueManagerIssueSummary;
    tasks: readonly IssueManagerTaskSummary[];
  };
  workspaceId: string;
}): string {
  const issue = input.issueDetail.issue;
  const issueMention = buildIssueManagerIssueMention({
    issue,
    mode: "breakdown"
  });

  const intro =
    input.copy?.t("runPrompts.breakdownIntro") ??
    "Break this task reference down into executable tasks.";
  return `${intro} ${issueMention}`;
}

function buildIssueManagerIssueMention(input: {
  issue: IssueManagerIssueSummary;
  task?: IssueManagerTaskSummary;
  mode: "breakdown" | "execute";
  outputDir?: string | null;
  runId?: string | null;
}): string {
  const labelParts = [input.issue.title.trim(), input.task?.title.trim() || ""]
    .filter(Boolean)
    .map((value) =>
      escapeIssueManagerMentionLabel(value.replace(/^@+/, "").trim())
    );
  const href = buildWorkspaceIssueMentionHref({
    issueId: input.issue.issueId,
    mode: input.mode,
    outputDir: input.outputDir,
    runId: input.runId,
    taskId: input.task?.taskId,
    topicId: input.issue.topicId,
    workspaceId: input.issue.workspaceId
  });
  return `[@${labelParts.join(" / ")}](${href})`;
}

function escapeIssueManagerMentionLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}
