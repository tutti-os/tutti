import assert from "node:assert/strict";
import test from "node:test";
import type { NativeImage, WebContents } from "electron";
import {
  captureWorkbenchDockPreview,
  type WorkbenchDockPreviewCaptureDiagnostic,
  type WorkbenchDockPreviewRect,
  type WorkbenchDockPreviewSize
} from "./captureWorkbenchDockPreview.ts";

test("captures, scales, crops, and bounds the preview image", async () => {
  const source = new FakeNativeImage({ height: 800, width: 1_000 });
  const webContents = fakeWebContents(async () => source.asNativeImage());

  const dataUrl = await captureWorkbenchDockPreview({
    contentSize: { height: 400, width: 500 },
    maxHeight: 100,
    maxWidth: 150,
    rect: { height: 100.2, width: 200.2, x: 10.2, y: 20.2 },
    webContents
  });

  assert.equal(dataUrl, "data:image/png;base64,cHJldmlldw==");
  assert.deepEqual(source.cropRects, [
    { height: 202, width: 402, x: 20, y: 40 }
  ]);
  assert.deepEqual(source.croppedImages[0]?.resizeSizes, [
    { height: 75, width: 150 }
  ]);
});

test("clamps renderer rectangles to the content bounds", async () => {
  const source = new FakeNativeImage({ height: 200, width: 300 });

  await captureWorkbenchDockPreview({
    contentSize: { height: 100, width: 150 },
    rect: { height: 50, width: 80, x: 100, y: 80 },
    webContents: fakeWebContents(async () => source.asNativeImage())
  });

  assert.deepEqual(source.cropRects, [
    { height: 40, width: 100, x: 200, y: 160 }
  ]);
});

test("rejects invalid renderer rectangles before capture", async () => {
  const diagnostics: WorkbenchDockPreviewCaptureDiagnostic[] = [];
  let captureCalls = 0;

  const result = await captureWorkbenchDockPreview({
    contentSize: { height: 100, width: 100 },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    rect: { height: 20, width: 20, x: 120, y: 0 },
    webContents: fakeWebContents(async () => {
      captureCalls += 1;
      return new FakeNativeImage({ height: 100, width: 100 }).asNativeImage();
    })
  });

  assert.equal(result, null);
  assert.equal(captureCalls, 0);
  assert.deepEqual(diagnostics, [{ reason: "invalid_rect" }]);
});

test("reports capture timeout without leaking the late rejection", async () => {
  const diagnostics: WorkbenchDockPreviewCaptureDiagnostic[] = [];
  const lateCapture = deferred<NativeImage>();

  const result = await captureWorkbenchDockPreview({
    contentSize: { height: 100, width: 100 },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    rect: { height: 100, width: 100, x: 0, y: 0 },
    timeoutMs: 5,
    webContents: fakeWebContents(() => lateCapture.promise)
  });
  lateCapture.reject(new Error("late failure"));

  assert.equal(result, null);
  assert.deepEqual(diagnostics, [{ reason: "capture_page_timeout" }]);
});

test("reports destroyed, failed, and empty captures", async (context) => {
  const cases: {
    expectedReason: WorkbenchDockPreviewCaptureDiagnostic["reason"];
    image?: FakeNativeImage;
    isDestroyed?: boolean;
    reject?: boolean;
  }[] = [
    {
      expectedReason: "web_contents_destroyed_before_capture",
      isDestroyed: true
    },
    { expectedReason: "capture_page_failed", reject: true },
    {
      expectedReason: "full_capture_empty",
      image: new FakeNativeImage({ height: 100, width: 100 }, { empty: true })
    },
    {
      expectedReason: "crop_empty",
      image: new FakeNativeImage(
        { height: 100, width: 100 },
        { cropEmpty: true }
      )
    },
    {
      expectedReason: "resize_empty",
      image: new FakeNativeImage(
        { height: 100, width: 100 },
        { resizeEmpty: true }
      )
    },
    {
      expectedReason: "data_url_empty",
      image: new FakeNativeImage({ height: 100, width: 100 }, { dataUrl: "" })
    }
  ];

  for (const item of cases) {
    await context.test(item.expectedReason, async () => {
      const diagnostics: WorkbenchDockPreviewCaptureDiagnostic[] = [];
      const webContents = fakeWebContents(
        item.reject
          ? async () => {
              throw new Error("capture failed");
            }
          : async () =>
              (
                item.image ?? new FakeNativeImage({ height: 100, width: 100 })
              ).asNativeImage(),
        item.isDestroyed
      );

      const result = await captureWorkbenchDockPreview({
        contentSize: { height: 100, width: 100 },
        maxHeight: item.expectedReason === "resize_empty" ? 50 : undefined,
        maxWidth: item.expectedReason === "resize_empty" ? 50 : undefined,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        rect: { height: 100, width: 100, x: 0, y: 0 },
        webContents
      });

      assert.equal(result, null);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.reason, item.expectedReason);
    });
  }
});

