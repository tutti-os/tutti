import assert from "node:assert/strict";
import test from "node:test";
import { resolveDockPopupVerticalClampOffsetPx } from "./dockPopupViewportClamp.ts";

test("dock popup stays put when it already fits the viewport", () => {
  assert.equal(
    resolveDockPopupVerticalClampOffsetPx({
      naturalBottomPx: 500,
      naturalTopPx: 300,
      viewportHeightPx: 800
    }),
    0
  );
});

test("dock popup shifts down when it overflows above the viewport", () => {
  assert.equal(
    resolveDockPopupVerticalClampOffsetPx({
      naturalBottomPx: 150,
      naturalTopPx: -40,
      viewportHeightPx: 800
    }),
    48
  );
});

test("dock popup shifts up when it overflows below the viewport", () => {
  assert.equal(
    resolveDockPopupVerticalClampOffsetPx({
      naturalBottomPx: 820,
      naturalTopPx: 700,
      viewportHeightPx: 800
    }),
    -28
  );
});

test("dock popup taller than the viewport pins to the top margin", () => {
  assert.equal(
    resolveDockPopupVerticalClampOffsetPx({
      naturalBottomPx: 1200,
      naturalTopPx: -100,
      viewportHeightPx: 800
    }),
    108
  );
});

test("dock popup honors a custom margin", () => {
  assert.equal(
    resolveDockPopupVerticalClampOffsetPx({
      marginPx: 16,
      naturalBottomPx: 100,
      naturalTopPx: -20,
      viewportHeightPx: 800
    }),
    36
  );
});
