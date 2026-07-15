import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionUpdate
} from "../workspaceWorkbenchHostService.interface.ts";
import {
  createWorkbenchHostSessionConfiguration,
  WorkbenchHostCoordinator,
  WorkbenchHostSession,
  type WorkbenchHostSessionConfiguration
} from "@tutti-os/workbench-host";
import { createWorkspaceWorkbenchHostSessionBinding } from "./workspaceWorkbenchHostSessionBinding.ts";

test("workspace session bindings release only their own lease", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const configuration = createConfiguration();
  const first = createBinding(coordinator, configuration);
  const second = createBinding(coordinator, configuration);
  const firstHandle = {} as WorkbenchHostHandle;
  const secondHandle = {} as WorkbenchHostHandle;
  let staleNotificationCount = 0;

  first.attachSurface(firstHandle);
  first.subscribe(() => {
    staleNotificationCount += 1;
  });
  second.attachSurface(secondHandle);
  first.attachSurface(null);
  first.release();
  first.release();
  first.attachSurface(firstHandle);
  second.createHostInput(createUpdate("workspace-1"));

  assert.equal(first.isActive, false);
  assert.equal(second.isActive, true);
  const session = coordinator.get(configuration, workspacePartition());
  assert.ok(session);
  assert.equal(session.getAttachedSurface(), secondHandle);
  assert.equal(staleNotificationCount, 0);

  second.release();
  assert.equal(session.isDisposed, true);
  assert.equal(coordinator.get(configuration, workspacePartition()), null);
});

test("workspace session bindings reject cross-workspace and released updates", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const binding = createBinding(coordinator, createConfiguration());

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
  const configuration = createWorkbenchHostSessionConfiguration<
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
      })
  });
  const lease = coordinator.open({
    configuration,
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
  assert.equal(
    coordinator.get(configuration, workspacePartition()),
    lease.session
  );
  binding.release();
  assert.equal(lease.session.isDisposed, true);
  assert.equal(coordinator.get(configuration, workspacePartition()), null);
});

test("a binding releases safely after coordinator-first disposal", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const binding = createBinding(coordinator, createConfiguration());

  coordinator.dispose();
  binding.attachSurface(null);
  binding.release();

  assert.equal(binding.isActive, false);
});

function createBinding(
  coordinator: WorkbenchHostCoordinator,
  configuration: WorkbenchHostSessionConfiguration<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    undefined
  >
) {
  const lease = coordinator.open({
    configuration,
    partition: workspacePartition()
  });
  return createWorkspaceWorkbenchHostSessionBinding({
    bindingId: 1,
    lease,
    workspaceId: "workspace-1"
  });
}

function createConfiguration() {
  return createWorkbenchHostSessionConfiguration<
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
      })
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
