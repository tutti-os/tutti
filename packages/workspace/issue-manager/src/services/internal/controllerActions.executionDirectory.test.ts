import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceUserProjectApi,
  WorkspaceUserProjectService,
  WorkspaceUserProjectValtioStore
} from "@tutti-os/workspace-user-project/contracts";
import type {
  IssueManagerAgentBreakdownRequest,
  IssueManagerAgentRunRequest
} from "../../contracts/index.ts";
import {
  createControllerActionsHarness,
  createIssueSummary,
  createTaskSummary
} from "./controllerActionTestHarness.ts";

function stubDefaultProjectService(
  defaultPath: string
): WorkspaceUserProjectService {
  return {
    async getDefaultSelection() {
      return { path: defaultPath };
    },
    prepareSelection() {
      throw new Error("not used in this test");
    },
    refresh() {
      throw new Error("not used in this test");
    },
    store: {
      error: null,
      initialized: true,
      isLoading: false,
      projects: [],
      revision: 0
    } as unknown as WorkspaceUserProjectValtioStore
  };
}

test("controller actions useExecutionDirectory updates state and remembers the project", async () => {
  const usedPaths: string[] = [];
  const harness = createControllerActionsHarness({
    executionDirectoryPicker: {
      async use(
        input: Parameters<NonNullable<WorkspaceUserProjectApi["use"]>>[0]
      ) {
        usedPaths.push(input.path);
        return {
          id: "project-1",
          label: "tutti",
          path: input.path,
          pinnedAtUnixMs: 0
        };
      }
    }
  });

  await harness.actions.useExecutionDirectory("  /workspace/tutti  ");

  assert.deepEqual(usedPaths, ["/workspace/tutti"]);
  assert.equal(
    harness.nodeState.current.selectedExecutionDirectory,
    "/workspace/tutti"
  );
});

test("controller actions keep selected execution directory when recency tracking fails", async () => {
  const harness = createControllerActionsHarness({
    executionDirectoryPicker: {
      async use() {
        throw new Error("recency failed");
      }
    }
  });

  await harness.actions.useExecutionDirectory("/workspace/tutti");

  assert.equal(
    harness.nodeState.current.selectedExecutionDirectory,
    "/workspace/tutti"
  );
  assert.equal(harness.notificationState.current, null);
});

test("controller actions support missing execution directory picker methods", async () => {
  const harness = createControllerActionsHarness({
    executionDirectoryPicker: {}
  });

  await harness.actions.useExecutionDirectory("/workspace/tutti");

  assert.equal(
    harness.nodeState.current.selectedExecutionDirectory,
    "/workspace/tutti"
  );
});

test("controller actions fall back to the remembered default project when running a task without an explicit execution directory", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const issue = createIssueSummary({ issueId: "issue-1", title: "Issue" });
  const task = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Task"
  });
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return { status: "opened" };
      }
    },
    executionDirectoryPicker: {
      service: stubDefaultProjectService("/workspace/test-tutti")
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [task]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task
    }
  });

  await harness.actions.runTask();

  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0]?.executionDirectory, "/workspace/test-tutti");
  // The user never touched the picker, so it should remain unset in state -
  // only the outgoing run request gets the resolved default.
  assert.equal(
    harness.nodeState.current.selectedExecutionDirectory ?? null,
    null
  );
});

test("controller actions do not override an explicitly selected execution directory when running a task", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const issue = createIssueSummary({ issueId: "issue-1", title: "Issue" });
  const task = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Task"
  });
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return { status: "opened" };
      }
    },
    executionDirectoryPicker: {
      service: stubDefaultProjectService("/workspace/should-not-be-used")
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [task]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: "/workspace/picked-by-user",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task
    }
  });

  await harness.actions.runTask();

  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0]?.executionDirectory, "/workspace/picked-by-user");
});

test("controller actions fall back to the remembered default project when starting a task breakdown without an explicit execution directory", async () => {
  const breakdownCalls: IssueManagerAgentBreakdownRequest[] = [];
  const issue = createIssueSummary({ issueId: "issue-1", title: "Issue" });
  const harness = createControllerActionsHarness({
    agentBreakdownLauncher: {
      async startBreakdown(input) {
        breakdownCalls.push(input);
        return { status: "opened" };
      }
    },
    executionDirectoryPicker: {
      service: stubDefaultProjectService("/workspace/test-tutti")
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: []
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.startTaskBreakdown();

  assert.equal(breakdownCalls.length, 1);
  assert.equal(breakdownCalls[0]?.executionDirectory, "/workspace/test-tutti");
});
