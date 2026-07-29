import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import type { IssueManagerController } from "../../react/index.ts";
import { resolveIssueManagerIssueAcceptanceTaskId } from "../issue/IssueManagerIssueAcceptanceState.ts";
import { resolveIssueManagerTaskDrawerViewState } from "../shell/IssueManagerTaskDrawerState.ts";

const managedIssue: IssueManagerIssueSummary = {
  creatorUserId: "tutti",
  issueId: "issue-managed",
  planningSource: "tutti_mode_plan",
  sourceSessionId: "source-session-9",
  status: "pending_acceptance",
  title: "Managed workflow",
  topicId: "topic-1",
  workspaceId: "workspace-1"
};

const managedTask: IssueManagerTaskSummary = {
  creatorUserId: "tutti",
  issueId: managedIssue.issueId,
  priority: "medium",
  status: "pending_acceptance",
  taskId: "task-managed",
  title: "Managed task",
  workspaceId: managedIssue.workspaceId
};

test("managed Tutti task read view exposes no edit, delete, run, or acceptance controls", () => {
  const controller = createManagedController();
  const view = resolveIssueManagerTaskDrawerViewState({
    controller,
    selectedTask: managedTask
  });

  assert.equal(view.showTaskActions, false);
  assert.equal(view.showReadFooter, false);
  assert.equal(
    resolveIssueManagerIssueAcceptanceTaskId({
      latestRun: {
        agentProvider: "codex",
        agentUserId: "agent",
        issueId: managedIssue.issueId,
        requesterUserId: "tutti",
        runId: "run-1",
        status: "completed",
        taskId: managedTask.taskId,
        workspaceId: managedIssue.workspaceId
      },
      selectedIssue: managedIssue,
      selectedTaskId: null,
      tasks: [managedTask]
    }),
    null
  );
});

function createManagedController(): Pick<
  IssueManagerController,
  | "copy"
  | "isTuttiModePlanIssue"
  | "taskDetail"
  | "taskDraft"
  | "taskEditorMode"
> {
  return {
    copy: {
      t(key: string) {
        return key;
      }
    } as IssueManagerController["copy"],
    isTuttiModePlanIssue: true,
    taskDetail: {
      error: null,
      isLoading: false,
      value: null
    },
    taskDraft: {
      content: "",
      priority: "medium",
      title: managedTask.title
    },
    taskEditorMode: "read"
  };
}
