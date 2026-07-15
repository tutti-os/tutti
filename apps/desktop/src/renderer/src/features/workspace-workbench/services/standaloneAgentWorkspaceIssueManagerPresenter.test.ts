import assert from "node:assert/strict";
import test from "node:test";
import type { StandaloneAgentIssueManagerOpenRequest } from "./standaloneAgentIssueManagerLaunch.ts";
import { createStandaloneAgentWorkspaceIssueManagerPresenter } from "./standaloneAgentWorkspaceIssueManagerPresenter.ts";

test("standalone Agent issue-manager presenter opens Tasks inline with activation", () => {
  const requests: StandaloneAgentIssueManagerOpenRequest[] = [];
  const presenter = createStandaloneAgentWorkspaceIssueManagerPresenter({
    open: (request) => requests.push(request)
  });

  assert.equal(
    presenter.present({
      issueId: "issue-1",
      taskId: "task-1",
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.deepEqual(requests, [
    {
      activation: {
        payload: { issueId: "issue-1", taskId: "task-1" },
        sequence: 1,
        type: "open-workspace-issue"
      },
      requestID: "standalone-agent-issue-1"
    }
  ]);
});

test("standalone Agent issue-manager presenter sequences repeated inline opens", () => {
  const requestIDs: string[] = [];
  const presenter = createStandaloneAgentWorkspaceIssueManagerPresenter({
    open: (request) => requestIDs.push(request.requestID)
  });

  presenter.present({ workspaceId: "workspace-1" });
  presenter.present({ workspaceId: "workspace-1" });

  assert.deepEqual(requestIDs, [
    "standalone-agent-issue-1",
    "standalone-agent-issue-2"
  ]);
});
