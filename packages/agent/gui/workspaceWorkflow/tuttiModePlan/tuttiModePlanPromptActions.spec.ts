import { describe, expect, it } from "vitest";
import type { TuttiPlanIssueSnapshot } from "../workspaceWorkflowRuntime";
import { tuttiModePlanTaskActionPrompt } from "./tuttiModePlanPromptActions";

const issue: TuttiPlanIssueSnapshot = {
  workflowId: "workflow-1",
  sourceTurnId: "turn-1",
  issueId: "issue-1",
  topicId: "topic/one",
  title: "Plan",
  dispatchPaused: false,
  tasks: [
    {
      taskId: "task-1",
      title: "Review [result]",
      content: "",
      status: "failed",
      sortIndex: 1,
      parallelizable: false,
      autoAccept: false,
      dependencyTaskIds: []
    }
  ]
};

const labels = {
  accept: (reference: string) => `Accept ${reference}`,
  rework: (reference: string) => `Rework ${reference}`
};

describe("tuttiModePlanTaskActionPrompt", () => {
  it.each([
    ["accept", "Accept"],
    ["rework", "Rework"]
  ] as const)(
    "builds an exact source-Agent %s draft with a task mention",
    (action, prefix) => {
      expect(
        tuttiModePlanTaskActionPrompt({
          action,
          issue,
          labels,
          taskId: "task-1",
          workspaceId: "workspace-1"
        })
      ).toBe(
        `${prefix} [Review \\[result\\]](mention://workspace-issue/issue-1?workspaceId=workspace-1&topicId=topic%2Fone&taskId=task-1)`
      );
    }
  );

  it("fails closed when the task is no longer in the current projection", () => {
    expect(
      tuttiModePlanTaskActionPrompt({
        action: "rework",
        issue,
        labels,
        taskId: "missing",
        workspaceId: "workspace-1"
      })
    ).toBeNull();
  });
});
