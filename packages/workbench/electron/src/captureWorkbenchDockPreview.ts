import type { NativeImage, WebContents } from "electron";

export interface WorkbenchDockPreviewRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface WorkbenchDockPreviewSize {
  height: number;
  width: number;
}

export type WorkbenchDockPreviewCaptureDiagnosticReason =
  | "capture_empty"
  | "capture_page_failed"
  | "capture_page_timeout"
  | "data_url_empty"
  | "invalid_rect"
  | "resize_empty"
  | "web_contents_destroyed_before_capture";

export interface WorkbenchDockPreviewCaptureDiagnostic {
  error?: unknown;
  reason: WorkbenchDockPreviewCaptureDiagnosticReason;
}

export interface CaptureWorkbenchDockPreviewInput {
  contentSize: WorkbenchDockPreviewSize;
  maxHeight?: number;
  maxWidth?: number;
  onDiagnostic?: (diagnostic: WorkbenchDockPreviewCaptureDiagnostic) => void;
  rect: WorkbenchDockPreviewRect;
  timeoutMs?: number;
  webContents: Pick<WebContents, "capturePage" | "isDestroyed">;
}

export interface WorkbenchPreviewImages {
  dockPreviewImageUrl: string;
  genieImageUrl: string;
}

const defaultMaxCapturePreviewDimensionPx = 512;
const defaultCapturePreviewTimeoutMs = 2_000;
let capturePreviewQueue: Promise<void> = Promise.resolve();

export function captureWorkbenchDockPreview(
  input: CaptureWorkbenchDockPreviewInput
): Promise<string | null> {
  return captureWorkbenchPreviewImagesInternal(input, false).then(
    (images) => images?.dockPreviewImageUrl ?? null
  );
}

export function captureWorkbenchPreviewImages(
  input: CaptureWorkbenchDockPreviewInput
): Promise<WorkbenchPreviewImages | null> {
  return captureWorkbenchPreviewImagesInternal(input, true);
}

function captureWorkbenchPreviewImagesInternal(
  input: CaptureWorkbenchDockPreviewInput,
  includeGenieImage: boolean
): Promise<WorkbenchPreviewImages | null> {
  const rect = sanitizeCaptureRect(input.rect, input.contentSize);
  if (!rect) {
    emitDiagnostic(input, { reason: "invalid_rect" });
    return Promise.resolve(null);
  }

  return enqueueCapturePreview(
    async (): Promise<WorkbenchPreviewImages | null> => {
      if (input.webContents.isDestroyed()) {
        emitDiagnostic(input, {
          reason: "web_contents_destroyed_before_capture"
        });
        return null;
      }

      let image: NativeImage;
      try {
        const capturedImage = await capturePageWithTimeout(
          input.webContents,
          rect,
          sanitizeTimeout(input.timeoutMs)
        );
        if (!capturedImage) {
          emitDiagnostic(input, { reason: "capture_page_timeout" });
          return null;
        }
        image = capturedImage;
      } catch (error) {
        emitDiagnostic(input, { error, reason: "capture_page_failed" });
        return null;
      }

      if (image.isEmpty()) {
        emitDiagnostic(input, { reason: "capture_empty" });
        return null;
      }

      const genieImageUrl = includeGenieImage ? image.toDataURL() : "";
      if (includeGenieImage && !genieImageUrl) {
        emitDiagnostic(input, { reason: "data_url_empty" });
        return null;
      }

      const resized = resizeCapturePreviewImage(image, input);
      if (resized.isEmpty()) {
        emitDiagnostic(input, { reason: "resize_empty" });
        return null;
      }

      const dockPreviewImageUrl = resized.toDataURL();
      if (!dockPreviewImageUrl) {
        emitDiagnostic(input, { reason: "data_url_empty" });
        return null;
      }
      return {
        dockPreviewImageUrl,
        genieImageUrl: genieImageUrl || dockPreviewImageUrl
      };
    }
  );
}

function capturePageWithTimeout(
  webContents: Pick<WebContents, "capturePage">,
  rect: WorkbenchDockPreviewRect,
  timeoutMs: number
): Promise<NativeImage | null> {
  const capturePromise = webContents.capturePage(rect);
  capturePromise.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([capturePromise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function sanitizeCaptureRect(
  input: WorkbenchDockPreviewRect,
  bounds: WorkbenchDockPreviewSize
): WorkbenchDockPreviewRect | null {
  if (
    !isFinitePositive(bounds.width) ||
    !isFinitePositive(bounds.height) ||
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height)
  ) {
    return null;
  }

  const x = Math.max(0, Math.floor(input.x));
  const y = Math.max(0, Math.floor(input.y));
  const right = Math.min(bounds.width, Math.ceil(input.x + input.width));
  const bottom = Math.min(bounds.height, Math.ceil(input.y + input.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { height, width, x, y };
}

function enqueueCapturePreview<TResult>(
  task: () => Promise<TResult>
): Promise<TResult> {
  const result = capturePreviewQueue.then(task, task);
  capturePreviewQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function resizeCapturePreviewImage(
  image: NativeImage,
  input: Pick<CaptureWorkbenchDockPreviewInput, "maxHeight" | "maxWidth">
): NativeImage {
  const size = image.getSize();
  const maxWidth = sanitizePreviewLimit(input.maxWidth);
  const maxHeight = sanitizePreviewLimit(input.maxHeight);
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  if (!Number.isFinite(scale) || scale >= 1) {
    return image;
  }
  return image.resize({
    height: Math.max(1, Math.round(size.height * scale)),
    width: Math.max(1, Math.round(size.width * scale))
  });
}

function sanitizePreviewLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultMaxCapturePreviewDimensionPx;
  }
  return Math.min(
    defaultMaxCapturePreviewDimensionPx,
    Math.max(1, Math.round(value))
  );
}

function sanitizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultCapturePreviewTimeoutMs;
  }
  return Math.max(1, Math.round(value));
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function emitDiagnostic(
  input: Pick<CaptureWorkbenchDockPreviewInput, "onDiagnostic">,
  diagnostic: WorkbenchDockPreviewCaptureDiagnostic
): void {
  try {
    input.onDiagnostic?.(diagnostic);
  } catch {
    // Product diagnostics must not change capture behavior.
  }
}
