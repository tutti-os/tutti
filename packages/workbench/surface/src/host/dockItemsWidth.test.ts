import assert from "node:assert/strict";
import test from "node:test";
import {
  dockItemsGapPx,
  dockItemsHorizontalPaddingPx,
  dockSeparatorOuterWidthPx,
  dockSlotWidthPx,
  resolveWorkbenchHostDockItemsWidth
} from "./dockItemsWidth.ts";

// The width model must match workbench.css exactly: --desktop-dock-gap,
// --desktop-dock-items-padding, the separator outer width (1px + 4px margins
// per side), and --desktop-dock-size. If these drift apart the dock frame
// sizes itself narrower than its icons and truncates them too early.
test("dock layout constants match workbench.css", () => {
  assert.equal(dockItemsGapPx, 16);
  assert.equal(dockItemsHorizontalPaddingPx, 12.6);
  assert.equal(dockSeparatorOuterWidthPx, 9);
  assert.equal(dockSlotWidthPx, 43.2);
});

test("empty dock collapses to its horizontal padding", () => {
  assert.equal(resolveWorkbenchHostDockItemsWidth([]), 12.6);
});

test("a single slot spans slot width plus padding without gaps", () => {
  assert.equal(
    resolveWorkbenchHostDockItemsWidth([{ kind: "entry" }]),
    43.2 + 12.6
  );
});

test("slots, separators, gaps, and padding all contribute to the width", () => {
  const width = resolveWorkbenchHostDockItemsWidth([
    { kind: "entry" },
    { kind: "entry" },
    { kind: "separator" },
    { kind: "entry" }
  ]);
  // 3 slots + 1 separator + 3 gaps + padding.
  assert.equal(width, 3 * 43.2 + 9 + 3 * 16 + 12.6);
});
