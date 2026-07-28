import assert from "node:assert/strict";
import test from "node:test";
import {
  centerPointFromRect,
  easeInOutCubic,
  easeInQuadratic,
  easeOutQuadratic,
  isGenieTextureResolutionSufficient,
  lerpGenieValue,
  renderGenieScanlines,
  renderGenieWarmupFrames,
  resolveGenieWarmupTextureSize
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

test("rejects preview images that would be enlarged for a genie texture", () => {
  const windowRect = { height: 709.4, width: 1_036.5 };

  assert.equal(
    isGenieTextureResolutionSufficient({ height: 170, width: 260 }, windowRect),
    false
  );
  assert.equal(
    isGenieTextureResolutionSufficient(
      { height: 709, width: 1_037 },
      windowRect
    ),
    true
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

test("warms the real genie scanline and glow paths with a representative texture", () => {
  const drawCalls: unknown[][] = [];
  const clearCalls: unknown[][] = [];
  let gradientCalls = 0;
  const context = {
    clearRect(...args: unknown[]) {
      clearCalls.push(args);
    },
    createRadialGradient() {
      gradientCalls += 1;
      return { addColorStop() {} };
    },
    drawImage(...args: unknown[]) {
      drawCalls.push(args);
    },
    fillRect() {}
  } as never as CanvasRenderingContext2D;
  const size = resolveGenieWarmupTextureSize(1_920, 1_050);
  const texture = {
    height: size.height,
    width: size.width
  } as HTMLCanvasElement;

  renderGenieWarmupFrames(context, 1_920, 1_050, texture);

  assert.deepEqual(size, { height: 735, width: 1_248 });
  assert.ok(drawCalls.length > 0);
  assert.ok(drawCalls.every((call) => call[0] === texture));
  assert.ok(gradientCalls > 0);
  assert.deepEqual(clearCalls.at(-1), [0, 0, 1_920, 1_050]);
});
