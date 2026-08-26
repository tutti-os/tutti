import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAppSessionPartition,
  hasWorkspaceAppSessionPartitionPrefix,
  isWorkspaceAppSessionPartition,
  parseWorkspaceAppSessionPartition
} from "./workspaceAppSessionPartition.ts";

test("workspace app session partitions round-trip encoded identities", () => {
  const partition = createWorkspaceAppSessionPartition({
    appID: "canvas:beta",
    workspaceID: "team/研发"
  });

  assert.equal(
    partition,
    "persist:tutti-app:team%2F%E7%A0%94%E5%8F%91:canvas%3Abeta"
  );
  assert.equal(isWorkspaceAppSessionPartition(partition), true);
  assert.equal(hasWorkspaceAppSessionPartitionPrefix(partition), true);
  assert.deepEqual(parseWorkspaceAppSessionPartition(partition), {
    appID: "canvas:beta",
    workspaceID: "team/研发"
  });
});

test("workspace app session partitions reject malformed or incomplete identities", () => {
  for (const partition of [
    undefined,
    null,
    "persist:browser:workspace:app",
    "persist:tutti-app:workspace",
    "persist:tutti-app::app",
    "persist:tutti-app:workspace:",
    "persist:tutti-app:%E0%A4%A:app"
  ]) {
    assert.equal(parseWorkspaceAppSessionPartition(partition), null);
    assert.equal(isWorkspaceAppSessionPartition(partition), false);
  }
  assert.equal(
    hasWorkspaceAppSessionPartitionPrefix("persist:tutti-app:workspace"),
    true
  );
});
