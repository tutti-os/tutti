import assert from "node:assert/strict";
import test from "node:test";
import { createHostEventStore } from "./event-store.ts";

test("replays the latest value before newer live events", async () => {
  let emit: ((value: string) => void) | undefined;
  const store = createHostEventStore<string>({
    open(listener) {
      emit = listener;
      return { initial: Promise.resolve(undefined), unsubscribe() {} };
    },
    replayLatest: true
  });
  store.subscribe(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  emit?.("A");

  const received: string[] = [];
  store.subscribe((value) => received.push(value));
  emit?.("B");
  assert.deepEqual(received, ["A", "B"]);
});

test("does not duplicate a replay for listeners added during fanout", async () => {
  let emit: ((value: string) => void) | undefined;
  const store = createHostEventStore<string>({
    open(listener) {
      emit = listener;
      return { initial: Promise.resolve(undefined), unsubscribe() {} };
    },
    replayLatest: true
  });
  const received: string[] = [];
  store.subscribe((value) => {
    if (value === "A") {
      store.subscribe((nested) => received.push(nested));
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  emit?.("A");
  assert.deepEqual(received, ["A"]);
});

test("rolls back a failed open and allows a later subscription to reopen", () => {
  let opens = 0;
  let failedEmit: ((value: string) => void) | undefined;
  const store = createHostEventStore<string>({
    open(listener) {
      opens += 1;
      if (opens === 1) {
        failedEmit = listener;
        listener("stale");
        throw Object.assign(new Error("offline"), {
          code: "common.unavailable"
        });
      }
      return { initial: Promise.resolve(undefined), unsubscribe() {} };
    },
    replayLatest: true
  });
  assert.throws(() => store.subscribe(() => undefined), /offline/);
  failedEmit?.("also-stale");

  assert.doesNotThrow(() => store.subscribe(() => undefined));
  assert.equal(opens, 2);
});

test("rolls back malformed stream setup and allows reopen", () => {
  let opens = 0;
  let malformedCloses = 0;
  const store = createHostEventStore<string>({
    open() {
      opens += 1;
      if (opens === 1) {
        return {
          initial: undefined,
          unsubscribe() {
            malformedCloses += 1;
          }
        } as never;
      }
      return { initial: Promise.resolve(undefined), unsubscribe() {} };
    },
    replayLatest: false
  });
  assert.throws(
    () => store.subscribe(() => undefined),
    /host event stream is invalid/
  );
  assert.doesNotThrow(() => store.subscribe(() => undefined));
  assert.equal(opens, 2);
  assert.equal(malformedCloses, 1);
});

test("closes local state even when host unsubscribe throws", () => {
  let opens = 0;
  const store = createHostEventStore<string>({
    open() {
      opens += 1;
      return {
        initial: Promise.resolve(undefined),
        unsubscribe() {
          assert.equal(this.initial instanceof Promise, true);
          throw new Error("close failed");
        }
      };
    },
    replayLatest: false
  });
  const unsubscribe = store.subscribe(() => undefined);
  assert.doesNotThrow(unsubscribe);
  assert.doesNotThrow(() => store.subscribe(() => undefined));
  assert.equal(opens, 2);
});

test("retains a one-shot initial value across close and reopen", async () => {
  let opens = 0;
  let resolveInitial: ((value: string | undefined) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((resolve) => {
    resolveInitial = resolve;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    open() {
      opens += 1;
      return {
        initial:
          opens === 1 ? firstInitial : Promise.resolve("duplicate-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  const unsubscribeFirst = store.subscribe(() => undefined);
  unsubscribeFirst();

  const received: string[] = [];
  const unsubscribeSecond = store.subscribe((value) => received.push(value));
  resolveInitial?.("initial-launch");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(opens, 2);
  assert.deepEqual(received, ["initial-launch"]);
  unsubscribeSecond();
});

test("falls back to the reopened initial when the retained request fails", async () => {
  let opens = 0;
  let rejectInitial: ((reason: unknown) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((_resolve, reject) => {
    rejectInitial = reject;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    open() {
      opens += 1;
      return {
        initial:
          opens === 1 ? firstInitial : Promise.resolve("replacement-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  store.subscribe(() => undefined)();
  const received: string[] = [];
  const unsubscribe = store.subscribe((value) => received.push(value));
  rejectInitial?.(new Error("first request failed"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["replacement-initial"]);
  unsubscribe();
});

test("falls back when the retained initial is absent", async () => {
  let opens = 0;
  let resolveInitial: ((value: string | undefined) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((resolve) => {
    resolveInitial = resolve;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    open() {
      opens += 1;
      return {
        initial:
          opens === 1 ? firstInitial : Promise.resolve("replacement-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  store.subscribe(() => undefined)();
  const received: string[] = [];
  const unsubscribe = store.subscribe((value) => received.push(value));
  resolveInitial?.(undefined);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["replacement-initial"]);
  unsubscribe();
});

test("falls back when retained initial normalization fails", async () => {
  let opens = 0;
  let resolveInitial: ((value: string | undefined) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((resolve) => {
    resolveInitial = resolve;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    normalizeInitial(value) {
      if (value === "invalid") {
        throw new Error("invalid initial");
      }
      return String(value);
    },
    open() {
      opens += 1;
      return {
        initial:
          opens === 1 ? firstInitial : Promise.resolve("replacement-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  store.subscribe(() => undefined)();
  const received: string[] = [];
  const unsubscribe = store.subscribe((value) => received.push(value));
  resolveInitial?.("invalid");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["replacement-initial"]);
  unsubscribe();
});

test("retains pre-ready live events across close and reopen", async () => {
  let opens = 0;
  let resolveInitial: ((value: string | undefined) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((resolve) => {
    resolveInitial = resolve;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    open(listener) {
      opens += 1;
      if (opens === 1) {
        listener("live-after-initial");
      }
      return {
        initial:
          opens === 1 ? firstInitial : Promise.resolve("duplicate-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  store.subscribe(() => undefined)();
  const received: string[] = [];
  const unsubscribe = store.subscribe((value) => received.push(value));
  resolveInitial?.("initial-launch");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["initial-launch", "live-after-initial"]);
  unsubscribe();
});

test("retains the prior live buffer across a failed intermediate reopen", async () => {
  let opens = 0;
  let resolveInitial: ((value: string | undefined) => void) | undefined;
  const firstInitial = new Promise<string | undefined>((resolve) => {
    resolveInitial = resolve;
  });
  const store = createHostEventStore<string>({
    consumeInitialOnce: true,
    open(listener) {
      opens += 1;
      if (opens === 1) {
        listener("live-after-initial");
        return { initial: firstInitial, unsubscribe() {} };
      }
      if (opens === 2) {
        listener("failed-generation-event");
        throw new Error("temporary setup failure");
      }
      return {
        initial: Promise.resolve("duplicate-initial"),
        unsubscribe() {}
      };
    },
    replayLatest: false
  });
  store.subscribe(() => undefined)();
  assert.throws(
    () => store.subscribe(() => undefined),
    /temporary setup failure/
  );
  const received: string[] = [];
  const unsubscribe = store.subscribe((value) => received.push(value));
  resolveInitial?.("initial-launch");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["initial-launch", "live-after-initial"]);
  unsubscribe();
});
