import assert from "node:assert/strict";
import test from "node:test";
import {
  type WorkbenchSnapshot,
  workbenchSnapshotSchemaVersion
} from "@tutti-os/workbench-snapshot";
import { readWorkspaceDockRetentionByEntryId } from "../workspaceDockRetention.ts";
import type { DesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository.ts";
import { createWorkspaceDockRetentionController } from "./workspaceDockRetentionController.ts";

test("workspace dock retention controller updates optimistically and persists", async () => {
  const fake = createRepository();
  const controller = createWorkspaceDockRetentionController(fake.repository);

  const writing = controller.setRetained(
    "workspace-1",
    "workspace-app:calendar",
    false
  );
  assert.equal(
    controller.readRetainedByEntryId("workspace-1")["workspace-app:calendar"],
    false
  );

  await writing;

  assert.equal(
    readWorkspaceDockRetentionByEntryId(fake.snapshot)[
      "workspace-app:calendar"
    ],
    false
  );
  controller.dispose();
});

test("workspace dock retention controller rolls back a failed write", async () => {
  const fake = createRepository();
  fake.failWrites = true;
  const controller = createWorkspaceDockRetentionController(fake.repository);

  await assert.rejects(
    controller.setRetained("workspace-1", "workspace-app:calendar", false),
    /save failed/
  );

  assert.equal(
    controller.readRetainedByEntryId("workspace-1")["workspace-app:calendar"],
    undefined
  );
  controller.dispose();
});

function createRepository(): {
  failWrites: boolean;
  repository: DesktopWorkspaceWorkbenchRepository;
  readonly snapshot: WorkbenchSnapshot;
} {
  let snapshot = createSnapshot();
  const listeners = new Set<() => void>();
  const fake = {
    failWrites: false,
    repository: {
      async load() {
        return snapshot;
      },
      readCached() {
        return snapshot;
      },
      async saveProductMetadata(
        _workspaceId: string,
        nextSnapshot: WorkbenchSnapshot
      ) {
        if (fake.failWrites) {
          throw new Error("save failed");
        }
        snapshot = nextSnapshot;
        for (const listener of listeners) {
          listener();
        }
        return snapshot;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    } as unknown as DesktopWorkspaceWorkbenchRepository,
    get snapshot() {
      return snapshot;
    }
  };
  return fake;
}

function createSnapshot(): WorkbenchSnapshot {
  return {
    activeNodeId: null,
    nodeStack: [],
    nodes: [],
    schemaVersion: workbenchSnapshotSchemaVersion
  };
}
