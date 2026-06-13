import {
  desktopIpcChannels,
  type DesktopHostWindowCapturePreviewInput
} from "../../shared/contracts/ipc";
import { createDesktopWindowAccess } from "../host/desktopWindowAccess";
import { getDesktopLogger } from "../logging";
import { registerDesktopIpcHandler } from "./handle";
import { resolveOwnerWindowFromEvent } from "./ownerWindow";

const maxCapturePreviewDimensionPx = 512;
const capturePreviewTimeoutMs = 2_000;
let capturePreviewQueue: Promise<void> = Promise.resolve();
let capturePreviewSequence = 0;

export function registerHostWindowIpc(): void {
  const windowAccess = createDesktopWindowAccess();
  const logger = getDesktopLogger();

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.approveClose,
    (event) => windowAccess.approveClose(resolveOwnerWindowFromEvent(event))
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.capturePreview,
    async (event, input) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      if (
        !ownerWindow ||
        ownerWindow.isDestroyed() ||
        ownerWindow.webContents.isDestroyed()
      ) {
        logger.warn("host window preview capture skipped", {
          reason: "owner_window_unavailable"
        });
        return null;
      }

      const contentBounds = ownerWindow.getContentBounds();
      const rect = sanitizeCaptureRect(input, {
        height: contentBounds.height,
        width: contentBounds.width
      });
      if (!rect) {
        logger.warn("host window preview capture skipped", {
          inputRect: input.rect,
          ownerWindowHeight: contentBounds.height,
          ownerWindowWidth: contentBounds.width,
          reason: "invalid_rect"
        });
        return null;
      }

      const captureId = ++capturePreviewSequence;

      return enqueueCapturePreview(async () => {
        if (
          ownerWindow.isDestroyed() ||
          ownerWindow.webContents.isDestroyed()
        ) {
          logger.warn("host window preview capture skipped", {
            captureId,
            reason: "owner_window_destroyed_before_capture"
          });
          return null;
        }

        let image: Electron.NativeImage;
        try {
          const capturedImage = await capturePageWithTimeout(
            ownerWindow.webContents
          );
          if (!capturedImage) {
            logger.warn("host window preview capture timed out", {
              captureId,
              reason: "capture_page_timeout",
              timeoutMs: capturePreviewTimeoutMs
            });
            return null;
          }
          image = capturedImage;
        } catch (error) {
          logger.warn("host window preview capture failed", {
            captureId,
            error: error instanceof Error ? error.message : String(error),
            reason: "capture_page_failed"
          });
          return null;
        }
        if (image.isEmpty()) {
          logger.warn("host window preview capture returned empty image", {
            captureId,
            reason: "full_capture_empty"
          });
          return null;
        }

        const cropRect = scaleCaptureRectForImage(rect, image.getSize(), {
          height: contentBounds.height,
          width: contentBounds.width
        });
        const cropped = image.crop(cropRect);
        if (cropped.isEmpty()) {
          logger.warn("host window preview capture crop returned empty image", {
            captureId,
            cropRect,
            imageHeight: image.getSize().height,
            imageWidth: image.getSize().width,
            reason: "crop_empty",
            requestedRect: rect
          });
          return null;
        }

        const resized = resizeCapturePreviewImage(cropped, input);
        if (resized.isEmpty()) {
          logger.warn(
            "host window preview capture resize returned empty image",
            {
              captureId,
              reason: "resize_empty"
            }
          );
          return null;
        }
        const dataUrl = resized.toDataURL();
        return dataUrl;
      });
    }
  );
}

function capturePageWithTimeout(
  webContents: Electron.WebContents
): Promise<Electron.NativeImage | null> {
  const capturePromise = webContents.capturePage();
  capturePromise.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), capturePreviewTimeoutMs);
  });
  return Promise.race([capturePromise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function sanitizeCaptureRect(
  input: DesktopHostWindowCapturePreviewInput,
  bounds: { height: number; width: number }
): {
  height: number;
  width: number;
  x: number;
  y: number;
} | null {
  const x = Math.max(0, Math.floor(input.rect.x));
  const y = Math.max(0, Math.floor(input.rect.y));
  const right = Math.min(
    bounds.width,
    Math.ceil(input.rect.x + input.rect.width)
  );
  const bottom = Math.min(
    bounds.height,
    Math.ceil(input.rect.y + input.rect.height)
  );
  const width = right - x;
  const height = bottom - y;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { height, width, x, y };
}

function enqueueCapturePreview(
  task: () => Promise<string | null>
): Promise<string | null> {
  const result = capturePreviewQueue.then(task, task);
  capturePreviewQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function scaleCaptureRectForImage(
  rect: { height: number; width: number; x: number; y: number },
  imageSize: { height: number; width: number },
  contentSize: { height: number; width: number }
): { height: number; width: number; x: number; y: number } {
  const scaleX = imageSize.width / contentSize.width;
  const scaleY = imageSize.height / contentSize.height;
  const x = Math.max(0, Math.floor(rect.x * scaleX));
  const y = Math.max(0, Math.floor(rect.y * scaleY));
  const right = Math.min(
    imageSize.width,
    Math.ceil((rect.x + rect.width) * scaleX)
  );
  const bottom = Math.min(
    imageSize.height,
    Math.ceil((rect.y + rect.height) * scaleY)
  );
  return {
    height: Math.max(1, bottom - y),
    width: Math.max(1, right - x),
    x,
    y
  };
}

function resizeCapturePreviewImage(
  image: Electron.NativeImage,
  input: DesktopHostWindowCapturePreviewInput
): Electron.NativeImage {
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
    return maxCapturePreviewDimensionPx;
  }
  return Math.min(maxCapturePreviewDimensionPx, Math.max(1, Math.round(value)));
}
