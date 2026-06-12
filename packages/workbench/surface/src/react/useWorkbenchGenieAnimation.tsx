import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { WorkbenchController } from "../store/types.ts";
import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKeyResolver
} from "./dockPreviewCache.ts";
import {
  centerPointFromRect,
  copyGenieComputedStyleTree,
  easeInQuadratic,
  isUsableGenieRect,
  renderGenieScanlines,
  viewportRectFromElement,
  type WorkbenchGenieDirection,
  type WorkbenchGenieViewportRect
} from "./genieAnimation.ts";

const genieDurationMs = 400;
const genieMaxDevicePixelRatio = 2;
const genieSnapshotScale = 1;
const minimizedDockSlotEnterAnimationMs = 720;
const dockPreviewMaxWidth = 260;
const dockPreviewMaxHeight = 170;
const dockPreviewImageCacheMaxEntries = 96;
const inlineImageResourceCacheMaxEntries = 160;
const dockAnchorFallbackSizePx = 43.2;
const dockPreviewImageByNodeID = new Map<string, string>();
const inlineImageResourceByUrl = new Map<string, Promise<string | null>>();

interface CapturedGenieTexture {
  canvas: HTMLCanvasElement;
  rect: WorkbenchGenieViewportRect;
}

interface PreparedGenieTextureCapture {
  clone: HTMLElement;
  imageUrls: Array<string | null>;
  rect: WorkbenchGenieViewportRect;
}

function resolveWorkbenchCaptureElement(
  windowElement: HTMLElement
): HTMLElement {
  return (
    windowElement.querySelector<HTMLElement>(
      '[data-workbench-window-capture="true"]'
    ) ??
    windowElement.querySelector<HTMLElement>(".workbench-window") ??
    windowElement
  );
}

export interface WorkbenchGenieController {
  genieLayer: ReactNode;
  isNodeGenieHidden: (nodeID: string) => boolean;
  launchNodeFromAnchor: (
    anchorKey: string,
    nodeID: string,
    launch: () => Promise<string | null | void> | string | null | void
  ) => void;
  minimizeNodeToAnchor: (nodeID: string, minimize?: () => void) => void;
  registerDockAnchor: (anchorKey: string, element: HTMLElement | null) => void;
  shouldAnimateMinimizedDockEnter: (nodeID: string) => boolean;
}

export type WorkbenchNodePreviewImageCapture<TData = unknown> = (
  node: WorkbenchNode<TData>
) => Promise<string | null> | string | null;

function shouldReduceMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resolveGenieAnimationProgress(
  direction: WorkbenchGenieDirection,
  progress: number
): number {
  return direction === "open" ? easeInQuadratic(progress) : progress;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("image blob reader produced a non-string result"));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("image blob reader failed"));
    });
    reader.readAsDataURL(blob);
  });
}

function resolveImageResourceUrl(image: HTMLImageElement): string | null {
  return image.currentSrc || image.src || image.getAttribute("src") || null;
}

async function fetchInlineImageResource(
  imageUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`image fetch failed with status ${response.status}`);
    }
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

function readInlineImageResource(imageUrl: string): Promise<string | null> {
  if (imageUrl.startsWith("data:")) {
    return Promise.resolve(imageUrl);
  }

  const cached = inlineImageResourceByUrl.get(imageUrl);
  if (cached) {
    inlineImageResourceByUrl.delete(imageUrl);
    inlineImageResourceByUrl.set(imageUrl, cached);
    return cached;
  }

  const promise = fetchInlineImageResource(imageUrl);
  inlineImageResourceByUrl.set(imageUrl, promise);
  while (inlineImageResourceByUrl.size > inlineImageResourceCacheMaxEntries) {
    const oldestImageUrl = inlineImageResourceByUrl.keys().next().value;
    if (typeof oldestImageUrl !== "string") {
      break;
    }
    inlineImageResourceByUrl.delete(oldestImageUrl);
  }
  return promise;
}

async function inlineCloneImageResources({
  cloneRoot,
  imageUrls
}: {
  cloneRoot: HTMLElement;
  imageUrls: Array<string | null>;
}): Promise<void> {
  const cloneImages = Array.from(cloneRoot.querySelectorAll("img"));

  await Promise.all(
    imageUrls.map(async (imageUrl, index) => {
      const cloneImage = cloneImages[index];
      if (!cloneImage) {
        return;
      }

      cloneImage.removeAttribute("srcset");
      cloneImage.removeAttribute("sizes");
      if (!imageUrl) {
        return;
      }
      cloneImage.src = (await readInlineImageResource(imageUrl)) ?? imageUrl;
    })
  );
}

