import assert from "node:assert/strict";
import test from "node:test";
import {
  getDockWallpaperImageSample,
  parseDockWallpaperCssUrl,
  resolveDockWallpaperPositionOffset,
  resolveDockWallpaperRenderedImageRect,
  sampleDockWallpaperLuminanceAtElement
} from "./dockWallpaperSampling.ts";

test("caches one canvas readback per wallpaper image", () => {
  const originalDocument = globalThis.document;
  let canvasCreates = 0;
  let draws = 0;
  let readbacks = 0;
  const pixels = new Uint8ClampedArray(192 * 96 * 4);
  const context = {
    drawImage() {
      draws += 1;
    },
    getImageData() {
      readbacks += 1;
      return { data: pixels };
    }
  };
  const canvas = {
    height: 0,
    width: 0,
    getContext() {
      return context;
    }
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        canvasCreates += 1;
        return canvas;
      }
    }
  });

  try {
    const image = {
      naturalHeight: 500,
      naturalWidth: 1000
    } as HTMLImageElement;
    const first = getDockWallpaperImageSample(image);
    const second = getDockWallpaperImageSample(image);

    assert.equal(first, second);
    assert.equal(first?.width, 192);
    assert.equal(first?.height, 96);
    assert.equal(canvasCreates, 1);
    assert.equal(draws, 1);
    assert.equal(readbacks, 1);
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument
    });
  }
});

test("samples cached RGBA bytes without additional canvas readbacks", () => {
  const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const luminance = sampleDockWallpaperLuminanceAtElement({
    elementRect: rect({ height: 10, left: 0, top: 0, width: 20 }),
    renderedImageRect: { height: 10, left: 0, top: 0, width: 20 },
    sample: { data, height: 1, width: 2 },
    wallpaperRect: rect({ height: 10, left: 0, top: 0, width: 20 })
  });

  assert.ok(luminance !== null);
  assert.ok(luminance > 100 && luminance < 155);
});

test("parses quoted and unquoted wallpaper URLs", () => {
  assert.equal(
    parseDockWallpaperCssUrl('url("wallpaper.png")'),
    "wallpaper.png"
  );
  assert.equal(parseDockWallpaperCssUrl("url(wallpaper.png)"), "wallpaper.png");
  assert.equal(parseDockWallpaperCssUrl("none"), null);
  assert.equal(parseDockWallpaperCssUrl("url()"), null);
});

test("maps cover and contain images into the wallpaper container", () => {
  assert.deepEqual(
    resolveDockWallpaperRenderedImageRect({
      containerHeight: 100,
      containerWidth: 200,
      imageHeight: 100,
      imageWidth: 100,
      positionX: "50%",
      positionY: "50%",
      size: "cover"
    }),
    { height: 200, left: 0, top: -50, width: 200 }
  );
  assert.deepEqual(
    resolveDockWallpaperRenderedImageRect({
      containerHeight: 100,
      containerWidth: 200,
      imageHeight: 100,
      imageWidth: 100,
      positionX: "right",
      positionY: "bottom",
      size: "contain"
    }),
    { height: 100, left: 100, top: 0, width: 100 }
  );
});

test("supports stretched, native, percentage, and pixel wallpaper geometry", () => {
  assert.deepEqual(
    resolveDockWallpaperRenderedImageRect({
      containerHeight: 100,
      containerWidth: 200,
      imageHeight: 40,
      imageWidth: 80,
      positionX: "25%",
      positionY: "12px",
      size: "100% 100%"
    }),
    { height: 100, left: 0, top: 12, width: 200 }
  );
  assert.deepEqual(
    resolveDockWallpaperRenderedImageRect({
      containerHeight: 100,
      containerWidth: 200,
      imageHeight: 40,
      imageWidth: 80,
      positionX: "25%",
      positionY: "12px",
      size: "auto"
    }),
    { height: 40, left: 30, top: 12, width: 80 }
  );
  assert.equal(resolveDockWallpaperPositionOffset("invalid", 80), 40);
  assert.equal(resolveDockWallpaperPositionOffset("not-a-number%", 80), 40);
});

function rect({
  height,
  left,
  top,
  width
}: {
  height: number;
  left: number;
  top: number;
  width: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}
