import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceAppGuestPartition } from "./workspaceAppGuestContextRegistry.ts";

test("workspace app guest partitions decode workspace and app identifiers", () => {
  assert.deepEqual(
    parseWorkspaceAppGuestPartition(
      "persist:tutti-app:workspace%201:app%2Fbeta"
    ),
    {
      appID: "app/beta",
      workspaceID: "workspace 1"
    }
  );
});

test("workspace app guest partitions reject missing scoped identifiers", () => {
  assert.equal(parseWorkspaceAppGuestPartition(null), null);
  assert.equal(parseWorkspaceAppGuestPartition("temporary"), null);
  assert.equal(parseWorkspaceAppGuestPartition("persist:tutti-app::app"), null);
  assert.equal(
    parseWorkspaceAppGuestPartition("persist:tutti-app:workspace:"),
    null
  );
});
