import type {
  IssueManagerIssueSummary,
  IssueManagerRun,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";

export function resolveIssueManagerIssueAcceptanceTaskId(input: {
  latestRun: IssueManagerRun | null;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTaskId: string | null;
  tasks: readonly IssueManagerTaskSummary[];
}): string | null {
  if (
    input.selectedIssue?.status !== "pending_acceptance" ||
    input.latestRun?.status !== "completed"
  ) {
    return null;
  }

  return resolveIssueManagerIssueRunTaskId(input);
}

export function resolveIssueManagerIssueRunTaskId(input: {
  latestRun: IssueManagerRun | null;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTaskId: string | null;
  tasks: readonly IssueManagerTaskSummary[];
}): string | null {
  if (!input.selectedIssue || input.selectedTaskId) {
    return null;
  }

  const taskId = input.latestRun?.taskId?.trim() ?? "";
  if (!taskId) {
    return null;
  }

  const visibleTask = input.tasks.find((task) => task.taskId === taskId);
  const issueTitle = input.selectedIssue.title.trim();
  const taskTitle = visibleTask?.title.trim() ?? "";
  if (visibleTask && taskTitle !== "" && taskTitle !== issueTitle) {
    return null;
  }

  return taskId;
}

export function resolveIssueManagerVisibleSubtasks(input: {
  hiddenIssueRunTaskId: string | null;
  tasks: readonly IssueManagerTaskSummary[];
}): IssueManagerTaskSummary[] {
  const hiddenTaskId = input.hiddenIssueRunTaskId?.trim() ?? "";
  if (!hiddenTaskId) {
    return [...input.tasks];
  }

  return input.tasks.filter((task) => {
    return task.taskId !== hiddenTaskId;
  });
}
