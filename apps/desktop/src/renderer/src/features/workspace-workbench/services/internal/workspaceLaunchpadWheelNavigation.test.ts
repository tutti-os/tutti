import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceLaunchpadWheelNavigationState,
  resolveWorkspaceLaunchpadWheelNavigation
} from "./workspaceLaunchpadWheelNavigation.ts";

test("launchpad wheel navigation accumulates horizontal trackpad deltas before paging", () => {
  let state = createWorkspaceLaunchpadWheelNavigationState();

  const first = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: 24,
    deltaY: 2,
    pageCount: 2,
    state,
    timestamp: 500
  });
  state = first.state;

  assert.equal(first.nextPageIndex, null);
  assert.equal(first.shouldPreventDefault, true);

  const second = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: 48,
    deltaY: 3,
    pageCount: 2,
    state,
    timestamp: 560
  });

  assert.equal(second.nextPageIndex, 1);
  assert.equal(second.shouldPreventDefault, true);
  assert.deepEqual(second.state, {
    accumulatedDeltaX: 0,
    lastNavigationAt: 560
  });
});

test("launchpad wheel navigation ignores vertical scroll intent", () => {
  const state = {
    accumulatedDeltaX: 32,
    lastNavigationAt: 100
  };

  assert.deepEqual(
    resolveWorkspaceLaunchpadWheelNavigation({
      currentPage: 0,
      deltaX: 12,
      deltaY: 40,
      pageCount: 2,
      state,
      timestamp: 500
    }),
    {
      nextPageIndex: null,
      shouldPreventDefault: false,
      state: {
        accumulatedDeltaX: 0,
        lastNavigationAt: 100
      }
    }
  );
});

test("launchpad wheel navigation moves to the previous page for negative horizontal deltas", () => {
  const result = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 1,
    deltaX: -80,
    deltaY: 0,
    pageCount: 2,
    state: createWorkspaceLaunchpadWheelNavigationState(),
    timestamp: 500
  });

  assert.equal(result.nextPageIndex, 0);
  assert.equal(result.shouldPreventDefault, true);
});

test("launchpad wheel navigation absorbs horizontal overscroll at page boundaries", () => {
  const result = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 1,
    deltaX: 90,
    deltaY: 0,
    pageCount: 2,
    state: createWorkspaceLaunchpadWheelNavigationState(),
    timestamp: 500
  });

  assert.equal(result.nextPageIndex, null);
  assert.equal(result.shouldPreventDefault, true);
});

test("launchpad wheel navigation throttles repeated page changes in one gesture", () => {
  const result = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 1,
    deltaX: -90,
    deltaY: 0,
    pageCount: 3,
    state: {
      accumulatedDeltaX: 0,
      lastNavigationAt: 500
    },
    timestamp: 700
  });

  assert.deepEqual(result, {
    nextPageIndex: null,
    shouldPreventDefault: true,
    state: {
      accumulatedDeltaX: 0,
      lastNavigationAt: 500
    }
  });
});

test("launchpad wheel navigation normalizes line-based wheel deltas", () => {
  const result = resolveWorkspaceLaunchpadWheelNavigation({
    currentPage: 0,
    deltaMode: 1,
    deltaX: 5,
    deltaY: 0,
    pageCount: 2,
    state: createWorkspaceLaunchpadWheelNavigationState(),
    timestamp: 500
  });

  assert.equal(result.nextPageIndex, 1);
  assert.equal(result.shouldPreventDefault, true);
});
