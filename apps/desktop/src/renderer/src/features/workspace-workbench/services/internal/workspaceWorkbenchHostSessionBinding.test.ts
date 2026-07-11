import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionUpdate
} from "../workspaceWorkbenchHostService.interface.ts";
import { WorkbenchHostCoordinator } from "./workbenchHostCoordinator.ts";
import { WorkbenchHostSession } from "./workbenchHostSession.ts";
import { createWorkspaceWorkbenchHostSessionBinding } from "./workspaceWorkbenchHostSessionBinding.ts";

test("workspace session bindings release only their own lease", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const owner = {};
  const first = createBinding(coordinator, owner);
  const second = createBinding(coordinator, owner);
  const firstHandle = {} as WorkbenchHostHandle;
  const secondHandle = {} as WorkbenchHostHandle;

  first.attachSurface(firstHandle);
  second.attachSurface(secondHandle);
  first.release();
  first.release();
  first.attachSurface(firstHandle);

  assert.equal(first.isActive, false);
  assert.equal(second.isActive, true);
  const session = coordinator.get<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    undefined
  >(workspacePartition());
  assert.ok(session);
  assert.equal(session.getAttachedSurface(), secondHandle);

  second.release();
  assert.equal(session.isDisposed, true);
  assert.equal(coordinator.get(workspacePartition()), null);
});

test("workspace session bindings reject cross-workspace and released updates", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const binding = createBinding(coordinator, {});

  assert.throws(
    () => binding.createHostInput(createUpdate("workspace-2")),
    /does not match its binding/
  );
  binding.release();
  assert.throws(
    () => binding.createHostInput(createUpdate("workspace-1")),
    /binding is released/
  );
});

test("a failed initial update remains owned by its exact binding", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const owner = {};
  const lease = coordinator.open<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    undefined
  >({
    createSession: (partition) =>
      new WorkbenchHostSession({
        partition,
        resolve() {
          throw new Error("resolution failed");
        }
      }),
    owner,
    partition: workspacePartition()
  });
  const binding = createWorkspaceWorkbenchHostSessionBinding({
    bindingId: 1,
    lease,
    workspaceId: "workspace-1"
  });

  assert.throws(
    () => binding.createHostInput(createUpdate("workspace-1")),
    /resolution failed/
  );
  assert.equal(coordinator.get(workspacePartition()), lease.session);
  binding.release();
  assert.equal(lease.session.isDisposed, true);
  assert.equal(coordinator.get(workspacePartition()), null);
});

function createBinding(coordinator: WorkbenchHostCoordinator, owner: object) {
  const lease = coordinator.open<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    undefined
  >({
    createSession: (partition) =>
      new WorkbenchHostSession({
        partition,
        resolve(update) {
          return {
            hostInput: {
              snapshotRepository:
                {} as WorkspaceWorkbenchHostInput["snapshotRepository"],
              workspaceId: update.workspaceId
            },
            state: undefined
          };
        }
      }),
    owner,
    partition: workspacePartition()
  });
  return createWorkspaceWorkbenchHostSessionBinding({
    bindingId: 1,
    lease,
    workspaceId: "workspace-1"
  });
}

function createUpdate(
  workspaceId: string
): WorkspaceWorkbenchHostSessionUpdate {
  return { workspaceId } as WorkspaceWorkbenchHostSessionUpdate;
}

function workspacePartition() {
  return {
    scope: {
      id: "workspace-1",
      kind: "workspace" as const
    }
  };
}
