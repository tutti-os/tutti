import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAnalyticsDebugFloatingDragMoved,
  resolveAnalyticsDebugFloatingPosition
} from "./floatingPosition.ts";

test("floating debug entry follows the pointer within viewport bounds", () => {
  assert.deepEqual(
    resolveAnalyticsDebugFloatingPosition({
      floatingSize: { height: 44, width: 44 },
      pointerCurrent: { x: 1000, y: 900 },
      pointerStart: { x: 20, y: 20 },
      startPosition: { left: 24, top: 24 },
      viewport: { height: 600, width: 800 }
    }),
    { left: 748, top: 548 }
  );
  assert.equal(
    hasAnalyticsDebugFloatingDragMoved({
      pointerCurrent: { x: 103, y: 104 },
      pointerStart: { x: 100, y: 100 }
    }),
    false
  );
});
