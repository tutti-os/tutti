import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueSummary,
  createRun,
  createTaskSummary
} from "../../../services/internal/controllerActionTestHarness.ts";
import {
  resolveIssueManagerIssueAcceptanceTaskId,
  resolveIssueManagerIssueRunTaskId,
  resolveIssueManagerVisibleSubtasks
} from "./IssueManagerIssueAcceptanceState.ts";

test("issue acceptance targets the latest issue-level execution task", () => {
  const taskId = resolveIssueManagerIssueAcceptanceTaskId({
    latestRun: createRun({
      issueId: "issue-1",
      runId: "run-1",
      status: "completed",
      taskId: "task-hidden"
    }),
    selectedIssue: createIssueSummary({
      issueId: "issue-1",
      status: "pending_acceptance",
      title: "Issue"
    }),
    selectedTaskId: null,
    tasks: [
      createTaskSummary({
        issueId: "issue-1",
        status: "pending_acceptance",
        taskId: "task-hidden",
        title: "Issue"
      })
    ]
  });

  assert.equal(taskId, "task-hidden");
});

test("issue acceptance does not duplicate normal visible subtask acceptance", () => {
  const taskId = resolveIssueManagerIssueAcceptanceTaskId({
    latestRun: createRun({
      issueId: "issue-1",
      runId: "run-1",
      status: "completed",
      taskId: "task-visible"
    }),
    selectedIssue: createIssueSummary({
      issueId: "issue-1",
      status: "pending_acceptance",
      title: "Issue"
    }),
    selectedTaskId: null,
    tasks: [
      createTaskSummary({
        issueId: "issue-1",
        status: "pending_acceptance",
        taskId: "task-visible",
        title: "Visible task"
      })
    ]
  });

  assert.equal(taskId, null);
});

test("issue acceptance stays hidden when a task is already selected", () => {
  const taskId = resolveIssueManagerIssueAcceptanceTaskId({
    latestRun: createRun({
      issueId: "issue-1",
      runId: "run-1",
      status: "completed",
      taskId: "task-hidden"
    }),
    selectedIssue: createIssueSummary({
      issueId: "issue-1",
      status: "pending_acceptance",
      title: "Issue"
    }),
    selectedTaskId: "task-hidden",
    tasks: []
  });

  assert.equal(taskId, null);
});

test("issue run task is hidden from subtasks after acceptance", () => {
  const taskId = resolveIssueManagerIssueRunTaskId({
    latestRun: createRun({
      issueId: "issue-1",
      runId: "run-1",
      status: "completed",
      taskId: "task-hidden"
    }),
    selectedIssue: createIssueSummary({
      issueId: "issue-1",
      status: "completed",
      title: "Issue"
    }),
    selectedTaskId: null,
    tasks: [
      createTaskSummary({
        issueId: "issue-1",
        status: "completed",
        taskId: "task-hidden",
        title: "Issue"
      })
    ]
  });

  assert.equal(taskId, "task-hidden");
});

test("issue run task detection keeps normal visible subtasks", () => {
  const taskId = resolveIssueManagerIssueRunTaskId({
    latestRun: createRun({
      issueId: "issue-1",
      runId: "run-1",
      status: "completed",
      taskId: "task-visible"
    }),
    selectedIssue: createIssueSummary({
      issueId: "issue-1",
      status: "completed",
      title: "Issue"
    }),
    selectedTaskId: null,
    tasks: [
      createTaskSummary({
        issueId: "issue-1",
        status: "completed",
        taskId: "task-visible",
        title: "Visible task"
      })
    ]
  });

  assert.equal(taskId, null);
});

test("issue subtask list hides the issue-level execution task", () => {
  const hiddenTask = createTaskSummary({
    issueId: "issue-1",
    status: "pending_acceptance",
    taskId: "task-hidden",
    title: "Issue"
  });
  const visibleTask = createTaskSummary({
    issueId: "issue-1",
    status: "not_started",
    taskId: "task-visible",
    title: "Visible task"
  });

  const tasks = resolveIssueManagerVisibleSubtasks({
    hiddenIssueRunTaskId: "task-hidden",
    tasks: [hiddenTask, visibleTask]
  });

  assert.deepEqual(
    tasks.map((task) => task.taskId),
    ["task-visible"]
  );
});
