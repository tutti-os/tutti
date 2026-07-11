import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceAppLaunchIntentDeliveryState,
  WorkspaceAppLaunchIntentQueue,
  shouldResetWorkspaceAppLaunchIntentReadiness
} from "./workspaceAppLaunchIntentQueue.ts";

const target = {
  appID: "canvas",
  ownerWebContentsId: 1,
  workspaceID: "workspace-1"
};

function intent(route: string) {
  return { kind: "open-route" as const, route };
}

test("bounds each launch target and preserves FIFO for retained intents", () => {
  const queue = new WorkspaceAppLaunchIntentQueue({
    maxIntentsPerTarget: 3,
    maxTargets: 10,
    maxTotalIntents: 10
  });
  for (const route of ["/1", "/2", "/3", "/4", "/5"]) {
    queue.enqueue(target, intent(route));
  }
  assert.deepEqual(
    queue.drain(target).map((value) => value.route),
    ["/3", "/4", "/5"]
  );
});

test("bounds total targets and intents", () => {
  const queue = new WorkspaceAppLaunchIntentQueue({
    maxIntentsPerTarget: 10,
    maxTargets: 2,
    maxTotalIntents: 3
  });
  queue.enqueue(target, intent("/owner-1-a"));
  queue.enqueue(target, intent("/owner-1-b"));
  queue.enqueue(
    { ...target, appID: "docs", ownerWebContentsId: 2 },
    intent("/owner-2")
  );
  queue.enqueue(
    { ...target, appID: "tasks", ownerWebContentsId: 3 },
    intent("/owner-3")
  );
  assert.equal(queue.size, 2);
  assert.deepEqual(queue.drain(target), []);
});

test("rejects invalid queue bounds before they can enter eviction loops", () => {
  for (const options of [
    { maxIntentsPerTarget: 0 },
    { maxIntentsPerTarget: -1 },
    { maxTargets: 0 },
    { maxTargets: -1 },
    { maxTotalIntents: 0 },
    { maxTotalIntents: Number.POSITIVE_INFINITY },
    { maxTotalIntents: 1.5 },
    { ttlMs: -1 },
    { ttlMs: Number.NaN }
  ]) {
    assert.throws(
      () => new WorkspaceAppLaunchIntentQueue(options),
      /(positive integer|finite non-negative number)/
    );
  }
});

test("clears owner intents and prunes expired entries", () => {
  let nowMs = 1_000;
  const queue = new WorkspaceAppLaunchIntentQueue({
    maxIntentsPerTarget: 10,
    maxTargets: 10,
    maxTotalIntents: 10,
    now: () => nowMs,
    ttlMs: 100
  });
  queue.enqueue(target, intent("/a"));
  queue.enqueue({ ...target, ownerWebContentsId: 2 }, intent("/b"));
  queue.clearOwner(1);
  assert.equal(queue.size, 1);
  nowMs += 101;
  assert.equal(queue.size, 0);
});

test("prepends an unconsumed initial intent for a replacement guest", () => {
  const queue = new WorkspaceAppLaunchIntentQueue({
    maxIntentsPerTarget: 3,
    maxTargets: 10,
    maxTotalIntents: 10
  });
  queue.enqueue(target, intent("/b"));
  queue.enqueue(target, intent("/c"));
  queue.prepend(target, intent("/a"));
  assert.deepEqual(
    queue.drain(target).map((value) => value.route),
    ["/a", "/b", "/c"]
  );
});

test("buffers launch intents until the registered guest is ready", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.enqueue(target, intent("/a"));
  const initial = state.registerGuest(10, target);
  assert.equal(initial?.intent.route, "/a");
  assert.deepEqual(state.route(target, intent("/b")), []);
  assert.deepEqual(
    state.markReady(10).map((value) => value.intent.route),
    ["/b"]
  );
  assert.deepEqual(state.route(target, intent("/c")), [10]);
});

test("buffers during reload and restores unconsumed initial intent", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.enqueue(target, intent("/a"));
  const initial = state.registerGuest(10, target);
  state.route(target, intent("/b"));
  state.removeGuest(10, initial);

  const replacementInitial = state.registerGuest(11, target);
  assert.equal(replacementInitial?.intent.route, "/a");
  assert.deepEqual(
    state.markReady(11).map((value) => value.intent.route),
    ["/b"]
  );
  state.markNotReady(11);
  assert.deepEqual(state.route(target, intent("/c")), []);
  assert.deepEqual(
    state.markReady(11).map((value) => value.intent.route),
    ["/c"]
  );
});

test("clears queued and registered state for a destroyed owner", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.route(target, intent("/a"));
  state.clearOwner(target.ownerWebContentsId);
  assert.equal(state.queuedIntentCount, 0);
  assert.deepEqual(state.markReady(10), []);
});

