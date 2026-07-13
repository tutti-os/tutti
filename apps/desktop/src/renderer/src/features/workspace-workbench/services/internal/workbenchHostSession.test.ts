import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import {
  WorkbenchHostSession,
  type WorkbenchSnapshotPartition
} from "./workbenchHostSession.ts";

test("workbench host session captures an immutable partition snapshot", () => {
  const partition = {
    principal: { id: "user-1" },
    scope: { id: "room-1", kind: "room" as const }
  };
  const session = createSession(partition);

  partition.principal.id = "user-2";
  partition.scope.id = "room-2";

  assert.deepEqual(session.partition, {
    principal: { id: "user-1" },
    scope: { id: "room-1", kind: "room" }
  });
  assert.equal(Object.isFrozen(session.partition), true);
  assert.equal(Object.isFrozen(session.partition.scope), true);
  assert.equal(Object.isFrozen(session.partition.principal), true);
});

test("workbench host session publishes only referential host input changes", () => {
  const firstHostInput = { revision: 1 };
  const secondHostInput = { revision: 2 };
  const previousStates: Array<string | null> = [];
  const session = new WorkbenchHostSession<
    { hostInput: { revision: number }; state: string },
    { revision: number },
    string
  >({
    partition: workspacePartition("workspace-1"),
    resolve(update, current) {
      previousStates.push(current?.state ?? null);
      return update;
    }
  });
  let notificationCount = 0;
  session.subscribe(() => {
    notificationCount += 1;
  });

  assert.equal(
    session.update({ hostInput: firstHostInput, state: "first" }),
    firstHostInput
  );
  assert.equal(notificationCount, 1);
  assert.equal(
    session.update({ hostInput: firstHostInput, state: "second" }),
    firstHostInput
  );
  assert.equal(notificationCount, 1);
  assert.equal(
    session.update({ hostInput: secondHostInput, state: "third" }),
    secondHostInput
  );
  assert.equal(notificationCount, 2);
  assert.equal(session.getHostInput(), secondHostInput);
  assert.deepEqual(previousStates, [null, "first", "second"]);
});

test("workbench host session keeps one stable subscriber batch per update", () => {
  const session = createSession(workspacePartition("workspace-1"));
  let notificationCount = 0;
  let unsubscribe = () => {};
  const listener = () => {
    notificationCount += 1;
    unsubscribe();
    unsubscribe = session.subscribe(listener);
  };
  unsubscribe = session.subscribe(listener);

  session.update("first");
  assert.equal(notificationCount, 1);

  session.update("second");
  assert.equal(notificationCount, 2);
});

test("workbench host session detaches its surface and disposes resources once", () => {
  const events: string[] = [];
  const session = createSession(workspacePartition("workspace-1"));
  const surfaceOwner = {};
  session.attachSurface({} as WorkbenchHostHandle, surfaceOwner);
  session.subscribe(() => {
    events.push("listener");
  });
  session.registerDisposable(() => {
    events.push("first-disposable");
  });
  session.registerDisposable(() => {
    events.push("second-disposable");
  });

  session.dispose();
  session.dispose();

  assert.deepEqual(events, ["second-disposable", "first-disposable"]);
  assert.equal(session.isDisposed, true);
  assert.equal(session.getAttachedSurface(), null);
  let disposedListenerCalled = false;
  session.subscribe(() => {
    disposedListenerCalled = true;
  })();
  assert.equal(disposedListenerCalled, false);
  assert.throws(() => session.update("late"), /session is disposed/);
  assert.throws(() => session.getHostInput(), /session is disposed/);
  assert.throws(
    () => session.attachSurface(null, surfaceOwner),
    /session is disposed/
  );
});

test("workbench host session ignores detach from a stale surface owner", () => {
  const session = createSession(workspacePartition("workspace-1"));
  const firstOwner = {};
  const secondOwner = {};
  const firstHandle = {} as WorkbenchHostHandle;
  const secondHandle = {} as WorkbenchHostHandle;

  session.attachSurface(firstHandle, firstOwner);
  session.attachSurface(secondHandle, secondOwner);
  session.attachSurface(null, firstOwner);
  assert.equal(session.getAttachedSurface(), secondHandle);
  session.attachSurface(null, secondOwner);
  assert.equal(session.getAttachedSurface(), null);
});

test("workbench host session disposable registrations can be released", () => {
  let disposeCount = 0;
  const session = createSession(workspacePartition("workspace-1"));
  const unregister = session.registerDisposable(() => {
    disposeCount += 1;
  });

  unregister();
  unregister();
  session.dispose();

  assert.equal(disposeCount, 0);
});

test("workbench host session continues cleanup after a disposer throws", () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const session = new WorkbenchHostSession<string, string, undefined>({
    diagnostics: {
      report(input) {
        errors.push(input.error);
      }
    },
    partition: workspacePartition("workspace-1"),
    resolve(update) {
      return { hostInput: update, state: undefined };
    }
  });
  session.update("ready");
  session.registerDisposable(() => {
    events.push("first");
  });
  session.registerDisposable(() => {
    events.push("throwing");
    throw new Error("cleanup failed");
  });

  session.dispose();
  session.dispose();

  assert.deepEqual(events, ["throwing", "first"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /cleanup failed/);
  assert.equal(session.isDisposed, true);
});

test("workbench host session isolates rejected async disposal diagnostics", async () => {
  const session = new WorkbenchHostSession<string, string, undefined>({
    diagnostics: {
      async report() {
        throw new Error("diagnostics failed");
      }
    },
    partition: workspacePartition("workspace-1"),
    resolve(update) {
      return { hostInput: update, state: undefined };
    }
  });
  session.registerDisposable(() => {
    throw new Error("cleanup failed");
  });

  session.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(session.isDisposed, true);
});

function createSession(
  partition: WorkbenchSnapshotPartition
): WorkbenchHostSession<string, string, undefined> {
  return new WorkbenchHostSession({
    partition,
    resolve(update) {
      return { hostInput: update, state: undefined };
    }
  });
}

function workspacePartition(workspaceId: string): WorkbenchSnapshotPartition {
  return {
    scope: {
      id: workspaceId,
      kind: "workspace"
    }
  };
}
