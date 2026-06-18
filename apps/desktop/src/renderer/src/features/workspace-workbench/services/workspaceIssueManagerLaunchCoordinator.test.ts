import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWorkspaceIssueManagerLaunchHandler,
  requestWorkspaceIssueManagerLaunch,
  type WorkspaceIssueManagerLaunchRequest
} from "./workspaceIssueManagerLaunchCoordinator.ts";

test("workspace issue-manager launch coordinator dispatches normalized requests", async () => {
  const requests: WorkspaceIssueManagerLaunchRequest[] = [];
  const dispose = registerWorkspaceIssueManagerLaunchHandler(
    " workspace-1 ",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      issueId: " issue-1 ",
      mode: "execute",
      outputDir: " issues/issue-1/runs/run-1 ",
      runId: " run-1 ",
      taskId: " task-1 ",
      topicId: " topic-1 ",
      workspaceId: " workspace-1 "
    }),
    true
  );
  dispose();
  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      issueId: "issue-1",
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.deepEqual(requests, [
    {
      issueId: "issue-1",
      mode: "execute",
      outputDir: "issues/issue-1/runs/run-1",
      runId: "run-1",
      taskId: "task-1",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    }
  ]);
});

test("workspace issue-manager launch coordinator dispatches workspace-only requests", async () => {
  const requests: WorkspaceIssueManagerLaunchRequest[] = [];
  const dispose = registerWorkspaceIssueManagerLaunchHandler(
    "workspace-1",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      issueId: "",
      workspaceId: " workspace-1 "
    }),
    true
  );
  dispose();
  assert.deepEqual(requests, [
    {
      workspaceId: "workspace-1"
    }
  ]);
});

test("workspace issue-manager launch coordinator rejects incomplete requests", async () => {
  const dispose = registerWorkspaceIssueManagerLaunchHandler(
    "workspace-issue-manager",
    () => {
      throw new Error("incomplete requests should not launch");
    }
  );

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      issueId: "issue-1",
      workspaceId: " "
    }),
    false
  );
  dispose();
});
