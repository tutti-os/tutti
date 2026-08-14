import assert from "node:assert/strict";
import test from "node:test";

import {
  REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX,
  REFERENCE_SEARCH_ROW_HEIGHT_PX,
  referenceSearchVirtualRowTop,
  resolveReferenceSearchVirtualWindow
} from "./referenceSearchVirtualWindow.ts";

test("one hundred thousand results keep a bounded render window", () => {
  const window = resolveReferenceSearchVirtualWindow({
    itemCount: 100_000,
    scrollTop: 2_900_000,
    viewportHeight: 580
  });

  assert.ok(window.endIndex - window.startIndex <= 32);
  assert.ok(window.startIndex > 49_000);
  assert.ok(window.endIndex < 51_000);
  assert.equal(window.spacerHeight, 100_000 * REFERENCE_SEARCH_ROW_HEIGHT_PX);
});

test("one million results compress scroll geometry while keeping the final row reachable", () => {
  const viewportHeight = 580;
  const scrollTop = REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX - viewportHeight;
  const window = resolveReferenceSearchVirtualWindow({
    itemCount: 1_000_000,
    scrollTop,
    viewportHeight
  });

  assert.equal(window.spacerHeight, REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX);
  assert.equal(window.endIndex, 1_000_000);
  assert.ok(window.endIndex - window.startIndex <= 32);
  assert.equal(
    referenceSearchVirtualRowTop(window, 999_999),
    REFERENCE_SEARCH_MAX_SCROLL_HEIGHT_PX - REFERENCE_SEARCH_ROW_HEIGHT_PX
  );
});
