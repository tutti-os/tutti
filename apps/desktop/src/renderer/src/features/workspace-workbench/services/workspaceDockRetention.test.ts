import assert from "node:assert/strict";
import test from "node:test";
import { workbenchSnapshotSchemaVersion } from "@tutti-os/workbench-snapshot";
import {
  readWorkspaceDockRetentionByEntryId,
  replaceWorkspaceDockSnapshotMetadata,
  writeWorkspaceDockRetentionToSnapshot
} from "./workspaceDockRetention.ts";

test("workspace dock retention round-trips explicit removed entries", () => {
  const snapshot = writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
    "workspace-app:calendar": false,
    browser: true
  });

  assert.deepEqual(readWorkspaceDockRetentionByEntryId(snapshot), {
    "workspace-app:calendar": false,
    browser: true
  });
});

test("workspace dock retention ignores invalid metadata entries", () => {
  const snapshot = {
    ...createSnapshot(),
    metadata: {
      workspaceDock: {
        retainedByEntryId: {
          "": true,
          browser: "yes",
          terminal: false
        },
        schemaVersion: 1
      }
    }
  };

  assert.deepEqual(readWorkspaceDockRetentionByEntryId(snapshot), {
    terminal: false
  });
});

test("workspace dock metadata replacement preserves the authoritative owner", () => {
  const authoritativeSnapshot = writeWorkspaceDockRetentionToSnapshot(
    createSnapshot(),
    { browser: false }
  );
  const nextSnapshot = {
    ...writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
      browser: true
    }),
    metadata: {
      ...writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
        browser: true
      }).metadata,
      testRevision: "next"
    }
  };

  const replaced = replaceWorkspaceDockSnapshotMetadata(
    authoritativeSnapshot,
    nextSnapshot
  );

  assert.deepEqual(readWorkspaceDockRetentionByEntryId(replaced), {
    browser: false
  });
  assert.equal(replaced.metadata?.testRevision, "next");
});

function createSnapshot() {
  return {
    activeNodeId: null,
    nodeStack: [],
    nodes: [],
    schemaVersion: workbenchSnapshotSchemaVersion
  };
}
