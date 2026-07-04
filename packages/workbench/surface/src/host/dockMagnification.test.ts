import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  advanceDockMagnificationSpring,
  applyDockMagnificationEntryRamp,
  DOCK_ICON_BASE_SIZE,
  DOCK_ICON_PEAK_SIZE,
  DOCK_MAGNIFICATION_HALF_RANGE,
  createDockMagnificationGlobalPointerTracker,
  isDockMagnificationPointInsideHitBounds,
  isDockMagnificationPointInsideSlotRect,
  isDockMagnificationSlotLayoutLocked,
  isDockMagnificationSpringSettled,
  mapDistanceToTargetSize,
  resolveDockMagnificationHitBounds,
  resolveDockMagnificationSlotLayoutSize,
  resolveDockMagnificationSlotCenter,
  resolveDockMagnificationVisibleHitBounds,
  resolveDockMagnificationVisibleSlotRects
} from "./dockMagnification.ts";

const source = readFileSync(resolve("src/host/dockMagnification.ts"), "utf8");

function assertBoundsEqual(
  actual: ReturnType<typeof resolveDockMagnificationHitBounds>,
  expected: NonNullable<ReturnType<typeof resolveDockMagnificationHitBounds>>
) {
  if (actual === null) {
    assert.fail("expected dock magnification hit bounds");
  }
  assert.ok(Math.abs(actual.crossEnd - expected.crossEnd) < 0.001);
  assert.ok(Math.abs(actual.crossStart - expected.crossStart) < 0.001);
  assert.ok(Math.abs(actual.mainEnd - expected.mainEnd) < 0.001);
  assert.ok(Math.abs(actual.mainStart - expected.mainStart) < 0.001);
}

class FakePointerTrackingTarget {
  readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  readonly added: string[] = [];
  readonly removed: string[] = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null
  ) {
    if (!listener) {
      return;
    }
    this.added.push(type);
    let listenersForType = this.listeners.get(type);
    if (!listenersForType) {
      listenersForType = new Set();
      this.listeners.set(type, listenersForType);
    }
    listenersForType.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null
  ) {
    if (!listener) {
      return;
    }
    this.removed.push(type);
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

test("mapDistanceToTargetSize peaks at center and falls off linearly", () => {
  const centerSize = mapDistanceToTargetSize(0);
  const edgeSize = mapDistanceToTargetSize(DOCK_MAGNIFICATION_HALF_RANGE);
  const beyondSize = mapDistanceToTargetSize(
    DOCK_MAGNIFICATION_HALF_RANGE + 12
  );

  assert.equal(centerSize, DOCK_ICON_PEAK_SIZE);
  assert.equal(edgeSize, DOCK_ICON_BASE_SIZE);
  assert.equal(beyondSize, DOCK_ICON_BASE_SIZE);
});

test("mapDistanceToTargetSize is symmetric around the icon center", () => {
  assert.equal(mapDistanceToTargetSize(-24), mapDistanceToTargetSize(24));
});

test("dock magnification entry ramp eases into the first hover target", () => {
  const target = mapDistanceToTargetSize(0);

  assert.equal(
    applyDockMagnificationEntryRamp(target, DOCK_ICON_BASE_SIZE, 0),
    DOCK_ICON_BASE_SIZE
  );
  assert.equal(
    applyDockMagnificationEntryRamp(target, DOCK_ICON_BASE_SIZE, 1),
    target
  );
  assert.equal(
    applyDockMagnificationEntryRamp(target, DOCK_ICON_BASE_SIZE, 0.5),
    DOCK_ICON_BASE_SIZE + (target - DOCK_ICON_BASE_SIZE) * 0.5
  );
});

test("dock magnification hit bounds exclude scroll-control padding before the first slot", () => {
  const hitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 80, left: 100, right: 143.2, top: 36.8 },
      { bottom: 80, left: 160, right: 203.2, top: 36.8 }
    ],
    "bottom"
  );

  assertBoundsEqual(hitBounds, {
    crossEnd: 88,
    crossStart: 28.8,
    mainEnd: 203.2,
    mainStart: 100
  });
});

