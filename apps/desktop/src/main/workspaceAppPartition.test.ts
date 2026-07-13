import assert from "node:assert/strict";
import test from "node:test";
import {
  isWorkspaceAppSessionPartitionAllowed,
  parseWorkspaceAppSessionPartition,
  workspaceAppBrowserPartitionPrefix
} from "./workspaceAppPartition.ts";

function partition(workspaceID: string, appID: string): string {
  return `${workspaceAppBrowserPartitionPrefix}${encodeURIComponent(
    workspaceID
  )}:${encodeURIComponent(appID)}`;
}

test("Workspace App partitions decode their workspace and app identity", () => {
  assert.deepEqual(
    parseWorkspaceAppSessionPartition(partition("ws:a", "app/b")),
    {
      appID: "app/b",
      workspaceID: "ws:a"
    }
  );
});

test("Workspace App partitions are allowed only for their owner workspace", () => {
  const workspaceAPartition = partition("workspace-a", "app-1");
  assert.equal(
    isWorkspaceAppSessionPartitionAllowed(workspaceAPartition, "workspace-a"),
    true
  );
  assert.equal(
    isWorkspaceAppSessionPartitionAllowed(workspaceAPartition, "workspace-b"),
    false
  );
});

test("Workspace App partition parsing fails closed on malformed encoding", () => {
  const malformed = `${workspaceAppBrowserPartitionPrefix}workspace-a:%E0%A4%A`;
  assert.equal(parseWorkspaceAppSessionPartition(malformed), null);
  assert.equal(
    isWorkspaceAppSessionPartitionAllowed(malformed, "workspace-a"),
    false
  );
  assert.equal(
    parseWorkspaceAppSessionPartition(` ${partition("workspace-a", "app-1")}`),
    null
  );
  assert.equal(
    parseWorkspaceAppSessionPartition(
      `${workspaceAppBrowserPartitionPrefix}workspace-a:app:1`
    ),
    null
  );
});
