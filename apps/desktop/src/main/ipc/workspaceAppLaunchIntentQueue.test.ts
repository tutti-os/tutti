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
  assert.equal(initial?.route, "/a");
  assert.deepEqual(state.route(target, intent("/b")), []);
  assert.deepEqual(
    state.markReady(10).map((value) => value.route),
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
  assert.equal(replacementInitial?.route, "/a");
  assert.deepEqual(
    state.markReady(11).map((value) => value.route),
    ["/b"]
  );
  state.markNotReady(11);
  assert.deepEqual(state.route(target, intent("/c")), []);
  assert.deepEqual(
    state.markReady(11).map((value) => value.route),
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
  state.markNotReady(10);
  state.enqueue(target, intent("/a"));
  assert.deepEqual(state.route(target, intent("/b")), []);
  assert.deepEqual(
    state.markReady(10).map((value) => value.route),
    ["/a", "/b"]
  );
});
