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
  isDockMagnificationSlotLayoutLocked,
  isDockMagnificationSpringSettled,
  mapDistanceToTargetSize,
  resolveDockMagnificationHitBounds,
  resolveDockMagnificationSlotCenter
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

test("left dock magnification hit bounds use the vertical slot range", () => {
  const hitBounds = resolveDockMagnificationHitBounds(
    [
      { bottom: 143.2, left: 20, right: 63.2, top: 100 },
      { bottom: 203.2, left: 20, right: 63.2, top: 160 }
    ],
    "left"
  );

  assertBoundsEqual(hitBounds, {
    crossEnd: 71.2,
    crossStart: 12,
    mainEnd: 203.2,
    mainStart: 100
  });
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
    } as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "entering" }
    } as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "exiting" }
    } as HTMLElement),
    true
  );
  assert.equal(
    isDockMagnificationSlotLayoutLocked({
      dataset: { presence: "present" }
    } as HTMLElement),
    false
  );
  assert.match(source, /isDockMagnificationSlotLayoutLocked\(slotElement\)/);
});

test("dock magnification captures slot centers on pointer entry only", () => {
  const runAnimationFrameSource =
    source.match(
      /const runAnimationFrame = useCallback\([\s\S]*?\n {4}\},\n {4}\[captureRestCenters, setMagnifyActive, slotRefs\]\n {2}\);/
    )?.[0] ?? "";

  assert.notEqual(runAnimationFrameSource, "");
  assert.doesNotMatch(
    runAnimationFrameSource,
    /if \(pointerAxis !== null\) \{[\s\S]*?captureRestCenters\(\);/
  );
  assert.match(
    source,
    /if \(restCentersRef\.current === null\) \{[\s\S]*?captureRestCenters\(\);/
  );
});
