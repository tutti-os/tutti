import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceAgentWaitingNotificationLeaseRegistry } from "./workspaceAgentWaitingNotificationLease.ts";

test("waiting notification lease permits one owner and promotes its standby", () => {
  const registry = createWorkspaceAgentWaitingNotificationLeaseRegistry();
  const first = {};
  const second = {};
  let secondUpdates = 0;
  const releaseFirst = registry.register("workspace-1", first, () => {});
  const releaseSecond = registry.register("workspace-1", second, () => {
    secondUpdates += 1;
  });

  assert.equal(registry.isOwner("workspace-1", first), true);
  assert.equal(registry.isOwner("workspace-1", second), false);

  releaseFirst();
  assert.equal(registry.isOwner("workspace-1", second), true);
  assert.equal(secondUpdates, 1);

  releaseSecond();
  assert.equal(registry.isOwner("workspace-1", second), false);
});

test("waiting notification leases are independent per workspace", () => {
  const registry = createWorkspaceAgentWaitingNotificationLeaseRegistry();
  const first = {};
  const second = {};
  registry.register("workspace-1", first, () => {});
  registry.register("workspace-2", second, () => {});

  assert.equal(registry.isOwner("workspace-1", first), true);
  assert.equal(registry.isOwner("workspace-2", second), true);
});
