import assert from "node:assert/strict";
import test from "node:test";
import {
  getService,
  InstantiationService,
  ServiceRegistry,
  SyncDescriptor
} from "@tutti-os/infra/di";
import { IWorkbenchHostCoordinator } from "../workbenchHostCoordinator.interface.ts";
import { WorkbenchHostCoordinator } from "./workbenchHostCoordinator.ts";
import {
  WorkbenchHostSession,
  type WorkbenchSnapshotPartition
} from "./workbenchHostSession.ts";

test("workbench host coordinator leases one session for the same partition", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const partition = workspacePartition("workspace-1");
  let createCount = 0;
  const first = coordinator.open({
    createSession: (sessionPartition) => {
      createCount += 1;
      return createSession(sessionPartition);
    },
    partition
  });
  const second = coordinator.open({
    createSession: () => assert.fail("same partition must reuse the session"),
    partition
  });

  assert.equal(first.session, second.session);
  assert.equal(createCount, 1);
  first.release();
  first.release();
  assert.equal(first.session.isDisposed, false);
  assert.equal(coordinator.get(partition), first.session);
  second.release();
  assert.equal(first.session.isDisposed, true);
  assert.equal(coordinator.get(partition), null);
});

test("workbench host coordinator replaces a scope when its principal snapshot changes", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const firstPartition = roomPartition("room-1", "user-1");
  const secondPartition = roomPartition("room-1", "user-2");
  const first = coordinator.open({
    createSession,
    partition: firstPartition
  });
  const events: string[] = [];
  first.session.registerDisposable(() => {
    events.push("first-disposed");
  });

  const second = coordinator.open({
    createSession,
    partition: secondPartition
  });

  assert.deepEqual(events, ["first-disposed"]);
  assert.equal(first.session.isDisposed, true);
  assert.notEqual(first.session, second.session);
  assert.equal(coordinator.get(firstPartition), null);
  assert.equal(coordinator.get(secondPartition), second.session);
  first.release();
  assert.equal(second.session.isDisposed, false);
  second.release();
  assert.equal(second.session.isDisposed, true);
});

test("workbench host coordinator keeps different scopes independent", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const first = coordinator.open({
    createSession,
    partition: workspacePartition("workspace-1")
  });
  const second = coordinator.open({
    createSession,
    partition: workspacePartition("workspace-2")
  });

  assert.notEqual(first.session, second.session);
  first.release();
  assert.equal(first.session.isDisposed, true);
  assert.equal(second.session.isDisposed, false);
  coordinator.dispose();
  coordinator.dispose();
  assert.equal(second.session.isDisposed, true);
  assert.equal(coordinator.get(workspacePartition("workspace-2")), null);
  assert.throws(
    () =>
      coordinator.open({
        createSession,
        partition: workspacePartition("workspace-3")
      }),
    /coordinator is disposed/
  );
});

test("workbench host coordinator rejects a session for another partition", () => {
  const coordinator = new WorkbenchHostCoordinator();
  const mismatchedSession = createSession(workspacePartition("workspace-2"));

  assert.throws(
    () =>
      coordinator.open({
        createSession: () => mismatchedSession,
        partition: workspacePartition("workspace-1")
      }),
    /partition does not match/
  );
  assert.equal(mismatchedSession.isDisposed, true);
  assert.equal(coordinator.get(workspacePartition("workspace-1")), null);
});

test("renderer DI owns one coordinator and disposes all of its sessions", () => {
  const registry = new ServiceRegistry();
  registry.register(
    IWorkbenchHostCoordinator,
    new SyncDescriptor(WorkbenchHostCoordinator)
  );
  const container = new InstantiationService(registry.makeCollection());
  const coordinator = getService(container, IWorkbenchHostCoordinator);
  const sameCoordinator = getService(container, IWorkbenchHostCoordinator);
  const lease = coordinator.open({
    createSession,
    partition: workspacePartition("workspace-1")
  });

  assert.equal(coordinator, sameCoordinator);
  container.dispose();
  assert.equal(lease.session.isDisposed, true);
  lease.release();
});

function createSession(partition: WorkbenchSnapshotPartition) {
  return new WorkbenchHostSession<string, string, undefined>({
    partition,
    resolve(update) {
      return { hostInput: update, state: undefined };
    }
  });
}

function roomPartition(
  roomId: string,
  principalId: string
): WorkbenchSnapshotPartition {
  return {
    principal: { id: principalId },
    scope: { id: roomId, kind: "room" }
  };
}

function workspacePartition(workspaceId: string): WorkbenchSnapshotPartition {
  return {
    scope: { id: workspaceId, kind: "workspace" }
  };
}
