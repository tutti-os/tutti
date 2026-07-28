import assert from "node:assert/strict";
import { test } from "node:test";
import { executeIssueManagerProviderAction } from "./IssueManagerRunSections.tsx";

test("provider action remains pending until the Agent GUI launch settles", async () => {
  let resolveLaunch: (() => void) | undefined;
  const launch = new Promise<void>((resolve) => {
    resolveLaunch = resolve;
  });
  const pendingHistory: boolean[] = [];
  const selectedAgentTargetIds: string[] = [];

  const action = executeIssueManagerProviderAction({
    agentTargetId: "local:codex",
    onPendingChange(isPending) {
      pendingHistory.push(isPending);
    },
    async onSelectAgentTarget(agentTargetId) {
      selectedAgentTargetIds.push(agentTargetId);
      await launch;
    }
  });

  assert.deepEqual(pendingHistory, [true]);
  assert.deepEqual(selectedAgentTargetIds, ["local:codex"]);

  resolveLaunch?.();
  await action;

  assert.deepEqual(pendingHistory, [true, false]);
});

test("provider action clears pending state when the Agent GUI launch fails", async () => {
  const pendingHistory: boolean[] = [];

  await assert.rejects(
    executeIssueManagerProviderAction({
      agentTargetId: "local:codex",
      onPendingChange(isPending) {
        pendingHistory.push(isPending);
      },
      async onSelectAgentTarget() {
        throw new Error("launch failed");
      }
    }),
    /launch failed/
  );

  assert.deepEqual(pendingHistory, [true, false]);
});
