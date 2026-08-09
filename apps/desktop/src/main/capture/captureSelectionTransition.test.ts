import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureSelectionSupersededError,
  runCaptureSelectionTransition
} from "./captureSelectionTransition.ts";

test("presents the compact capture before composer metadata settles", async () => {
  const metadata = createDeferred<string>();
  const events: string[] = [];
  const transition = runCaptureSelectionTransition({
    captureId: "capture-1",
    isCurrent: () => true,
    metadata: metadata.promise,
    present: async (assertCurrent) => {
      events.push("present");
      assertCurrent();
    }
  });

  await Promise.resolve();
  assert.deepEqual(events, ["present"]);

  metadata.resolve("ready");
  assert.equal(await transition, "ready");
});

test("rejects metadata from a capture superseded while loading", async () => {
  const metadata = createDeferred<string>();
  let current = true;
  const transition = runCaptureSelectionTransition({
    captureId: "capture-old",
    isCurrent: () => current,
    metadata: metadata.promise,
    present: async () => undefined
  });

  await Promise.resolve();
  current = false;
  metadata.resolve("stale");

  await assert.rejects(transition, (error: unknown) => {
    assert.ok(error instanceof CaptureSelectionSupersededError);
    assert.equal(error.captureId, "capture-old");
    assert.equal(error.phase, "after_metadata");
    return true;
  });
});

test("stops a superseded capture during the native window transition", async () => {
  let current = true;
  const transition = runCaptureSelectionTransition({
    captureId: "capture-old",
    isCurrent: () => current,
    metadata: Promise.resolve("unused"),
    present: async (assertCurrent) => {
      current = false;
      assertCurrent();
    }
  });

  await assert.rejects(transition, (error: unknown) => {
    assert.ok(error instanceof CaptureSelectionSupersededError);
    assert.equal(error.phase, "during_present");
    return true;
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise(value);
    }
  };
}
