import type {
  BrowserNodeDevicePreset,
  BrowserNodeSaveScreenshotInput,
  BrowserNodeScreenshotSaveResult,
  BrowserNodeSetZoomFactorInput
} from "../core/types.ts";
import type {
  BrowserGuestWebContents,
  BrowserNodeScreenshotCapture
} from "./types.ts";

const minimumBrowserZoomFactor = 0.25;
const maximumBrowserZoomFactor = 5;

export async function clearBrowserGuestData(
  contents: BrowserGuestWebContents | null | undefined
): Promise<void> {
  const electronSession = contents?.session;
  if (!contents || contents.isDestroyed() || !electronSession) {
    return;
  }
  await Promise.all([
    electronSession.clearStorageData?.(),
    electronSession.clearCache?.()
  ]);
  contents.reload();
}

export function printBrowserGuestPage(
  contents: BrowserGuestWebContents | null | undefined
): Promise<void> {
  if (!contents || contents.isDestroyed() || !contents.print) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    contents.print?.({}, (success, failureReason) => {
      if (success || failureReason === "Print job canceled") {
        resolve();
        return;
      }
      reject(new Error(failureReason || "Browser page printing failed"));
    });
  });
}

export async function saveBrowserGuestScreenshot(
  contents: BrowserGuestWebContents | null | undefined,
  input: BrowserNodeSaveScreenshotInput,
  saveScreenshot:
    | ((
        input: BrowserNodeScreenshotCapture
      ) => Promise<BrowserNodeScreenshotSaveResult>)
    | undefined
): Promise<BrowserNodeScreenshotSaveResult> {
  if (!contents || contents.isDestroyed()) {
    return { filePath: null, saved: false };
  }
  const dataUrl =
    input.mode === "full-page"
      ? await captureFullBrowserGuestPage(contents)
      : await captureVisibleBrowserGuestPage(contents);
  if (!dataUrl || !saveScreenshot) {
    return { filePath: null, saved: false };
  }
  return saveScreenshot({
    dataUrl,
    suggestedFileName: resolveScreenshotFileName(contents.getTitle())
  });
}

export function setBrowserGuestDeviceEmulation(
  contents: BrowserGuestWebContents | null | undefined,
  preset: BrowserNodeDevicePreset
): boolean {
  if (!contents || contents.isDestroyed()) {
    return false;
  }
  if (preset === "desktop") {
    if (!contents.disableDeviceEmulation) {
      return false;
    }
    contents.disableDeviceEmulation?.();
    return true;
  }
  if (!contents.enableDeviceEmulation) {
    return false;
  }
  const size = resolveDevicePreset(preset);
  contents.enableDeviceEmulation?.({
    deviceScaleFactor: size.deviceScaleFactor,
    scale: 1,
    screenPosition: "mobile",
    screenSize: { height: size.height, width: size.width },
    viewSize: { height: size.height, width: size.width }
  });
  return true;
}

export function setBrowserGuestZoomFactor(
  contents: BrowserGuestWebContents | null | undefined,
  input: BrowserNodeSetZoomFactorInput
): boolean {
  if (!contents || contents.isDestroyed()) {
    return false;
  }
  contents.zoomFactor = clampBrowserZoomFactor(input.zoomFactor);
  return true;
}

export function readFoundInPageResult(value: unknown): {
  activeMatchOrdinal: number;
  finalUpdate: boolean;
  matches: number;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = value as Record<string, unknown>;
  return {
    activeMatchOrdinal:
      typeof result.activeMatchOrdinal === "number"
        ? result.activeMatchOrdinal
        : 0,
    finalUpdate: result.finalUpdate === true,
    matches: typeof result.matches === "number" ? result.matches : 0
  };
}

function clampBrowserZoomFactor(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(
    maximumBrowserZoomFactor,
    Math.max(minimumBrowserZoomFactor, Math.round(value * 100) / 100)
  );
}

function resolveScreenshotFileName(title: string): string {
  const normalized = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `${normalized || "browser-screenshot"}.png`;
}

async function captureVisibleBrowserGuestPage(
  contents: BrowserGuestWebContents
): Promise<string | null> {
  if (!contents.capturePage) {
    return null;
  }
  const image = await contents.capturePage();
  return image.isEmpty?.() === true ? null : image.toDataURL();
}

async function captureFullBrowserGuestPage(
  contents: BrowserGuestWebContents
): Promise<string | null> {
  const browserDebugger = contents.debugger;
  if (!browserDebugger) {
    return null;
  }
  const wasAttached = browserDebugger.isAttached();
  if (!wasAttached) {
    browserDebugger.attach();
  }
  try {
    const metrics = (await browserDebugger.sendCommand(
      "Page.getLayoutMetrics"
    )) as Record<string, unknown>;
    const size = readContentSize(metrics.cssContentSize ?? metrics.contentSize);
    const result = (await browserDebugger.sendCommand(
      "Page.captureScreenshot",
      {
        captureBeyondViewport: true,
        clip: { height: size.height, scale: 1, width: size.width, x: 0, y: 0 },
        format: "png",
        fromSurface: true
      }
    )) as { data?: unknown };
    return typeof result.data === "string"
      ? `data:image/png;base64,${result.data}`
      : null;
  } finally {
    if (!wasAttached && browserDebugger.isAttached()) {
      browserDebugger.detach();
    }
  }
}

function readContentSize(value: unknown): { height: number; width: number } {
  const size =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    height: clampScreenshotDimension(size.height),
    width: clampScreenshotDimension(size.width)
  };
}

function clampScreenshotDimension(value: unknown): number {
  return Math.min(
    32_767,
    Math.max(1, Math.ceil(typeof value === "number" ? value : 1))
  );
}

function resolveDevicePreset(
  preset: Exclude<BrowserNodeDevicePreset, "desktop">
): {
  deviceScaleFactor: number;
  height: number;
  width: number;
} {
  switch (preset) {
    case "iphone-14":
      return { deviceScaleFactor: 3, height: 844, width: 390 };
    case "pixel-7":
      return { deviceScaleFactor: 3, height: 915, width: 412 };
    case "ipad-air":
      return { deviceScaleFactor: 2, height: 1180, width: 820 };
  }
}