test("dock magnification hit bounds include the transparent gap between slots", () => {
  const hitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 80, left: 100, right: 143.2, top: 36.8 },
      { bottom: 80, left: 160, right: 203.2, top: 36.8 }
    ],
    "bottom"
  );

  assert.equal(
    isDockMagnificationPointInsideHitBounds({
      clientX: 151.6,
      clientY: 60,
      dockPlacement: "bottom",
      hitBounds
    }),
    true
  );
  assert.equal(
    isDockMagnificationPointInsideHitBounds({
      clientX: 99,
      clientY: 60,
      dockPlacement: "bottom",
      hitBounds
    }),
    false
  );
});

test("dock magnification visible hit bounds clip overflow slots to the viewport", () => {
  const slotHitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 80, left: 100, right: 143.2, top: 36.8 },
      { bottom: 80, left: 160, right: 203.2, top: 36.8 },
      { bottom: 80, left: 720, right: 763.2, top: 36.8 }
    ],
    "bottom"
  );
  const visibleHitBounds = resolveDockMagnificationVisibleHitBounds({
    dockPlacement: "bottom",
    hitBounds: slotHitBounds,
    viewportRect: { bottom: 88, left: 64, right: 560, top: 0 }
  });

  assertBoundsEqual(visibleHitBounds, {
    crossEnd: 88,
    crossStart: 28.8,
    mainEnd: 560,
    mainStart: 100
  });
  assert.equal(
    isDockMagnificationPointInsideHitBounds({
      clientX: 151.6,
      clientY: 60,
      dockPlacement: "bottom",
      hitBounds: visibleHitBounds
    }),
    true
  );
  assert.equal(
    isDockMagnificationPointInsideHitBounds({
      clientX: 730,
      clientY: 60,
      dockPlacement: "bottom",
      hitBounds: visibleHitBounds
    }),
    false
  );
});

test("dock magnification visible hit bounds preserve edge hover room near the viewport", () => {
  const slotHitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 80, left: 100, right: 143.2, top: 36.8 },
      { bottom: 80, left: 160, right: 203.2, top: 36.8 }
    ],
    "bottom"
  );
  const visibleHitBounds = resolveDockMagnificationVisibleHitBounds({
    dockPlacement: "bottom",
    hitBounds: slotHitBounds,
    mainAxisEdgePadding: DOCK_ICON_BASE_SIZE / 2,
    viewportRect: { bottom: 88, left: 90, right: 210, top: 0 }
  });

  assertBoundsEqual(visibleHitBounds, {
    crossEnd: 88,
    crossStart: 28.8,
    mainEnd: 224.8,
    mainStart: 78.4
  });
  assert.equal(
    isDockMagnificationPointInsideHitBounds({
      clientX: 80,
      clientY: 60,
      dockPlacement: "bottom",
      hitBounds: visibleHitBounds
    }),
    true
  );
});

test("left dock magnification hit bounds use the vertical slot range", () => {
  const hitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 143.2, left: 20, right: 63.2, top: 100 },
      { bottom: 203.2, left: 20, right: 63.2, top: 160 }
    ],
    "left"
  );

  assertBoundsEqual(hitBounds, {
    crossEnd: 101.44,
    crossStart: 12,
    mainEnd: 203.2,
    mainStart: 100
  });
});

test("left dock magnification hit bounds include the expanded icon width", () => {
  const hitBounds = resolveDockMagnificationHitBounds(
    [{ bottom: 143.2, left: 20, right: 63.2, top: 100 }],
    "left"
  );

  assertBoundsEqual(hitBounds, {
    crossEnd: 101.44,
    crossStart: 12,
    mainEnd: 143.2,
    mainStart: 100
  });
});

test("dock magnification expands both slot axes so neighbors keep spacing", () => {
  assert.deepEqual(
    resolveDockMagnificationSlotLayoutSize({
      size: DOCK_ICON_PEAK_SIZE
    }),
    {
      height: DOCK_ICON_PEAK_SIZE,
      width: DOCK_ICON_PEAK_SIZE
    }
  );
});

test("dock magnification keeps slot edge points eligible", () => {
  const rect = { bottom: 80, left: 100, right: 143.2, top: 36.8 };

  assert.equal(
    isDockMagnificationPointInsideSlotRect({
      clientX: 100,
      clientY: 60,
      rect
    }),
    true
  );
  assert.equal(
    isDockMagnificationPointInsideSlotRect({
      clientX: 143.2,
      clientY: 60,
      rect
    }),
    true
  );
  assert.equal(
    isDockMagnificationPointInsideSlotRect({
      clientX: 99.9,
      clientY: 60,
      rect
    }),
    false
  );
});

