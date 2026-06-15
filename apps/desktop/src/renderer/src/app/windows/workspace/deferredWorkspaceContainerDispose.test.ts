import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose.ts";

test("deferred workspace container dispose can be cancelled during StrictMode effect replay", () => {
  let disposeCount = 0;
  const scheduledCallbacks: Array<() => void> = [];
  const clearedHandles = new Set<number>();
  const disposer = createDeferredWorkspaceContainerDispose(
    () => {
      disposeCount += 1;
    },
    {
      clear(handle) {
        clearedHandles.add(Number(handle));
      },
      set(callback) {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      }
    }
  );

  disposer.schedule();
  disposer.cancel();

  scheduledCallbacks.forEach((callback, index) => {
    const handle = index + 1;
    if (!clearedHandles.has(handle)) {
      callback();
    }
  });

  assert.equal(disposeCount, 0);
});

test("deferred workspace container dispose runs when it is not cancelled", () => {
  let disposeCount = 0;
  const scheduledCallbacks: Array<() => void> = [];
  const disposer = createDeferredWorkspaceContainerDispose(
    () => {
      disposeCount += 1;
    },
    {
      clear() {},
      set(callback) {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      }
    }
  );

  disposer.schedule();
  const callback = scheduledCallbacks.at(0);
  assert.ok(callback);
  callback();

  assert.equal(disposeCount, 1);
});
