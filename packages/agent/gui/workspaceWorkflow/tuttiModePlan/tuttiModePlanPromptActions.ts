import { buildWorkspaceIssueMentionHref } from "@tutti-os/workspace-issue-manager/core";
import type {
  TuttiPlanIssueSnapshot,
  TuttiPlanIssueTaskSnapshot
} from "../workspaceWorkflowRuntime";

export type TuttiModePlanTaskPromptAction = "accept" | "rework";

export interface TuttiModePlanTaskPromptLabels {
  accept(reference: string): string;
  rework(reference: string): string;
}

function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function taskReference(input: {
  issue: TuttiPlanIssueSnapshot;
  task: TuttiPlanIssueTaskSnapshot;
  workspaceId: string;
}): string {
  const href = buildWorkspaceIssueMentionHref({
    issueId: input.issue.issueId,
    taskId: input.task.taskId,
    topicId: input.issue.topicId,
    workspaceId: input.workspaceId
  });
  const label = input.task.title.trim() || input.task.taskId;
  return href
    ? `[${escapeMarkdownLabel(label)}](${href})`
    : escapeMarkdownLabel(label);
}

/**
 * Converts a plan-panel user action into a source-Agent draft prompt.
 *
 * This is intentionally presentation-only: it does not claim Tutti execution
 * authority or mutate a managed Issue. Sending the resulting draft lets the
 * source Agent inspect the canonical execution and use its fenced commands.
 */
export function tuttiModePlanTaskActionPrompt(input: {
  action: TuttiModePlanTaskPromptAction;
  issue: TuttiPlanIssueSnapshot;
  labels: TuttiModePlanTaskPromptLabels;
  taskId: string;
  workspaceId: string;
}): string | null {
  const task = input.issue.tasks.find(
    (candidate) => candidate.taskId === input.taskId
  );
  if (!task) {
    return null;
  }
  const reference = taskReference({
    issue: input.issue,
    task,
    workspaceId: input.workspaceId
  });
  return input.labels[input.action](reference).trim() || null;
}