async function loadImageFromSvg(svg: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}

function prepareElementTextureCapture(
  element: HTMLElement
): PreparedGenieTextureCapture | null {
  const windowRect = viewportRectFromElement(element);
  if (!isUsableGenieRect(windowRect)) {
    return null;
  }

  const imageUrls = Array.from(element.querySelectorAll("img")).map(
    resolveImageResourceUrl
  );
  const clone = element.cloneNode(true) as HTMLElement;
  copyGenieComputedStyleTree(element, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.position = "relative";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = `${windowRect.width}px`;
  clone.style.height = `${windowRect.height}px`;
  clone.style.transform = "none";
  clone.style.opacity = "1";
  clone.style.visibility = "visible";
  clone.style.pointerEvents = "none";
  return { clone, imageUrls, rect: windowRect };
}

async function renderPreparedElementTexture({
  clone,
  imageUrls,
  rect
}: PreparedGenieTextureCapture): Promise<CapturedGenieTexture | null> {
  await inlineCloneImageResources({ cloneRoot: clone, imageUrls });

  const image = await loadImageFromSvg(createGenieSvgTexture(clone, rect));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * genieSnapshotScale));
  canvas.height = Math.max(1, Math.round(rect.height * genieSnapshotScale));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, rect };
}

async function captureElementTexture(
  element: HTMLElement
): Promise<CapturedGenieTexture | null> {
  const preparedCapture = prepareElementTextureCapture(element);
  return preparedCapture ? renderPreparedElementTexture(preparedCapture) : null;
}

function createDockPreviewDataUrl(canvas: HTMLCanvasElement): string | null {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return null;
  }

  const scale = Math.min(
    1,
    dockPreviewMaxWidth / canvas.width,
    dockPreviewMaxHeight / canvas.height
  );
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(canvas.width * scale));
  output.height = Math.max(1, Math.round(canvas.height * scale));
  const context = output.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(canvas, 0, 0, output.width, output.height);
  return output.toDataURL("image/png");
}

function readDockAnchorFallbackSize(element: HTMLElement): number {
  const cssValue = window
    .getComputedStyle(element)
    .getPropertyValue("--desktop-dock-size");
  const parsed = Number.parseFloat(cssValue);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : dockAnchorFallbackSizePx;
}

function resolveDockAnchorViewportRect(
  element: HTMLElement
): WorkbenchGenieViewportRect {
  const rect = viewportRectFromElement(element);
  if (
    element.dataset.desktopDockSlot !== "true" ||
    element.dataset.nodeState !== "minimized"
  ) {
    return rect;
  }

  const isLayoutAnimating =
    element.dataset.presence === "entering" ||
    element.dataset.collapsing === "true";
  if (!isLayoutAnimating) {
    return rect;
  }

  const fallbackSize = readDockAnchorFallbackSize(element);
  const minimumUsableSize = fallbackSize * 0.5;
  return {
    ...rect,
    height: rect.height >= minimumUsableSize ? rect.height : fallbackSize,
    width: rect.width >= minimumUsableSize ? rect.width : fallbackSize
  };
}

export function writeCachedWorkbenchNodePreviewImage(
  nodeID: string,
  previewImageUrl: string | null | undefined
): void {
  if (previewImageUrl) {
    dockPreviewImageByNodeID.delete(nodeID);
    dockPreviewImageByNodeID.set(nodeID, previewImageUrl);
    while (dockPreviewImageByNodeID.size > dockPreviewImageCacheMaxEntries) {
      const oldestNodeID = dockPreviewImageByNodeID.keys().next().value;
      if (typeof oldestNodeID !== "string") {
        break;
      }
      dockPreviewImageByNodeID.delete(oldestNodeID);
    }
  }
}

export function readCachedWorkbenchNodePreviewImage(
  nodeID: string
): string | null {
  return dockPreviewImageByNodeID.get(nodeID) ?? null;
}