test("dock magnification clips slot edge eligibility to the viewport", () => {
  const visibleRects = resolveDockMagnificationVisibleSlotRects({
    slotRects: [
      { bottom: 80, left: 100, right: 143.2, top: 36.8 },
      { bottom: 80, left: 720, right: 763.2, top: 36.8 }
    ],
    viewportRect: { bottom: 88, left: 64, right: 120, top: 0 }
  });

  assert.deepEqual(visibleRects, [
    { bottom: 80, left: 100, right: 120, top: 36.8 }
  ]);
  assert.equal(
    isDockMagnificationPointInsideSlotRect({
      clientX: 120,
      clientY: 60,
      rect: visibleRects[0]!
    }),
    true
  );
  assert.equal(
    isDockMagnificationPointInsideSlotRect({
      clientX: 130,
      clientY: 60,
      rect: visibleRects[0]!
    }),
    false
  );
});

test("dock magnification center ignores the slot's current magnified size", () => {
  const restCenter = resolveDockMagnificationSlotCenter(
    { bottom: 80, left: 100, right: 143.2, top: 36.8 },
    "bottom"
  );
  const magnifiedCenter = resolveDockMagnificationSlotCenter(
    { bottom: 100, left: 100, right: 180, top: 20 },
    "bottom"
  );

  assert.equal(restCenter, magnifiedCenter);
});

test("left dock magnification center ignores the slot's current magnified size", () => {
  const restCenter = resolveDockMagnificationSlotCenter(
    { bottom: 143.2, left: 20, right: 63.2, top: 100 },
    "left"
  );
  const magnifiedCenter = resolveDockMagnificationSlotCenter(
    { bottom: 180, left: 0, right: 80, top: 100 },
    "left"
  );

  assert.equal(restCenter, magnifiedCenter);
});

test("dock magnification spring settles on the target size", () => {
  let spring = { value: DOCK_ICON_BASE_SIZE, velocity: 0 };
  const target = mapDistanceToTargetSize(0);

  for (let index = 0; index < 240; index += 1) {
    spring = advanceDockMagnificationSpring(spring, target, 1 / 60);
  }

  assert.ok(isDockMagnificationSpringSettled(spring, target));
  assert.ok(Math.abs(spring.value - target) < 0.5);
});

test("dock magnification keeps active styles until leave animation settles", () => {
  const handlePointerLeaveSource =
    source.match(
      /const handlePointerLeave = useCallback\([\s\S]*?\n {2}\}, \[scheduleAnimation\]\);/
    )?.[0] ?? "";

  assert.notEqual(handlePointerLeaveSource, "");
  assert.match(
    source,
    /if \(pointerAxis === null && allSettled\) \{[\s\S]*?setMagnifyActive\(false\);/
  );
  assert.doesNotMatch(handlePointerLeaveSource, /setMagnifyActive\(false\);/);
});

test("dock magnification global pointer tracker forwards gap moves and cleans up", () => {
  const pointerTarget = new FakePointerTrackingTarget();
  const blurTarget = new FakePointerTrackingTarget();
  const moves: Array<{ clientX: number; clientY: number }> = [];
  let canceled = 0;
  const tracker = createDockMagnificationGlobalPointerTracker({
    blurTarget,
    onPointerCancel: () => {
      canceled += 1;
    },
    onPointerMove: (clientX, clientY) => {
      moves.push({ clientX, clientY });
    },
    pointerTarget
  });

  tracker.start();
  tracker.start();

  assert.equal(tracker.isActive(), true);
  assert.equal(pointerTarget.listenerCount("pointermove"), 1);
  assert.equal(pointerTarget.listenerCount("pointercancel"), 1);
  assert.equal(blurTarget.listenerCount("blur"), 1);
  assert.deepEqual(pointerTarget.added, ["pointermove", "pointercancel"]);
  assert.deepEqual(blurTarget.added, ["blur"]);

  pointerTarget.dispatch("pointermove", {
    clientX: 151,
    clientY: 60
  } as unknown as Event);
  assert.deepEqual(moves, [{ clientX: 151, clientY: 60 }]);

  pointerTarget.dispatch("pointercancel", new Event("pointercancel"));
  assert.equal(canceled, 1);
  assert.equal(tracker.isActive(), false);
  assert.equal(pointerTarget.listenerCount("pointermove"), 0);
  assert.equal(pointerTarget.listenerCount("pointercancel"), 0);
  assert.equal(blurTarget.listenerCount("blur"), 0);

  tracker.start();
  blurTarget.dispatch("blur", new Event("blur"));
  assert.equal(canceled, 2);
  assert.equal(tracker.isActive(), false);
  assert.equal(pointerTarget.listenerCount("pointermove"), 0);
  assert.equal(pointerTarget.listenerCount("pointercancel"), 0);
  assert.equal(blurTarget.listenerCount("blur"), 0);
});

