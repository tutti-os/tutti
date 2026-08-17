const dockWallpaperSampleMaxSizePx = 192;
const dockWallpaperToneSampleCount = 7;

export interface DockWallpaperImageSample {
  data: Uint8ClampedArray;
  height: number;
  width: number;
}

export interface DockWallpaperRenderedImageRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

const sampleByImage = new WeakMap<
  HTMLImageElement,
  DockWallpaperImageSample | null
>();

export function getDockWallpaperImageSample(
  image: HTMLImageElement
): DockWallpaperImageSample | null {
  if (sampleByImage.has(image)) {
    return sampleByImage.get(image) ?? null;
  }

  const sample = createDockWallpaperImageSample(image);
  sampleByImage.set(image, sample);
  return sample;
}

function createDockWallpaperImageSample(
  image: HTMLImageElement
): DockWallpaperImageSample | null {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return null;
  }
  const canvas = document.createElement("canvas");
  const scale =
    dockWallpaperSampleMaxSizePx /
    Math.max(image.naturalWidth, image.naturalHeight);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
      height: canvas.height,
      width: canvas.width
    };
  } catch {
    return null;
  }
}

export function sampleDockWallpaperLuminanceAtElement({
  elementRect,
  renderedImageRect,
  sample,
  wallpaperRect
}: {
  elementRect: DOMRect;
  renderedImageRect: DockWallpaperRenderedImageRect;
  sample: DockWallpaperImageSample;
  wallpaperRect: DOMRect;
}): number | null {
  const isVerticalElement = elementRect.height >= elementRect.width;
  let luminanceSum = 0;
  let samples = 0;

  for (let index = 0; index < dockWallpaperToneSampleCount; index += 1) {
    const ratio = index / (dockWallpaperToneSampleCount - 1);
    const clientX = isVerticalElement
      ? elementRect.left + elementRect.width / 2
      : elementRect.left + elementRect.width * ratio;
    const clientY = isVerticalElement
      ? elementRect.top + elementRect.height * ratio
      : elementRect.top + elementRect.height / 2;
    const imageX =
      (clientX - wallpaperRect.left - renderedImageRect.left) /
      renderedImageRect.width;
    const imageY =
      (clientY - wallpaperRect.top - renderedImageRect.top) /
      renderedImageRect.height;
    if (imageX < 0 || imageX > 1 || imageY < 0 || imageY > 1) {
      continue;
    }
    const sampleX = Math.min(
      sample.width - 1,
      Math.max(0, Math.round(imageX * (sample.width - 1)))
    );
    const sampleY = Math.min(
      sample.height - 1,
      Math.max(0, Math.round(imageY * (sample.height - 1)))
    );
    const pixelOffset = (sampleY * sample.width + sampleX) * 4;
    const red = sample.data[pixelOffset] ?? 0;
    const green = sample.data[pixelOffset + 1] ?? 0;
    const blue = sample.data[pixelOffset + 2] ?? 0;
    luminanceSum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    samples += 1;
  }

  return samples > 0 ? luminanceSum / samples : null;
}

export function parseDockWallpaperCssUrl(
  backgroundImage: string
): string | null {
  const match = /^url\((['"]?)(.*)\1\)$/u.exec(backgroundImage.trim());
  return match?.[2] ? match[2] : null;
}

export function resolveDockWallpaperRenderedImageRect({
  containerHeight,
  containerWidth,
  imageHeight,
  imageWidth,
  positionX,
  positionY,
  size
}: {
  containerHeight: number;
  containerWidth: number;
  imageHeight: number;
  imageWidth: number;
  positionX: string;
  positionY: string;
  size: string;
}): DockWallpaperRenderedImageRect {
  const imageAspect = imageWidth / imageHeight;
  const containerAspect = containerWidth / containerHeight;
  let width = containerWidth;
  let height = containerHeight;

  if (size === "cover") {
    if (containerAspect > imageAspect) {
      height = containerWidth / imageAspect;
    } else {
      width = containerHeight * imageAspect;
    }
  } else if (size === "contain") {
    if (containerAspect > imageAspect) {
      width = containerHeight * imageAspect;
    } else {
      height = containerWidth / imageAspect;
    }
  } else if (size !== "100% 100%") {
    width = imageWidth;
    height = imageHeight;
  }

  return {
    height,
    left: resolveDockWallpaperPositionOffset(positionX, containerWidth - width),
    top: resolveDockWallpaperPositionOffset(
      positionY,
      containerHeight - height
    ),
    width
  };
}

export function resolveDockWallpaperPositionOffset(
  value: string,
  availableSpace: number
): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percentage = Number.parseFloat(trimmed);
    return Number.isFinite(percentage)
      ? (availableSpace * percentage) / 100
      : availableSpace / 2;
  }
  if (trimmed.endsWith("px")) {
    const px = Number.parseFloat(trimmed);
    return Number.isFinite(px) ? px : availableSpace / 2;
  }
  if (trimmed === "left" || trimmed === "top") {
    return 0;
  }
  if (trimmed === "right" || trimmed === "bottom") {
    return availableSpace;
  }
  return availableSpace / 2;
}
