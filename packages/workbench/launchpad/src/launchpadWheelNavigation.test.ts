import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkbenchLaunchpadWheelNavigationState,
  resolveWorkbenchLaunchpadWheelNavigation
} from "./launchpadWheelNavigation.ts";

test("wheel navigation ignores vertical gestures", () => {
  const result = resolveWorkbenchLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: 10,
    deltaY: 100,
    pageCount: 3,
    state: createWorkbenchLaunchpadWheelNavigationState(),
    timestamp: 1_000
  });

  assert.equal(result.nextPageIndex, null);
  assert.equal(result.shouldPreventDefault, false);
});

test("wheel navigation accumulates horizontal input until the threshold", () => {
  const first = resolveWorkbenchLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: 32,
    deltaY: 0,
    pageCount: 3,
    state: createWorkbenchLaunchpadWheelNavigationState(),
    timestamp: 1_000
  });
  const second = resolveWorkbenchLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: 32,
    deltaY: 0,
    pageCount: 3,
    state: first.state,
    timestamp: 1_010
  });

  assert.equal(first.nextPageIndex, null);
  assert.equal(second.nextPageIndex, 1);
  assert.equal(second.shouldPreventDefault, true);
});

test("wheel navigation respects cooldown and page boundaries", () => {
  const cooldown = resolveWorkbenchLaunchpadWheelNavigation({
    currentPage: 1,
    deltaX: -100,
    deltaY: 0,
    pageCount: 3,
    state: { accumulatedDeltaX: 0, lastNavigationAt: 900 },
    timestamp: 1_000
  });
  const boundary = resolveWorkbenchLaunchpadWheelNavigation({
    currentPage: 0,
    deltaX: -100,
    deltaY: 0,
    pageCount: 3,
    state: createWorkbenchLaunchpadWheelNavigationState(),
    timestamp: 1_000
  });

  assert.equal(cooldown.nextPageIndex, null);
  assert.equal(boundary.nextPageIndex, null);
  assert.equal(boundary.state.lastNavigationAt, 1_000);
});
