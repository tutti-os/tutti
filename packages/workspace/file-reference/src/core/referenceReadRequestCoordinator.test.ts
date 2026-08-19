import assert from "node:assert/strict";
import { test } from "node:test";

import { createReferenceReadRequestCoordinator } from "./referenceReadRequestCoordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("coordinator shares only the same in-flight read", async () => {
  const coordinator = createReferenceReadRequestCoordinator();
  const pending = deferred<string>();
  let calls = 0;
  const load = async (): Promise<string> => {
    calls += 1;
    return pending.promise;
  };

  const first = coordinator.request("same", load);
  const second = coordinator.request("same", load);
  await Promise.resolve();
  assert.equal(calls, 1);

  pending.resolve("value");
  assert.deepEqual(await Promise.all([first, second]), ["value", "value"]);

  assert.equal(await coordinator.request("same", load), "value");
  assert.equal(calls, 2);
});

test("one consumer can abort without cancelling the remaining consumer", async () => {
  const coordinator = createReferenceReadRequestCoordinator();
  const pending = deferred<string>();
  const firstConsumer = new AbortController();
  const secondConsumer = new AbortController();
  const shared: { signal: AbortSignal | null } = { signal: null };
  const load = async (signal: AbortSignal): Promise<string> => {
    shared.signal = signal;
    return pending.promise;
  };

  const first = coordinator.request("same", load, firstConsumer.signal);
  const second = coordinator.request("same", load, secondConsumer.signal);
  firstConsumer.abort();

  await assert.rejects(first, { name: "AbortError" });
  assert.equal(shared.signal?.aborted, false);
  pending.resolve("kept-alive");
  assert.equal(await second, "kept-alive");
});

test("coordinator aborts the shared read after its last consumer leaves", async () => {
  const coordinator = createReferenceReadRequestCoordinator();
  const firstConsumer = new AbortController();
  const secondConsumer = new AbortController();
  const shared: { signal: AbortSignal | null } = { signal: null };
  const load = (signal: AbortSignal): Promise<never> => {
    shared.signal = signal;
    return new Promise<never>(() => {});
  };

  const first = coordinator.request("same", load, firstConsumer.signal);
  const second = coordinator.request("same", load, secondConsumer.signal);
  await Promise.resolve();
  firstConsumer.abort();
  secondConsumer.abort();

  await assert.rejects(first, { name: "AbortError" });
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(shared.signal?.aborted, true);
});

test("failed reads are not cached", async () => {
  const coordinator = createReferenceReadRequestCoordinator();
  let calls = 0;
  const load = async (): Promise<string> => {
    calls += 1;
    if (calls === 1) throw new Error("temporary");
    return "recovered";
  };

  await assert.rejects(coordinator.request("same", load), /temporary/);
  assert.equal(await coordinator.request("same", load), "recovered");
  assert.equal(calls, 2);
});

test("invalidation rejects consumers even when the loader ignores abort", async () => {
  const coordinator = createReferenceReadRequestCoordinator();
  const reading = coordinator.request(
    "workspace-1",
    () => new Promise<never>(() => {})
  );
  await Promise.resolve();

  coordinator.invalidate((key) => key === "workspace-1");

  await assert.rejects(reading, { name: "AbortError" });
});
