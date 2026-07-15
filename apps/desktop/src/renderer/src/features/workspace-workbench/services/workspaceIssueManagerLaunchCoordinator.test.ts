import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWorkspaceIssueManagerLaunchPresenter,
  requestWorkspaceIssueManagerLaunch,
  type WorkspaceIssueManagerLaunchRequest
} from "./workspaceIssueManagerLaunchCoordinator.ts";

test("workspace issue-manager launch coordinator dispatches normalized requests", async () => {
  const requests: WorkspaceIssueManagerLaunchRequest[] = [];
  const dispose = registerWorkspaceIssueManagerLaunchPresenter(
    " workspace-1 ",
    {
      present(request) {
        requests.push(request);
        return true;
      }
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
  const dispose = registerWorkspaceIssueManagerLaunchPresenter("workspace-1", {
    present(request) {
      requests.push(request);
      return true;
    }
  });

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
  const dispose = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-issue-manager",
    {
      present() {
        throw new Error("incomplete requests should not launch");
      }
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

test("workspace issue-manager launch coordinator isolates workspace presenters", async () => {
  const calls: string[] = [];
  const disposeFirst = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-1",
    {
      present() {
        calls.push("workspace-1");
        return true;
      }
    }
  );
  const disposeSecond = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-2",
    {
      present() {
        calls.push("workspace-2");
        return true;
      }
    }
  );

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({ workspaceId: "workspace-2" }),
    true
  );
  assert.deepEqual(calls, ["workspace-2"]);

  disposeFirst();
  disposeSecond();
});

test("workspace issue-manager launch coordinator keeps replacement after stale disposal", async () => {
  const disposeFirst = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-replaced",
    { present: () => false }
  );
  const disposeReplacement = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-replaced",
    { present: () => true }
  );

  disposeFirst();

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      workspaceId: "workspace-replaced"
    }),
    true
  );
  disposeReplacement();
});

test("workspace issue-manager launch coordinator distinguishes repeated presenter registrations", async () => {
  const presenter = { present: () => true };
  const disposeFirst = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-repeated",
    presenter
  );
  const disposeReplacement = registerWorkspaceIssueManagerLaunchPresenter(
    "workspace-repeated",
    presenter
  );

  disposeFirst();

  assert.equal(
    await requestWorkspaceIssueManagerLaunch({
      workspaceId: "workspace-repeated"
    }),
    true
  );
  disposeReplacement();
});