test("dock magnification starts global tracking on active pointers and stops on bounds exit or reset", () => {
  assert.match(
    source,
    /createDockMagnificationGlobalPointerTracker\(\{[\s\S]*?pointerTarget: document/
  );
  assert.match(
    source,
    /startGlobalPointerTracking\(\);[\s\S]*?scheduleAnimation\(\);/
  );
  assert.match(
    source,
    /const isPointerInsideDockMagnificationTarget = useCallback\([\s\S]*?isDockMagnificationPointInsideHitBounds\([\s\S]*?\) \|\| isPointerInsideAnyVisibleDockSlot\(clientX, clientY\)/
  );
  assert.match(
    source,
    /if \(!isPointerInsideDockMagnificationTarget\(clientX, clientY\)\) \{[\s\S]*?stopGlobalPointerTracking\(\);[\s\S]*?clearTrackedPointer\(\);/
  );
  assert.match(
    source,
    /const resetMagnification = useCallback\([\s\S]*?stopGlobalPointerTracking\(\);/
  );
  assert.match(
    source,
    /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?resetMagnification\(\);/
  );
});

test("dock magnification samples ambient pointer moves without taking dock pointer events", () => {
  assert.match(
    source,
    /document\.addEventListener\(\s*"pointermove",\s*handleAmbientPointerMove/
  );
  assert.match(source, /isPointNearDockScreenEdge\(/);
  assert.match(source, /isPointNearDockViewport\(/);
  assert.match(
    source,
    /const handleAmbientPointerMove = \(event: PointerEvent\) => \{[\s\S]*?!isPointNearDockScreenEdge\([\s\S]*?return;[\s\S]*?latestPoint =/
  );
  assert.match(
    source,
    /const clearAmbientPointerSample = \(\) => \{[\s\S]*?latestPoint = null;[\s\S]*?cancelAnimationFrame\(animationFrame\);/
  );
  assert.match(
    source,
    /!isPointNearDockScreenEdge\([\s\S]*?\) \{[\s\S]*?clearAmbientPointerSample\(\);[\s\S]*?return;/
  );
  assert.match(
    source,
    /isPointerInsideDockMagnificationTarget\(point\.clientX, point\.clientY\)[\s\S]*?handlePointerMove\(point\.clientX, point\.clientY\);/
  );
});

test("dock magnification caches slot shell lookups during animation", () => {
  assert.match(source, /const dockMagnificationShellBySlot = new WeakMap/);
  assert.match(source, /dockMagnificationShellBySlot\.get\(slotElement\)/);
  assert.match(source, /slotElement\.contains\(cachedShell\)/);
  assert.match(
    source,
    /dockMagnificationShellBySlot\.set\(slotElement, shell\)/
  );
});

test("dock magnification skips layout-locked dock slots", () => {
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { collapsing: "true" }
    } as unknown as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "entering" }
    } as unknown as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "exiting" }
    } as unknown as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "present" }
    } as unknown as HTMLElement),
    false
  );
  assert.match(source, /isDockMagnificationSlotLayoutLocked\(slotElement\)/);
});

test("dock magnification refreshes slot centers while the pointer is active", () => {
  const runAnimationFrameSource =
    source.match(
      /const runAnimationFrame = useCallback\([\s\S]*?\n {4}\},\n {4}\[captureRestCenters, setMagnifyActive, slotRefs\]\n {2}\);/
    )?.[0] ?? "";

  assert.notEqual(runAnimationFrameSource, "");
  assert.match(
    runAnimationFrameSource,
    /if \(pointerAxis !== null\) \{[\s\S]*?captureRestCenters\(\);/
  );
  assert.match(
    source,
    /const ensureDockMagnificationGeometry = useCallback\([\s\S]*?restCentersRef\.current === null[\s\S]*?hitBoundsRef\.current === null[\s\S]*?visibleSlotRectsRef\.current === null[\s\S]*?captureRestCenters\(\);/
  );
});
