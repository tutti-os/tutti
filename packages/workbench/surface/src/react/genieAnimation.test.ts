import assert from "node:assert/strict";
import test from "node:test";
import {
  centerPointFromRect,
  easeInOutCubic,
  easeInQuadratic,
  easeOutQuadratic,
  lerpGenieValue,
  renderGenieScanlines
} from "./genieAnimation.ts";

test("keeps genie easing helpers clamped at key points", () => {
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(2), 1);

  assert.equal(easeInQuadratic(0.5), 0.25);
  assert.equal(easeOutQuadratic(0.5), 0.75);
});

test("derives stable genie geometry primitives", () => {
  assert.equal(lerpGenieValue(10, 30, 0.25), 15);
  assert.deepEqual(
    centerPointFromRect({ left: 10, top: 20, width: 40, height: 60 }),
    {
      x: 30,
      y: 50
    }
  );
});

test("maps small genie textures onto full destination rects without exposing scanline gaps", () => {
  const drawCalls: unknown[][] = [];
  const context = {
    clearRect() {},
    drawImage(...args: unknown[]) {
      drawCalls.push(args);
    }
  } as never as CanvasRenderingContext2D;

  renderGenieScanlines(context, 400, 300, {
    direction: "minimize",
    dockPoint: { x: 250, y: 180 },
    progress: 0.5,
    texture: { height: 10, width: 20 } as HTMLCanvasElement,
    textureRect: { height: 100, left: 10, top: 20, width: 200 }
  });

  assert.ok(drawCalls.length > 0);
  const firstDrawCall = drawCalls[0] as [
    HTMLCanvasElement,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ];
  assert.equal(firstDrawCall[3], 20);
  assert.equal(firstDrawCall[4], 1);
  assert.ok(firstDrawCall[7] > 100);
  assert.ok(firstDrawCall[8] > 10);
});
