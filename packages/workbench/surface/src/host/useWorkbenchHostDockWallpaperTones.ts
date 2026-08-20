import { useLayoutEffect, useState, type RefObject } from "react";
import {
  getDockWallpaperImageSample,
  parseDockWallpaperCssUrl,
  resolveDockWallpaperRenderedImageRect,
  sampleDockWallpaperLuminanceAtElement
} from "./dockWallpaperSampling.ts";

export type WorkbenchDockWallpaperTone = "dark" | "light";

const dockWallpaperDarkLuminanceThreshold = 132;
const dockWallpaperImageCache = new Map<
  string,
  Promise<HTMLImageElement | null>
>();

export function useWorkbenchHostDockWallpaperTones({
  dockItemsRef,
  elementRefs,
  itemKeys
}: {
  dockItemsRef: RefObject<HTMLElement | null>;
  elementRefs: RefObject<Map<string, HTMLElement>>;
  itemKeys: string;
}): ReadonlyMap<string, WorkbenchDockWallpaperTone> {
  const [tones, setTones] = useState<Map<string, WorkbenchDockWallpaperTone>>(
    () => new Map()
  );

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let canceled = false;
    let frameId: number | null = null;

    const updateTones = () => {
      frameId = null;
      void resolveDockWallpaperTones({
        dockItemsElement: dockItemsRef.current,
        elements: elementRefs.current
      }).then((nextTones) => {
        if (canceled) {
          return;
        }
        setTones((current) =>
          dockWallpaperToneMapsEqual(current, nextTones) ? current : nextTones
        );
      });
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(updateTones);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    if (dockItemsRef.current) {
      resizeObserver?.observe(dockItemsRef.current);
    }
    const wallpaperElement = dockItemsRef.current
      ?.closest(".workbench-surface")
      ?.querySelector(".workbench-surface__wallpaper");
    if (wallpaperElement instanceof HTMLElement) {
      resizeObserver?.observe(wallpaperElement);
    }

    return () => {
      canceled = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [dockItemsRef, elementRefs, itemKeys]);

  return tones;
}

async function resolveDockWallpaperTones({
  dockItemsElement,
  elements
}: {
  dockItemsElement: HTMLElement | null;
  elements: ReadonlyMap<string, HTMLElement>;
}): Promise<Map<string, WorkbenchDockWallpaperTone>> {
  const wallpaperElement = dockItemsElement
    ?.closest(".workbench-surface")
    ?.querySelector(".workbench-surface__wallpaper");
  if (!(wallpaperElement instanceof HTMLElement)) {
    return new Map();
  }

  const wallpaperStyle = window.getComputedStyle(wallpaperElement);
  const wallpaperUrl = parseDockWallpaperCssUrl(wallpaperStyle.backgroundImage);
  if (!wallpaperUrl) {
    return new Map();
  }

  const wallpaperImage = await loadDockWallpaperImage(wallpaperUrl);
  if (!wallpaperImage) {
    return new Map();
  }

  const wallpaperSample = getDockWallpaperImageSample(wallpaperImage);
  if (!wallpaperSample) {
    return new Map();
  }

  const wallpaperRect = wallpaperElement.getBoundingClientRect();
  const renderedImageRect = resolveDockWallpaperRenderedImageRect({
    containerHeight: wallpaperRect.height,
    containerWidth: wallpaperRect.width,
    imageHeight: wallpaperImage.naturalHeight,
    imageWidth: wallpaperImage.naturalWidth,
    positionX: wallpaperStyle.backgroundPositionX,
    positionY: wallpaperStyle.backgroundPositionY,
    size: wallpaperStyle.backgroundSize
  });
  const nextTones = new Map<string, WorkbenchDockWallpaperTone>();

  for (const [key, element] of elements) {
    const luminance = sampleDockWallpaperLuminanceAtElement({
      elementRect: element.getBoundingClientRect(),
      renderedImageRect,
      sample: wallpaperSample,
      wallpaperRect
    });
    if (luminance === null) {
      continue;
    }
    nextTones.set(
      key,
      luminance < dockWallpaperDarkLuminanceThreshold ? "dark" : "light"
    );
  }

  return nextTones;
}

function loadDockWallpaperImage(url: string): Promise<HTMLImageElement | null> {
  const cached = dockWallpaperImageCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
  dockWallpaperImageCache.set(url, promise);
  return promise;
}

function dockWallpaperToneMapsEqual(
  left: ReadonlyMap<string, WorkbenchDockWallpaperTone>,
  right: ReadonlyMap<string, WorkbenchDockWallpaperTone>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}
