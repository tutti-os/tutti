import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveInitialMinimizedStackScrollOffset,
  resolveMaxMinimizedStackTrackTranslateXPx,
  resolveMinimizedStackFocalCardIndex,
  resolveMinimizedStackLeftGutterPx,
  resolveMinimizedStackPanelWidthPx,
  resolveMinimizedStackPopupLeftPx,
  resolveMinimizedStackPopupTopPx,
  resolveMinimizedStackTrackHeightPx,
  resolveMinimizedStackTrackTranslateXPx,
  resolveMinimizedStackViewportHeightPx
} from "./minimizedStackScroll.ts";

test("minimized stack opens scrolled to the newest items", () => {
  assert.equal(
    resolveInitialMinimizedStackScrollOffset({
      maxScrollOffset: 240
    }),
    240
  );
});

test("left minimized stack viewport stays within space above the anchor", () => {
  assert.equal(
    resolveMinimizedStackViewportHeightPx({
      anchorCenterY: 420,
      placement: "left",
      trackHeightPx: 900,
      viewportHeightPx: 800
    }),
    364
  );
});

test("left minimized stack keeps short tracks fully visible", () => {
  assert.equal(
    resolveMinimizedStackViewportHeightPx({
      anchorCenterY: 680,
      placement: "left",
      trackHeightPx: 320,
      viewportHeightPx: 800
    }),
    320
  );
});

test("bottom minimized stack uses the global viewport cap", () => {
  assert.equal(
    resolveMinimizedStackViewportHeightPx({
      anchorCenterY: 680,
      placement: "bottom",
      trackHeightPx: 900,
      viewportHeightPx: 800
    }),
    800
  );
});

test("left minimized stack panel width reserves title tips without fan drift", () => {
  assert.equal(resolveMinimizedStackPanelWidthPx(1, "left"), 362);
  assert.equal(resolveMinimizedStackPanelWidthPx(10, "left"), 416);
  assert.equal(
    resolveMinimizedStackPanelWidthPx(10, "left", { leftGutterPx: 18 }),
    368
  );
});

test("left minimized stack gutter stays tight at the newest edge and grows while scrolling", () => {
  const itemCount = 13;
  const trackHeightPx = resolveMinimizedStackTrackHeightPx(itemCount);
  const viewportHeightPx = 320;
  const maxScrollOffset = Math.max(0, trackHeightPx - viewportHeightPx);
  const atBottomTranslateXPx = resolveMinimizedStackTrackTranslateXPx({
    itemCount,
    placement: "left",
    scrollOffset: maxScrollOffset,
    trackHeightPx,
    viewportHeightPx
  });
  const atTopTranslateXPx = resolveMinimizedStackTrackTranslateXPx({
    itemCount,
    placement: "left",
    scrollOffset: 0,
    trackHeightPx,
    viewportHeightPx
  });

  const gutterAtBottom = resolveMinimizedStackLeftGutterPx({
    itemCount,
    placement: "left",
    scrollOffset: maxScrollOffset,
    trackHeightPx,
    viewportHeightPx,
    trackTranslateXPx: atBottomTranslateXPx
  });
  assert.ok(gutterAtBottom <= 24);
  const gutterAtTop = resolveMinimizedStackLeftGutterPx({
    itemCount,
    placement: "left",
    scrollOffset: 0,
    trackHeightPx,
    viewportHeightPx,
    trackTranslateXPx: atTopTranslateXPx
  });
  assert.ok(gutterAtTop >= 4);
  assert.ok(gutterAtTop <= gutterAtBottom);
});

test("left minimized stack popup shifts left when extra gutter is required", () => {
  assert.equal(
    resolveMinimizedStackPopupLeftPx({
      anchorLeft: 24,
      anchorWidth: 40,
      leftGutterPx: 4
    }),
    70
  );
  assert.equal(
    resolveMinimizedStackPopupLeftPx({
      anchorLeft: 24,
      anchorWidth: 40,
      leftGutterPx: 28
    }),
    46
  );
});

test("left minimized stack popup clears the dock viewport", () => {
  assert.equal(
    resolveMinimizedStackPopupLeftPx({
      anchorLeft: 24,
      anchorWidth: 40
    }),
    70
  );
  assert.equal(
    resolveMinimizedStackPopupLeftPx({
      anchorLeft: 24,
      anchorWidth: 40,
      dockRightPx: 156
    }),
    98
  );
  assert.equal(
    resolveMinimizedStackPopupTopPx({
      anchorTop: 180
    }),
    212
  );
});

test("left minimized stack track translate x pins the focal card center while scrolling", () => {
  const trackHeightPx = resolveMinimizedStackTrackHeightPx(6);
  const viewportHeightPx = 320;
  const maxScrollOffset = Math.max(0, trackHeightPx - viewportHeightPx);
  const maxTranslateXPx = resolveMaxMinimizedStackTrackTranslateXPx(6, "left");
  const atBottom = resolveMinimizedStackTrackTranslateXPx({
    itemCount: 6,
    placement: "left",
    scrollOffset: maxScrollOffset,
    trackHeightPx,
    viewportHeightPx
  });
  const atTop = resolveMinimizedStackTrackTranslateXPx({
    itemCount: 6,
    placement: "left",
    scrollOffset: 0,
    trackHeightPx,
    viewportHeightPx
  });
  const focalAtBottom = resolveMinimizedStackFocalCardIndex({
    itemCount: 6,
    scrollOffset: maxScrollOffset,
    trackHeightPx,
    viewportHeightPx
  });
  const focalAtTop = resolveMinimizedStackFocalCardIndex({
    itemCount: 6,
    scrollOffset: 0,
    trackHeightPx,
    viewportHeightPx
  });

  assert.ok(atBottom < atTop);
  assert.ok(atTop <= maxTranslateXPx + 0.001);
  assert.ok(focalAtBottom < focalAtTop);
  assert.ok(focalAtBottom < 1.5);
  assert.ok(focalAtTop > 4);
});

test("bottom minimized stack keeps the focal card center pinned while scrolling", () => {
  const trackHeightPx = resolveMinimizedStackTrackHeightPx(6);
  const viewportHeightPx = 320;
  const maxScrollOffset = Math.max(0, trackHeightPx - viewportHeightPx);
  const atBottom = resolveMinimizedStackTrackTranslateXPx({
    itemCount: 6,
    placement: "bottom",
    scrollOffset: maxScrollOffset,
    trackHeightPx,
    viewportHeightPx
  });
  const atTop = resolveMinimizedStackTrackTranslateXPx({
    itemCount: 6,
    placement: "bottom",
    scrollOffset: 0,
    trackHeightPx,
    viewportHeightPx
  });

  assert.ok(atBottom > atTop);
  assert.ok(Math.abs(atBottom) < Math.abs(atTop));
});
