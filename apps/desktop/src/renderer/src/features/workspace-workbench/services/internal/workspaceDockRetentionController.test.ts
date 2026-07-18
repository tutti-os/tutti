import assert from "node:assert/strict";
import test from "node:test";
import {
  type WorkbenchSnapshot,
  workbenchSnapshotSchemaVersion
} from "@tutti-os/workbench-snapshot";
import {
  readWorkspaceDockRetentionByEntryId,
  writeWorkspaceDockRetentionToSnapshot
} from "../workspaceDockRetention.ts";
import type { DesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository.ts";
import { createWorkspaceDockRetentionController } from "./workspaceDockRetentionController.ts";

test("workspace dock retention controller updates optimistically and persists", async () => {
  const fake = createRepository();
  const controller = createWorkspaceDockRetentionController(fake.repository);
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

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
  assert.equal(notifications, 1);
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

test("workspace dock retention controller ignores unrelated repository notifications and keeps snapshots stable", () => {
  const fake = createRepository();
  const controller = createWorkspaceDockRetentionController(fake.repository);
  const first = controller.readRetainedByEntryId("workspace-1");
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

  fake.setSnapshot(
    "workspace-2",
    writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
      "workspace-app:mail": false
    })
  );
  fake.notify();

  assert.equal(notifications, 0);
  assert.equal(controller.readRetainedByEntryId("workspace-1"), first);
  assert.equal(controller.readRetainedByEntryId("workspace-1"), first);
  controller.dispose();
});

test("workspace dock retention controller notifies only when cached retention changes", () => {
  const fake = createRepository();
  const controller = createWorkspaceDockRetentionController(fake.repository);
  const first = controller.readRetainedByEntryId("workspace-1");
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

  fake.setSnapshot(
    "workspace-1",
    writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
      "workspace-app:calendar": false
    })
  );
  fake.notify();

  const second = controller.readRetainedByEntryId("workspace-1");
  assert.equal(notifications, 1);
  assert.notEqual(second, first);
  assert.deepEqual(second, { "workspace-app:calendar": false });

  fake.notify();

  assert.equal(notifications, 1);
  assert.equal(controller.readRetainedByEntryId("workspace-1"), second);
  controller.dispose();
});

test("workspace dock retention controller unsubscribes on disposal", () => {
  const fake = createRepository();
  const controller = createWorkspaceDockRetentionController(fake.repository);
  controller.readRetainedByEntryId("workspace-1");
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

  controller.dispose();
  fake.setSnapshot(
    "workspace-1",
    writeWorkspaceDockRetentionToSnapshot(createSnapshot(), {
      "workspace-app:calendar": false
    })
  );
  fake.notify();

  assert.equal(notifications, 0);
});

function createRepository(): {
  failWrites: boolean;
  notify(): void;
  repository: DesktopWorkspaceWorkbenchRepository;
  setSnapshot(workspaceId: string, snapshot: WorkbenchSnapshot): void;
  readonly snapshot: WorkbenchSnapshot;
} {
  const snapshots = new Map<string, WorkbenchSnapshot>([
    ["workspace-1", createSnapshot()]
  ]);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const fake = {
    failWrites: false,
    notify,
    repository: {
      async load(workspaceId: string) {
        return snapshots.get(workspaceId) ?? createSnapshot();
      },
      readCached(workspaceId: string) {
        return snapshots.get(workspaceId) ?? null;
      },
      async saveProductMetadata(
        workspaceId: string,
        nextSnapshot: WorkbenchSnapshot
      ) {
        if (fake.failWrites) {
          throw new Error("save failed");
        }
        snapshots.set(workspaceId, nextSnapshot);
        notify();
        return nextSnapshot;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    } as unknown as DesktopWorkspaceWorkbenchRepository,
    setSnapshot(workspaceId: string, snapshot: WorkbenchSnapshot) {
      snapshots.set(workspaceId, snapshot);
    },
    get snapshot() {
      return snapshots.get("workspace-1") ?? createSnapshot();
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