test("serializes capturePage calls", async () => {
  const firstCapture = deferred<NativeImage>();
  const callOrder: string[] = [];
  const first = captureWorkbenchDockPreview({
    contentSize: { height: 100, width: 100 },
    rect: { height: 100, width: 100, x: 0, y: 0 },
    webContents: fakeWebContents(() => {
      callOrder.push("first");
      return firstCapture.promise;
    })
  });
  const second = captureWorkbenchDockPreview({
    contentSize: { height: 100, width: 100 },
    rect: { height: 100, width: 100, x: 0, y: 0 },
    webContents: fakeWebContents(async () => {
      callOrder.push("second");
      return new FakeNativeImage({ height: 100, width: 100 }).asNativeImage();
    })
  });

  await waitFor(() => callOrder.length === 1);
  assert.deepEqual(callOrder, ["first"]);
  firstCapture.resolve(
    new FakeNativeImage({ height: 100, width: 100 }).asNativeImage()
  );
  await Promise.all([first, second]);

  assert.deepEqual(callOrder, ["first", "second"]);
});

class FakeNativeImage {
  readonly cropRects: WorkbenchDockPreviewRect[] = [];
  readonly croppedImages: FakeNativeImage[] = [];
  readonly resizeSizes: WorkbenchDockPreviewSize[] = [];
  private readonly dataUrl: string;
  private readonly empty: boolean;
  private readonly cropEmpty: boolean;
  private readonly resizeEmpty: boolean;
  private readonly size: WorkbenchDockPreviewSize;

  constructor(
    size: WorkbenchDockPreviewSize,
    options: {
      cropEmpty?: boolean;
      dataUrl?: string;
      empty?: boolean;
      resizeEmpty?: boolean;
    } = {}
  ) {
    this.cropEmpty = options.cropEmpty ?? false;
    this.dataUrl = options.dataUrl ?? "data:image/png;base64,cHJldmlldw==";
    this.empty = options.empty ?? false;
    this.resizeEmpty = options.resizeEmpty ?? false;
    this.size = size;
  }

  asNativeImage(): NativeImage {
    return this as unknown as NativeImage;
  }

  crop(rect: WorkbenchDockPreviewRect): NativeImage {
    this.cropRects.push(rect);
    const cropped = new FakeNativeImage(
      { height: rect.height, width: rect.width },
      {
        dataUrl: this.dataUrl,
        empty: this.cropEmpty,
        resizeEmpty: this.resizeEmpty
      }
    );
    this.croppedImages.push(cropped);
    return cropped.asNativeImage();
  }

  getSize(): WorkbenchDockPreviewSize {
    return this.size;
  }

  isEmpty(): boolean {
    return this.empty;
  }

  resize(size: WorkbenchDockPreviewSize): NativeImage {
    this.resizeSizes.push(size);
    return new FakeNativeImage(size, {
      dataUrl: this.dataUrl,
      empty: this.resizeEmpty
    }).asNativeImage();
  }

  toDataURL(): string {
    return this.dataUrl;
  }
}

function fakeWebContents(
  capturePage: () => Promise<NativeImage>,
  destroyed = false
): Pick<WebContents, "capturePage" | "isDestroyed"> {
  return {
    capturePage,
    isDestroyed: () => destroyed
  } as Pick<WebContents, "capturePage" | "isDestroyed">;
}

function deferred<T>(): {
  promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
} {
  let rejectPromise = (_reason: unknown): void => undefined;
  let resolvePromise = (_value: T): void => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