test("resets readiness only for a new main-frame document", () => {
  assert.equal(
    shouldResetWorkspaceAppLaunchIntentReadiness({
      isMainFrame: true,
      isSameDocument: false
    }),
    true
  );
  for (const input of [
    { isMainFrame: false, isSameDocument: false },
    { isMainFrame: true, isSameDocument: true },
    { isMainFrame: false, isSameDocument: true }
  ]) {
    assert.equal(shouldResetWorkspaceAppLaunchIntentReadiness(input), false);
  }
});

test("keeps FIFO after a ready guest send failure", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.markReady(10);
  assert.deepEqual(state.route(target, intent("/a")), [10]);
  state.markDeliveryFailed(10, intent("/a"));
  assert.deepEqual(state.route(target, intent("/b")), []);
  assert.deepEqual(
    state.markReady(10).map((value) => value.intent.route),
    ["/a", "/b"]
  );
});

test("retains every intent for a failed guest when another target guest succeeds", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.registerGuest(11, target);
  state.markReady(10);
  state.markReady(11);

  assert.deepEqual(state.route(target, intent("/a")), [10, 11]);
  state.markDeliveryFailed(10, intent("/a"));
  assert.deepEqual(state.route(target, intent("/b")), [11]);
  assert.deepEqual(
    state.markReady(10).map((value) => value.intent.route),
    ["/a", "/b"]
  );
});

test("queues per guest while another guest for the target remains ready", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.registerGuest(11, target);
  state.markReady(11);

  assert.deepEqual(state.route(target, intent("/a")), [11]);
  assert.deepEqual(
    state.markReady(10).map((value) => value.intent.route),
    ["/a"]
  );
});

test("hands a failed guest backlog to its replacement", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.markReady(10);
  state.markDeliveryFailed(10, intent("/a"));
  state.removeGuest(10);

  assert.equal(state.registerGuest(11, target)?.intent.route, "/a");
});

test("does not let a surviving sibling consume a removed guest backlog", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.registerGuest(11, target);
  state.markReady(10);
  state.markReady(11);

  assert.deepEqual(state.route(target, intent("/a")), [10, 11]);
  state.markDeliveryFailed(10, intent("/a"));
  assert.deepEqual(state.route(target, intent("/b")), [11]);
  state.removeGuest(10);

  state.markNotReady(11);
  assert.deepEqual(state.markReady(11), []);
  assert.equal(state.registerGuest(12, target)?.intent.route, "/a");
  assert.deepEqual(
    state.markReady(12).map((value) => value.intent.route),
    ["/b"]
  );
});

test("keeps separate replacement backlogs for multiple failed guests", () => {
  const state = new WorkspaceAppLaunchIntentDeliveryState();
  state.registerGuest(10, target);
  state.registerGuest(11, target);
  state.markReady(10);
  state.markReady(11);

  assert.deepEqual(state.route(target, intent("/a")), [10, 11]);
  state.markDeliveryFailed(10, intent("/a"));
  state.markDeliveryFailed(11, intent("/a"));
  state.removeGuest(10);
  state.removeGuest(11);

  assert.equal(state.registerGuest(12, target)?.intent.route, "/a");
  assert.equal(state.registerGuest(13, target)?.intent.route, "/a");
  assert.deepEqual(state.markReady(12), []);
  assert.deepEqual(state.markReady(13), []);
});

test("preserves failed guest backlog age and FIFO during replacement", () => {
  let nowMs = 1_000;
  const state = new WorkspaceAppLaunchIntentDeliveryState({
    now: () => nowMs,
    ttlMs: 100
  });
  state.enqueue(target, intent("/initial"));
  state.enqueue(target, intent("/before-ready"));
  const initial = state.registerGuest(10, target);
  state.markDeliveryFailed(10, intent("/failed"));
  state.removeGuest(10, initial);

  assert.equal(state.registerGuest(11, target)?.intent.route, "/initial");
  assert.deepEqual(
    state.markReady(11).map((value) => value.intent.route),
    ["/before-ready", "/failed"]
  );

  state.markDeliveryFailed(11, intent("/expires"));
  nowMs += 101;
  state.removeGuest(11);
  assert.equal(state.registerGuest(12, target), undefined);
});

test("does not renew queued intent TTL after a drained send failure", () => {
  let nowMs = 1_000;
  const state = new WorkspaceAppLaunchIntentDeliveryState({
    now: () => nowMs,
    ttlMs: 100
  });
  state.registerGuest(10, target);
  state.route(target, intent("/queued"));

  nowMs = 1_090;
  const pending = state.markReady(10);
  state.restoreFailedDeliveries(10, pending);
  nowMs = 1_101;

  assert.equal(state.queuedIntentCount, 0);
  assert.deepEqual(state.markReady(10), []);
});

test("does not renew an unconsumed initial intent TTL during reload", () => {
  let nowMs = 1_000;
  const state = new WorkspaceAppLaunchIntentDeliveryState({
    now: () => nowMs,
    ttlMs: 100
  });
  state.enqueue(target, intent("/initial"));
  const initial = state.registerGuest(10, target);

  nowMs = 1_090;
  state.removeGuest(10, initial);
  nowMs = 1_101;

  assert.equal(state.registerGuest(11, target), undefined);
});
