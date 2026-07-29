import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceAppUserProjectSnapshotBridge } from "./workspaceAppUserProjectSnapshots.ts";
import type { WorkspaceUserProjectServiceSnapshot } from "@tutti-os/workspace-user-project/contracts";

const baseSnapshot: WorkspaceUserProjectServiceSnapshot = {
  error: null,
  initialized: true,
  isLoading: false,
  projects: [
    {
      id: "repo",
      label: "repo",
      path: "/workspace/repo",
      pinnedAtUnixMs: 0
    }
  ],
  revision: 1
};

test("workspace app user project snapshots replay the latest cached snapshot", async () => {
  const bridge = createWorkspaceAppUserProjectSnapshotBridge();
  const snapshots: WorkspaceUserProjectServiceSnapshot[] = [];

  bridge.publish(baseSnapshot);
  const unsubscribe = bridge.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });
  await waitForMicrotasks();
  unsubscribe();

  assert.deepEqual(snapshots, [baseSnapshot]);
});

test("workspace app user project snapshots skip replay after unsubscribe", async () => {
  const bridge = createWorkspaceAppUserProjectSnapshotBridge();
  const snapshots: WorkspaceUserProjectServiceSnapshot[] = [];

  bridge.publish(baseSnapshot);
  const unsubscribe = bridge.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });
  unsubscribe();
  await waitForMicrotasks();

  assert.deepEqual(snapshots, []);
});

test("workspace app user project snapshots avoid replaying stale cached state", async () => {
  const bridge = createWorkspaceAppUserProjectSnapshotBridge();
  const snapshots: WorkspaceUserProjectServiceSnapshot[] = [];
  const nextSnapshot = {
    ...baseSnapshot,
    projects: [
      {
        id: "next",
        label: "next",
        path: "/workspace/next",
        pinnedAtUnixMs: 1
      }
    ],
    revision: 2
  };

  bridge.publish(baseSnapshot);
  const unsubscribe = bridge.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });
  bridge.publish(nextSnapshot);
  await waitForMicrotasks();
  unsubscribe();

  assert.deepEqual(snapshots, [nextSnapshot]);
});

function waitForMicrotasks(): Promise<void> {
  return Promise.resolve();
}