export async function captureWorkbenchNodePreviewImage(
  nodeID: string,
  options: { bypassCache?: boolean } = {}
): Promise<string | null> {
  if (!options.bypassCache) {
    const cachedPreviewImageUrl = readCachedWorkbenchNodePreviewImage(nodeID);
    if (cachedPreviewImageUrl) {
      return cachedPreviewImageUrl;
    }
  }

  const windowElement =
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-workbench-window-id]")
    ).find((candidate) => candidate.dataset.workbenchWindowId === nodeID) ??
    null;
  const captureTarget = windowElement
    ? resolveWorkbenchCaptureElement(windowElement)
    : null;
  if (!captureTarget) {
    return null;
  }

  const texture = await captureElementTexture(captureTarget).catch(() => null);
  const previewImageUrl = texture
    ? createDockPreviewDataUrl(texture.canvas)
    : null;
  writeCachedWorkbenchNodePreviewImage(nodeID, previewImageUrl);
  return previewImageUrl;
}

async function captureWorkbenchNodePreviewImageForNode<TData>(
  node: WorkbenchNode<TData>,
  input: {
    captureNodePreviewImage?: WorkbenchNodePreviewImageCapture<TData>;
    dockPreviewCache?: WorkbenchDockPreviewCache;
    resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<TData>;
  } = {}
): Promise<string | null> {
  const previewImageUrl = await Promise.resolve(
    input.captureNodePreviewImage?.(node) ?? null
  ).catch(() => null);
  if (previewImageUrl) {
    writeCachedWorkbenchNodePreviewImage(node.id, previewImageUrl);
    persistWorkbenchNodePreviewImage(node, previewImageUrl, input);
    return previewImageUrl;
  }
  const capturedPreviewImageUrl = await captureWorkbenchNodePreviewImage(
    node.id
  );
  persistWorkbenchNodePreviewImage(node, capturedPreviewImageUrl, input);
  return capturedPreviewImageUrl;
}

function persistWorkbenchNodePreviewImage<TData>(
  node: WorkbenchNode<TData>,
  previewImageUrl: string | null | undefined,
  input: {
    dockPreviewCache?: WorkbenchDockPreviewCache;
    resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<TData>;
  }
): void {
  if (!previewImageUrl || !input.dockPreviewCache) {
    return;
  }
  const key = input.resolveDockPreviewCacheKey?.(node) ?? null;
  if (!key) {
    return;
  }
  input.dockPreviewCache.write({ key, previewImageUrl });
}

function createGenieSvgTexture(
  element: HTMLElement,
  rect: WorkbenchGenieViewportRect
): string {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svgDocument = document.implementation.createDocument(
    svgNamespace,
    "svg",
    null
  );
  const svg = svgDocument.documentElement;
  svg.setAttribute("xmlns", svgNamespace);
  svg.setAttribute("width", String(rect.width));
  svg.setAttribute("height", String(rect.height));
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  const foreignObject = svgDocument.createElementNS(
    svgNamespace,
    "foreignObject"
  );
  foreignObject.setAttribute("width", "100%");
  foreignObject.setAttribute("height", "100%");
  foreignObject.setAttribute("x", "0");
  foreignObject.setAttribute("y", "0");
  foreignObject.appendChild(svgDocument.importNode(element, true));
  svg.appendChild(foreignObject);

  return new XMLSerializer().serializeToString(svgDocument);
}

