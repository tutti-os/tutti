import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceWindowLifecycle,
  type WorkspaceWindowLifecycleEvent,
  type WorkspaceWindowLifecycleRuntime
} from "./workspaceWindowLifecycle.ts";

test("workspace window lifecycle publishes opened and window state changes", () => {
  const runtime = createRuntimeHarness();
  const lifecycle = createWorkspaceWindowLifecycle(runtime);
  const events: WorkspaceWindowLifecycleEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  lifecycle.start();
  runtime.advance(10);
  runtime.emitWindow("focus");
  runtime.advance(10);
  runtime.emitWindow("blur");
  runtime.advance(10);
  runtime.setVisibility("hidden");

  assert.deepEqual(events, [
    { kind: "opened", occurredAt: 1_000 },
    { kind: "focused", occurredAt: 1_010 },
    { kind: "blurred", occurredAt: 1_020 },
    {
      kind: "visibility_changed",
      occurredAt: 1_030,
      visibility: "hidden"
    }
  ]);
  assert.deepEqual(lifecycle.getSnapshot(), {
    focused: false,
    visibility: "hidden"
  });
});

test("workspace window lifecycle owns one listener set and disposes it", () => {
  const runtime = createRuntimeHarness();
  const lifecycle = createWorkspaceWindowLifecycle(runtime);
  const events: WorkspaceWindowLifecycleEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  lifecycle.start();
  lifecycle.start();

  assert.equal(runtime.listenerCount("focus"), 1);
  assert.equal(runtime.listenerCount("blur"), 1);
  assert.equal(runtime.listenerCount("visibilitychange"), 1);

  lifecycle.dispose();
  runtime.emitWindow("focus");

  assert.equal(runtime.listenerCount("focus"), 0);
  assert.equal(runtime.listenerCount("blur"), 0);
  assert.equal(runtime.listenerCount("visibilitychange"), 0);
  assert.deepEqual(events, [{ kind: "opened", occurredAt: 1_000 }]);
});

function createRuntimeHarness() {
  let focused = false;
  let now = 1_000;
  let visibility: DocumentVisibilityState = "visible";
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (type: string, listener: () => void): (() => void) => {
    const bucket = listeners.get(type) ?? new Set();
    bucket.add(listener);
    listeners.set(type, bucket);
    return () => bucket.delete(listener);
  };
  const runtime: WorkspaceWindowLifecycleRuntime & {
    advance(duration: number): void;
    emitWindow(type: "blur" | "focus"): void;
    listenerCount(type: string): number;
    setVisibility(nextVisibility: DocumentVisibilityState): void;
  } = {
    addDocumentListener: addListener,
    addWindowListener: addListener,
    advance(duration) {
      now += duration;
    },
    emitWindow(type) {
      focused = type === "focus";
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener();
      }
    },
    hasFocus: () => focused,
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    now: () => now,
    setVisibility(nextVisibility) {
      visibility = nextVisibility;
      for (const listener of [...(listeners.get("visibilitychange") ?? [])]) {
        listener();
      }
    },
    visibilityState: () => visibility
  };
  return runtime;
}
