import assert from "node:assert/strict";
import test from "node:test";
import { defaultIssueManagerWorkbenchTypeId } from "@tutti-os/workspace-issue-manager/workbench/constants";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { createWorkbenchWorkspaceIssueManagerPresenter } from "./workbenchWorkspaceIssueManagerPresenter.ts";

test("workbench issue-manager presenter launches and activates a workbench node", async () => {
  const launches: unknown[] = [];
  const activations: unknown[] = [];
  const presenter = createWorkbenchWorkspaceIssueManagerPresenter({
    host: {
      activateNode: (...args: unknown[]) => {
        activations.push(args);
      },
      launchNode: async (request: unknown) => {
        launches.push(request);
        return "issue-manager-node";
      }
    } as unknown as WorkbenchHostHandle
  });

  assert.equal(
    await presenter.present({
      issueId: "issue-1",
      mode: "execute",
      outputDir: "issues/issue-1/runs/run-1",
      runId: "run-1",
      taskId: "task-1",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.deepEqual(launches, [
    {
      launchSource: "agent_command",
      reason: "host",
      typeId: defaultIssueManagerWorkbenchTypeId
    }
  ]);
  assert.deepEqual(activations, [
    [
      { nodeId: "issue-manager-node" },
      {
        payload: {
          issueId: "issue-1",
          mode: "execute",
          outputDir: "issues/issue-1/runs/run-1",
          runId: "run-1",
          taskId: "task-1",
          topicId: "topic-1"
        },
        type: "open-workspace-issue"
      }
    ]
  ]);
});

test("workbench issue-manager presenter opens the surface without activation", async () => {
  let activationCount = 0;
  const presenter = createWorkbenchWorkspaceIssueManagerPresenter({
    host: {
      activateNode: () => {
        activationCount += 1;
      },
      launchNode: async () => "issue-manager-node"
    } as unknown as WorkbenchHostHandle
  });

  assert.equal(await presenter.present({ workspaceId: "workspace-1" }), true);
  assert.equal(activationCount, 0);
});

test("workbench issue-manager presenter reports a rejected launch", async () => {
  const presenter = createWorkbenchWorkspaceIssueManagerPresenter({
    host: {
      activateNode: () => undefined,
      launchNode: async () => null
    } as unknown as WorkbenchHostHandle
  });

  assert.equal(await presenter.present({ workspaceId: "workspace-1" }), false);
});