export function useWorkbenchGenieAnimation<TData>({
  captureNodePreviewImage,
  controller,
  dockPreviewCache,
  resolveDockAnchorKey,
  resolveDockPreviewCacheKey
}: {
  captureNodePreviewImage?: WorkbenchNodePreviewImageCapture<TData>;
  controller: WorkbenchController<TData>;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  resolveDockAnchorKey?: (node: WorkbenchNode<TData>) => string;
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<TData>;
}): WorkbenchGenieController {
  const dockAnchorElementsRef = useRef(new Map<string, HTMLElement>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const animationGenerationRef = useRef(0);
  const animationCleanupRef = useRef<(() => void) | null>(null);
  const minimizedDockEnterAnimationNodeIdsRef = useRef(new Set<string>());
  const minimizedDockEnterAnimationTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const [isCanvasActive, setIsCanvasActive] = useState(false);
  const [genieHiddenNodeIDs, setGenieHiddenNodeIDs] = useState(
    () => new Set<string>()
  );

  const registerDockAnchor = useCallback(
    (anchorKey: string, element: HTMLElement | null) => {
      if (element) {
        dockAnchorElementsRef.current.set(anchorKey, element);
        return;
      }
      dockAnchorElementsRef.current.delete(anchorKey);
    },
    []
  );

  const resolveDockAnchorRect = useCallback((anchorKey: string) => {
    const element = dockAnchorElementsRef.current.get(anchorKey) ?? null;
    return element ? resolveDockAnchorViewportRect(element) : null;
  }, []);

  const resolveNodeElement = useCallback((nodeID: string) => {
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-workbench-window-id]")
      ).find((candidate) => candidate.dataset.workbenchWindowId === nodeID) ??
      null
    );
  }, []);

  const resolveAnchorKeyForNode = useCallback(
    (node: WorkbenchNode<TData>) => resolveDockAnchorKey?.(node) ?? node.id,
    [resolveDockAnchorKey]
  );

  const releaseMinimizedDockEnterAnimation = useCallback((nodeID: string) => {
    const timer = minimizedDockEnterAnimationTimersRef.current.get(nodeID);
    if (timer) {
      clearTimeout(timer);
      minimizedDockEnterAnimationTimersRef.current.delete(nodeID);
    }
    minimizedDockEnterAnimationNodeIdsRef.current.delete(nodeID);
  }, []);

  const registerMinimizedDockEnterAnimation = useCallback(
    (nodeID: string) => {
      releaseMinimizedDockEnterAnimation(nodeID);
      minimizedDockEnterAnimationNodeIdsRef.current.add(nodeID);
    },
    [releaseMinimizedDockEnterAnimation]
  );

  const scheduleReleaseMinimizedDockEnterAnimation = useCallback(
    (nodeID: string, delayMs = minimizedDockSlotEnterAnimationMs) => {
      const existing = minimizedDockEnterAnimationTimersRef.current.get(nodeID);
      if (existing) {
        clearTimeout(existing);
      }
      minimizedDockEnterAnimationTimersRef.current.set(
        nodeID,
        setTimeout(() => {
          minimizedDockEnterAnimationTimersRef.current.delete(nodeID);
          minimizedDockEnterAnimationNodeIdsRef.current.delete(nodeID);
        }, delayMs)
      );
    },
    []
  );

  const shouldAnimateMinimizedDockEnter = useCallback((nodeID: string) => {
    return minimizedDockEnterAnimationNodeIdsRef.current.has(nodeID);
  }, []);

  const hideNodeForGenie = useCallback((nodeID: string) => {
    setGenieHiddenNodeIDs((current) => {
      if (current.has(nodeID)) {
        return current;
      }
      return new Set([...current, nodeID]);
    });
  }, []);

  const showNodeForGenie = useCallback((nodeID: string) => {
    setGenieHiddenNodeIDs((current) => {
      if (!current.has(nodeID)) {
        return current;
      }
      const next = new Set(current);
      next.delete(nodeID);
      return next;
    });
  }, []);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const devicePixelRatio = Math.min(
      window.devicePixelRatio || 1,
      genieMaxDevicePixelRatio
    );
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    canvas.width = Math.max(1, Math.round(viewportWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(viewportHeight * devicePixelRatio));
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    return { context, viewportHeight, viewportWidth };
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    setIsCanvasActive(false);
  }, []);

  const stopAnimation = useCallback((runCleanup = true) => {
    animationGenerationRef.current += 1;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const cleanup = animationCleanupRef.current;
    animationCleanupRef.current = null;
    if (runCleanup) {
      cleanup?.();
    }
  }, []);

  const runGenieAnimation = useCallback(
    ({
      direction,
      dockRect,
      onComplete,
      onCancel,
      skipStop,
      texture
    }: {
      direction: WorkbenchGenieDirection;
      dockRect: WorkbenchGenieViewportRect;
      onCancel?: () => void;
      onComplete: () => void;
      skipStop?: boolean;
      texture: CapturedGenieTexture;
    }) => {
      if (!skipStop) {
        stopAnimation();
      }
      const setup = setupCanvas();
      if (!setup) {
        onComplete();
        return;
      }

      const generation = animationGenerationRef.current;
      const dockPoint = centerPointFromRect(dockRect);
      let startTime: number | null = null;
      animationCleanupRef.current = onCancel ?? null;
      setIsCanvasActive(true);
      renderGenieScanlines(
        setup.context,
        setup.viewportWidth,
        setup.viewportHeight,
        {
          direction,
          dockPoint,
          progress: 0,
          texture: texture.canvas,
          textureRect: texture.rect
        }
      );

      const drawFrame = (timestamp: number) => {
        if (generation !== animationGenerationRef.current) {
          return;
        }
        startTime ??= timestamp;
        const progress = clampProgress(
          (timestamp - startTime) / genieDurationMs
        );
        const animationProgress = resolveGenieAnimationProgress(
          direction,
          progress
        );
        renderGenieScanlines(
          setup.context,
          setup.viewportWidth,
          setup.viewportHeight,
          {
            direction,
            dockPoint,
            progress: animationProgress,
            texture: texture.canvas,
            textureRect: texture.rect
          }
        );

        if (progress < 1) {
          rafRef.current = window.requestAnimationFrame(drawFrame);
          return;
        }

        rafRef.current = null;
        animationCleanupRef.current = null;
        onComplete();
      };

      rafRef.current = window.requestAnimationFrame(drawFrame);
    },
    [setupCanvas, stopAnimation]
  );

  useEffect(() => () => stopAnimation(false), [stopAnimation]);

  const startOpenOrRestoreAnimation = useCallback(
    async (
      nodeID: string,
      anchorKey: string,
      generation: number,
      dockRectFallback: WorkbenchGenieViewportRect | null
    ) => {
      if (shouldReduceMotion()) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        return;
      }

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      if (generation !== animationGenerationRef.current) {
        return;
      }
      const resolvedDockRect = resolveDockAnchorRect(anchorKey);
      const dockRect =
        resolvedDockRect && isUsableGenieRect(resolvedDockRect)
          ? resolvedDockRect
          : dockRectFallback;
      const nodeElement = resolveNodeElement(nodeID);
      const captureTarget = nodeElement
        ? resolveWorkbenchCaptureElement(nodeElement)
        : null;
      if (
        !dockRect ||
        !nodeElement ||
        !captureTarget ||
        !isUsableGenieRect(dockRect)
      ) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        return;
      }

      const texture = await captureElementTexture(captureTarget).catch(
        () => null
      );
      if (generation !== animationGenerationRef.current) {
        return;
      }
      if (!texture) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        return;
      }

      runGenieAnimation({
        direction: "open",
        dockRect,
        onCancel: () => {
          flushSync(() => {
            showNodeForGenie(nodeID);
          });
          clearCanvas();
        },
        onComplete: () => {
          flushSync(() => {
            showNodeForGenie(nodeID);
          });
          clearCanvas();
        },
        skipStop: true,
        texture
      });
    },
    [
      clearCanvas,
      resolveDockAnchorRect,
      resolveNodeElement,
      runGenieAnimation,
      showNodeForGenie
    ]
  );

  const launchNodeFromAnchor = useCallback(
    (
      anchorKey: string,
      nodeID: string,
      launch: () => Promise<string | null | void> | string | null | void
    ) => {
      const target = controller
        .getSnapshot()
        .nodes.find((node) => node.id === nodeID);
      if (!target) {
        void Promise.resolve(launch()).catch(() => {});
        return;
      }

      if (target.isMinimized !== true) {
        void Promise.resolve(launch()).catch(() => {});
        return;
      }

      stopAnimation();
      const dockRectFallback = resolveDockAnchorRect(anchorKey);
      hideNodeForGenie(nodeID);
      animationCleanupRef.current = () => {
        flushSync(() => {
          showNodeForGenie(nodeID);
        });
        clearCanvas();
      };
      const generation = animationGenerationRef.current;
      flushSync(() => {
        void launch();
      });
      void startOpenOrRestoreAnimation(
        nodeID,
        anchorKey,
        generation,
        dockRectFallback
      );
    },
    [
      clearCanvas,
      controller,
      hideNodeForGenie,
      resolveDockAnchorRect,
      showNodeForGenie,
      startOpenOrRestoreAnimation,
      stopAnimation
    ]
  );

  const minimizeNodeToAnchor = useCallback(
    (nodeID: string, minimize?: () => void) => {
      void (async () => {
        const target = controller
          .getSnapshot()
          .nodes.find((node) => node.id === nodeID);
        if (!target) {
          return;
        }
        const runMinimize =
          minimize ?? (() => controller.commands.minimizeNode(nodeID));
        if (shouldReduceMotion()) {
          await captureWorkbenchNodePreviewImageForNode(target, {
            captureNodePreviewImage,
            dockPreviewCache,
            resolveDockPreviewCacheKey
          });
          runMinimize();
          return;
        }

        stopAnimation();
        const generation = animationGenerationRef.current;
        const nodeElement = resolveNodeElement(nodeID);
        const captureTarget = nodeElement
          ? resolveWorkbenchCaptureElement(nodeElement)
          : null;
        if (!nodeElement || !captureTarget) {
          runMinimize();
          return;
        }

        const preparedTexture = prepareElementTextureCapture(captureTarget);
        if (!preparedTexture) {
          runMinimize();
          return;
        }
        const previewImageUrlPromise = Promise.resolve(
          captureNodePreviewImage?.(target) ?? null
        ).catch(() => null);
        const texture = await renderPreparedElementTexture(
          preparedTexture
        ).catch(() => null);
        const previewImageUrl = await previewImageUrlPromise;
        if (generation !== animationGenerationRef.current) {
          return;
        }
        if (!texture) {
          if (previewImageUrl) {
            writeCachedWorkbenchNodePreviewImage(nodeID, previewImageUrl);
            persistWorkbenchNodePreviewImage(target, previewImageUrl, {
              dockPreviewCache,
              resolveDockPreviewCacheKey
            });
          }
          runMinimize();
          return;
        }
        if (previewImageUrl) {
          writeCachedWorkbenchNodePreviewImage(nodeID, previewImageUrl);
          persistWorkbenchNodePreviewImage(target, previewImageUrl, {
            dockPreviewCache,
            resolveDockPreviewCacheKey
          });
        } else {
          const capturedPreviewImageUrl = createDockPreviewDataUrl(
            texture.canvas
          );
          writeCachedWorkbenchNodePreviewImage(nodeID, capturedPreviewImageUrl);
          persistWorkbenchNodePreviewImage(target, capturedPreviewImageUrl, {
            dockPreviewCache,
            resolveDockPreviewCacheKey
          });
        }

        const cleanupHiddenNode = () => {
          flushSync(() => {
            showNodeForGenie(nodeID);
          });
          clearCanvas();
        };
        animationCleanupRef.current = cleanupHiddenNode;

        registerMinimizedDockEnterAnimation(nodeID);

        flushSync(() => {
          hideNodeForGenie(nodeID);
          runMinimize();
        });

        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        if (generation !== animationGenerationRef.current) {
          releaseMinimizedDockEnterAnimation(nodeID);
          return;
        }

        const minimizedTarget =
          controller.getSnapshot().nodes.find((node) => node.id === nodeID) ??
          target;
        const anchorKey = resolveAnchorKeyForNode(minimizedTarget);
        const dockRect = resolveDockAnchorRect(anchorKey);
        if (!dockRect || !isUsableGenieRect(dockRect)) {
          releaseMinimizedDockEnterAnimation(nodeID);
          animationCleanupRef.current = null;
          cleanupHiddenNode();
          return;
        }

        runGenieAnimation({
          direction: "minimize",
          dockRect,
          onCancel: () => {
            releaseMinimizedDockEnterAnimation(nodeID);
            flushSync(() => {
              showNodeForGenie(nodeID);
            });
            clearCanvas();
          },
          onComplete: () => {
            scheduleReleaseMinimizedDockEnterAnimation(nodeID);
            flushSync(() => {
              showNodeForGenie(nodeID);
            });
            clearCanvas();
          },
          skipStop: true,
          texture
        });
      })();
    },
    [
      clearCanvas,
      controller,
      captureNodePreviewImage,
      dockPreviewCache,
      hideNodeForGenie,
      registerMinimizedDockEnterAnimation,
      releaseMinimizedDockEnterAnimation,
      resolveAnchorKeyForNode,
      resolveDockPreviewCacheKey,
      resolveDockAnchorRect,
      resolveNodeElement,
      runGenieAnimation,
      scheduleReleaseMinimizedDockEnterAnimation,
      setupCanvas,
      showNodeForGenie,
      stopAnimation
    ]
  );

  useEffect(
    () => () => {
      for (const timer of minimizedDockEnterAnimationTimersRef.current.values()) {
        clearTimeout(timer);
      }
      minimizedDockEnterAnimationTimersRef.current.clear();
      minimizedDockEnterAnimationNodeIdsRef.current.clear();
    },
    []
  );

  return {
    genieLayer:
      typeof document === "undefined"
        ? null
        : createPortal(
            <canvas
              ref={canvasRef}
              className="workbench-genie-layer"
              data-workbench-genie-layer-state={
                isCanvasActive ? "active" : "idle"
              }
              aria-hidden
            />,
            document.body
          ),
    isNodeGenieHidden: useCallback(
      (nodeID: string) => genieHiddenNodeIDs.has(nodeID),
      [genieHiddenNodeIDs]
    ),
    launchNodeFromAnchor,
    minimizeNodeToAnchor,
    registerDockAnchor,
    shouldAnimateMinimizedDockEnter
  };
}
