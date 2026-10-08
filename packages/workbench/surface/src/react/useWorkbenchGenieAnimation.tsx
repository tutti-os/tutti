import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal, flushSync } from "react-dom";
import type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "../store/types.ts";
import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchMinimizeAnimation } from "./types.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKeyResolver
} from "./dockPreviewCache.ts";
import {
  centerPointFromRect,
  easeInQuadratic,
  isGenieTextureResolutionSufficient,
  isUsableGenieRect,
  renderGenieScanlines,
  renderGenieWarmupFrames,
  resolveGenieWarmupTextureSize,
  viewportRectFromElement,
  type WorkbenchGenieDirection,
  type WorkbenchGenieMeaningfulImageClone,
  type WorkbenchGenieViewportRect
} from "./genieAnimation.ts";
import {
  inlineGenieCloneMaskImageResources,
  prepareGenieTextureCapture,
  type PreparedGenieTextureCapture
} from "./genieTextureCapture.ts";
import {
  pruneRemovedWorkbenchGenieTextureCacheEntries,
  readWorkbenchGenieTextureCacheEntry,
  writeWorkbenchGenieTextureCacheEntry
} from "./genieTextureCache.ts";
import {
  createWorkbenchGenieNodeVisibilityStore,
  type WorkbenchGenieNodeVisibility,
  type WorkbenchGenieNodeVisibilityToken
} from "./genieNodeVisibility.ts";
import type {
  WorkbenchNodePreviewImageCapture,
  WorkbenchNodePreviewImagesCapture
} from "./nodePreviewCapture.ts";
import type { WorkbenchNodePresentationTransitionStore } from "./nodePresentationTransitions.ts";
import {
  workbenchNodePreviewIdentity,
  workbenchNodePreviewRuntime
} from "../preview/workbenchNodePreviewRuntime.ts";
import {
  resolveNativeFirstGenieTexture,
  scheduleWorkbenchGeniePostAnimationIdleTask,
  scheduleWorkbenchGenieWarmup,
  startCachedWorkbenchGenieRestore
} from "./workbenchGenieScheduling.ts";

const genieDurationMs = 400;
const previewCaptureRaceTimeoutMs = 120;
const scaleMinimizeDurationMs = 220;
const genieMaxDevicePixelRatio = 2;
const genieSnapshotScale = 1;
const renderedGeniePreviewHeaderOffsetPx = 40;
const minimizedDockSlotEnterAnimationMs = 720;
const dockAnchorResolveMaxAnimationFrames = 3;
const dockPreviewMaxWidth = 260;
const dockPreviewMaxHeight = 170;
const minimizedGenieTextureCacheMaxBytes = 64 * 1024 * 1024;
const minimizedGenieTextureCacheMaxEntries = 8;
const inlineImageResourceCacheMaxEntries = 160;
const inlineImageResizeTargetCacheMaxEntries = 4;
const dockAnchorFallbackSizePx = 43.2;
const genieInlineImageMaxDevicePixelRatio = 2;

const inlineImageResourceByUrl = new Map<string, Promise<string | null>>();
const resizedInlineImageResourceByUrl = new Map<
  string,
  Map<string, Promise<string | null>>
>();

interface CapturedGenieTexture {
  canvas: HTMLCanvasElement;
  rect: WorkbenchGenieViewportRect;
}

interface GenieTextureOutputLimits {
  maxHeight: number;
  maxWidth: number;
}

interface PendingRenderedGeniePreviewCapture {
  id: number;
  nodeID: string;
  preview: ReactNode;
  rect: WorkbenchGenieViewportRect;
  usedFallbackPreview: boolean;
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

function waitForNextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function isFocusedWorkbenchNode<TData>(
  controller: WorkbenchController<TData>,
  nodeID: string
): boolean {
  return controller.getSnapshot().nodeStack.at(-1) === nodeID;
}

function isEmptyGeniePreview(preview: ReactNode): boolean {
  return preview === null || preview === undefined || preview === false;
}

function logWorkbenchGenieDiagnostic(
  debugDiagnostics: WorkbenchDebugDiagnostics | undefined,
  event: string,
  details: Record<string, unknown>,
  level: "debug" | "info" | "warn" = "info"
): void {
  if (!debugDiagnostics?.isEnabled() || !debugDiagnostics.log) {
    return;
  }
  void Promise.resolve(
    debugDiagnostics.log({
      details,
      event,
      level,
      source: "workbench-genie"
    })
  ).catch(() => undefined);
}

function describeGenieNode<TData>(
  node: WorkbenchNode<TData> | null | undefined
): Record<string, unknown> {
  if (!node) {
    return {};
  }
  const data =
    node.data && typeof node.data === "object"
      ? (node.data as Record<string, unknown>)
      : {};
  return {
    displayMode: node.displayMode,
    instanceId: typeof data.instanceId === "string" ? data.instanceId : null,
    isMinimized: node.isMinimized,
    minimizedAtUnixMs: node.minimizedAtUnixMs,
    nodeId: node.id,
    title: node.title,
    typeId: typeof data.typeId === "string" ? data.typeId : null
  };
}

export interface WorkbenchGenieController<TData = unknown> {
  genieLayer: ReactNode;
  isPendingMinimizedDockNode: (nodeID: string) => boolean;
  launchNodeFromAnchor: (
    anchorKey: string,
    nodeID: string,
    launch: () => Promise<string | null | void> | string | null | void
  ) => void;
  minimizeNodeToAnchor: (nodeID: string, minimize?: () => void) => void;
  nodeVisibility: WorkbenchGenieNodeVisibility;
  pendingMinimizedNode: WorkbenchNode<TData> | null;
  registerDockAnchor: (anchorKey: string, element: HTMLElement | null) => void;
  shouldAnimateMinimizedDockEnter: (nodeID: string) => boolean;
}

export type WorkbenchNodeGeniePreviewRenderer<TData = unknown> = (
  node: WorkbenchNode<TData>,
  input: { previewViewport: { height: number; width: number } }
) => ReactNode;

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
  images
}: {
  cloneRoot: HTMLElement;
  images: WorkbenchGenieMeaningfulImageClone[];
}): Promise<void> {
  const cloneImages = Array.from(cloneRoot.querySelectorAll("img"));

  await Promise.all([
    inlineGenieCloneMaskImageResources({
      cloneRoot,
      readResource: readInlineImageResource
    }),
    ...images.map(async (imageInfo, index) => {
      const cloneImage = cloneImages[index];
      if (!cloneImage) {
        return;
      }

      cloneImage.removeAttribute("srcset");
      cloneImage.removeAttribute("sizes");
      const imageUrl = imageInfo.url;
      if (!imageUrl) {
        return;
      }
      const inlineImageUrl =
        (await readInlineImageResource(imageUrl)) ?? imageUrl;
      const resizedImageUrl = await readResizedInlineImageResource(
        imageUrl,
        inlineImageUrl,
        imageInfo
      );
      if (resizedImageUrl && resizedImageUrl !== inlineImageUrl) {
        cloneImage.src = resizedImageUrl;
        return;
      }
      cloneImage.src = inlineImageUrl;
    })
  ]);
}

async function loadImageFromSvg(svg: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}

function resolveGenieInlineImageTargetSize({
  displayHeight,
  displayWidth
}: WorkbenchGenieMeaningfulImageClone): {
  height: number;
  width: number;
} | null {
  if (displayWidth <= 0 || displayHeight <= 0) {
    return null;
  }
  const scale = Math.min(
    window.devicePixelRatio || 1,
    genieInlineImageMaxDevicePixelRatio
  );
  return {
    height: Math.max(1, Math.ceil(displayHeight * scale)),
    width: Math.max(1, Math.ceil(displayWidth * scale))
  };
}

async function resizeInlineImageResourceForGenieTexture(
  imageUrl: string,
  targetSize: { height: number; width: number }
): Promise<string | null> {
  const image = new Image();
  image.src = imageUrl;
  try {
    await image.decode();
  } catch {
    return null;
  }
  if (
    image.naturalWidth <= targetSize.width &&
    image.naturalHeight <= targetSize.height
  ) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0, targetSize.width, targetSize.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function readResizedInlineImageResource(
  sourceImageUrl: string,
  inlineImageUrl: string,
  imageInfo: WorkbenchGenieMeaningfulImageClone
): Promise<string | null> {
  const targetSize = resolveGenieInlineImageTargetSize(imageInfo);
  if (!targetSize) {
    return Promise.resolve(null);
  }
  if (
    imageInfo.naturalWidth > 0 &&
    imageInfo.naturalHeight > 0 &&
    imageInfo.naturalWidth <= targetSize.width &&
    imageInfo.naturalHeight <= targetSize.height
  ) {
    return Promise.resolve(null);
  }

  let resizedByTarget = resizedInlineImageResourceByUrl.get(sourceImageUrl);
  if (resizedByTarget) {
    resizedInlineImageResourceByUrl.delete(sourceImageUrl);
    resizedInlineImageResourceByUrl.set(sourceImageUrl, resizedByTarget);
  } else {
    resizedByTarget = new Map();
    resizedInlineImageResourceByUrl.set(sourceImageUrl, resizedByTarget);
  }

  const targetKey = `${targetSize.width}x${targetSize.height}`;
  const cached = resizedByTarget.get(targetKey);
  if (cached) {
    resizedByTarget.delete(targetKey);
    resizedByTarget.set(targetKey, cached);
    return cached;
  }

  const promise = resizeInlineImageResourceForGenieTexture(
    inlineImageUrl,
    targetSize
  );
  resizedByTarget.set(targetKey, promise);
  while (resizedByTarget.size > inlineImageResizeTargetCacheMaxEntries) {
    const oldestTarget = resizedByTarget.keys().next().value;
    if (typeof oldestTarget !== "string") {
      break;
    }
    resizedByTarget.delete(oldestTarget);
  }
  while (
    resizedInlineImageResourceByUrl.size > inlineImageResourceCacheMaxEntries
  ) {
    const oldestImageUrl = resizedInlineImageResourceByUrl.keys().next().value;
    if (typeof oldestImageUrl !== "string") {
      break;
    }
    resizedInlineImageResourceByUrl.delete(oldestImageUrl);
  }
  return promise;
}

function prepareRenderedGeniePreviewCloneForTexture(
  clone: HTMLElement,
  textureRect: WorkbenchGenieViewportRect
): void {
  clone.style.width = `${textureRect.width}px`;
  clone.style.height = `${textureRect.height}px`;

  const previewElement = clone.querySelector<HTMLElement>(
    ".workbench-genie-preview-capture__preview"
  );
  if (!previewElement) {
    return;
  }

  previewElement.style.display = "block";
  previewElement.style.width = `${textureRect.width}px`;
  previewElement.style.height = `${textureRect.height}px`;
  previewElement.style.padding = "0";
  previewElement.style.border = "0";
  previewElement.style.borderRadius = "0";
  previewElement.style.background = "var(--background-panel)";
  previewElement.style.boxShadow = "none";
  previewElement.style.transform = `translateY(${renderedGeniePreviewHeaderOffsetPx}px)`;
}

function resolveGenieTextureOutputSize(
  rect: WorkbenchGenieViewportRect,
  limits?: GenieTextureOutputLimits
): { height: number; width: number } {
  const scale = limits
    ? Math.min(1, limits.maxWidth / rect.width, limits.maxHeight / rect.height)
    : genieSnapshotScale;
  return {
    height: Math.max(1, Math.round(rect.height * scale)),
    width: Math.max(1, Math.round(rect.width * scale))
  };
}

async function renderPreparedElementTexture(
  { clone, images, rect }: PreparedGenieTextureCapture,
  outputLimits?: GenieTextureOutputLimits
): Promise<CapturedGenieTexture | null> {
  await inlineCloneImageResources({
    cloneRoot: clone,
    images
  });

  const outputSize = resolveGenieTextureOutputSize(rect, outputLimits);
  const svgTexture = createGenieSvgTexture(clone, rect, outputSize);
  const image = await loadImageFromSvg(svgTexture);

  const canvas = document.createElement("canvas");
  canvas.width = outputSize.width;
  canvas.height = outputSize.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, rect };
}

async function captureElementTexture(
  element: HTMLElement,
  outputLimits?: GenieTextureOutputLimits
): Promise<CapturedGenieTexture | null> {
  const preparedCapture = prepareGenieTextureCapture(element);
  return preparedCapture
    ? renderPreparedElementTexture(preparedCapture, outputLimits)
    : null;
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
  if (scale === 1) {
    return canvas.toDataURL("image/png");
  }
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

async function renderPreviewImageTexture({
  previewImageUrl,
  rect
}: {
  previewImageUrl: string;
  rect: WorkbenchGenieViewportRect;
}): Promise<CapturedGenieTexture | null> {
  if (!isUsableGenieRect(rect)) {
    return null;
  }

  const image = new Image();
  image.src = previewImageUrl;
  await image.decode();
  if (
    !isGenieTextureResolutionSufficient(
      { height: image.naturalHeight, width: image.naturalWidth },
      rect
    )
  ) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * genieSnapshotScale));
  canvas.height = Math.max(1, Math.round(rect.height * genieSnapshotScale));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, rect };
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
  workbenchNodePreviewRuntime.write({
    identity: workbenchNodePreviewIdentity(nodeID),
    nodeId: nodeID,
    previewImageUrl
  });
}

export function readCachedWorkbenchNodePreviewImage(
  nodeID: string
): string | null {
  return workbenchNodePreviewRuntime.readLatest(nodeID);
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

  const texture = await captureElementTexture(captureTarget, {
    maxHeight: dockPreviewMaxHeight,
    maxWidth: dockPreviewMaxWidth
  }).catch(() => null);
  const previewImageUrl = texture
    ? createDockPreviewDataUrl(texture.canvas)
    : null;
  writeCachedWorkbenchNodePreviewImage(nodeID, previewImageUrl);
  return previewImageUrl;
}

async function captureProvidedWorkbenchNodePreviewImageForNode<TData>(
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
  if (!previewImageUrl) {
    return null;
  }
  writeCachedWorkbenchNodePreviewImage(node.id, previewImageUrl);
  persistWorkbenchNodePreviewImage(node, previewImageUrl, input);
  return previewImageUrl;
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
  rect: WorkbenchGenieViewportRect,
  outputSize: { height: number; width: number } = {
    height: rect.height,
    width: rect.width
  }
): string {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svgDocument = document.implementation.createDocument(
    svgNamespace,
    "svg",
    null
  );
  const svg = svgDocument.documentElement;
  svg.setAttribute("xmlns", svgNamespace);
  svg.setAttribute("width", String(outputSize.width));
  svg.setAttribute("height", String(outputSize.height));
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  const foreignObject = svgDocument.createElementNS(
    svgNamespace,
    "foreignObject"
  );
  foreignObject.setAttribute("width", String(rect.width));
  foreignObject.setAttribute("height", String(rect.height));
  foreignObject.setAttribute("x", "0");
  foreignObject.setAttribute("y", "0");
  foreignObject.appendChild(svgDocument.importNode(element, true));
  svg.appendChild(foreignObject);

  return new XMLSerializer().serializeToString(svgDocument);
}

export function useWorkbenchGenieAnimation<TData>({
  captureNodePreviewImage,
  captureNodePreviewImages,
  controller,
  debugDiagnostics,
  dockPreviewCache,
  minimizeAnimation = "genie",
  nodePresentationTransitions,
  renderNodeGeniePreview,
  resolveDockAnchorKey,
  resolveDockPreviewCacheKey,
  shouldCaptureNodePreviewImage
}: {
  captureNodePreviewImage?: WorkbenchNodePreviewImageCapture<TData>;
  captureNodePreviewImages?: WorkbenchNodePreviewImagesCapture<TData>;
  controller: WorkbenchController<TData>;
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  minimizeAnimation?: WorkbenchMinimizeAnimation;
  nodePresentationTransitions: WorkbenchNodePresentationTransitionStore;
  renderNodeGeniePreview?: WorkbenchNodeGeniePreviewRenderer<TData>;
  resolveDockAnchorKey?: (node: WorkbenchNode<TData>) => string;
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<TData>;
  shouldCaptureNodePreviewImage?: (node: WorkbenchNode<TData>) => boolean;
}): WorkbenchGenieController<TData> {
  const dockAnchorElementsRef = useRef(new Map<string, HTMLElement>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const animationGenerationRef = useRef(0);
  const animationCleanupRef = useRef<(() => void) | null>(null);
  const minimizedDockEnterAnimationNodeIdsRef = useRef(new Set<string>());
  const minimizedDockEnterAnimationTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const minimizedGenieTextureByNodeIDRef = useRef(
    new Map<string, CapturedGenieTexture>()
  );
  const genieCanvasWarmupCompletedRef = useRef(false);
  const renderedPreviewCaptureIDRef = useRef(0);
  const renderedPreviewCaptureElementRef = useRef<HTMLDivElement | null>(null);
  const pendingRenderedPreviewCaptureRef =
    useRef<PendingRenderedGeniePreviewCapture | null>(null);
  const nodeVisibilityStoreRef = useRef<ReturnType<
    typeof createWorkbenchGenieNodeVisibilityStore
  > | null>(null);
  nodeVisibilityStoreRef.current ??= createWorkbenchGenieNodeVisibilityStore();
  const nodeVisibility = nodeVisibilityStoreRef.current;
  const [isCanvasActive, setIsCanvasActive] = useState(false);
  const [pendingMinimizedNode, setPendingMinimizedNode] =
    useState<WorkbenchNode<TData> | null>(null);
  const [pendingRenderedPreviewCapture, setPendingRenderedPreviewCapture] =
    useState<PendingRenderedGeniePreviewCapture | null>(null);

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
    if (!element) {
      return null;
    }
    return resolveDockAnchorViewportRect(element);
  }, []);

  const resolveDockAnchorRectAfterRender = useCallback(
    async (anchorKey: string, isCurrent: () => boolean) => {
      let dockRect = resolveDockAnchorRect(anchorKey);
      for (
        let frame = 0;
        (!dockRect || !isUsableGenieRect(dockRect)) &&
        frame < dockAnchorResolveMaxAnimationFrames;
        frame += 1
      ) {
        await waitForNextAnimationFrame();
        if (!isCurrent()) {
          return null;
        }
        dockRect = resolveDockAnchorRect(anchorKey);
      }
      return dockRect;
    },
    [resolveDockAnchorRect]
  );

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

  const readMinimizedGenieTexture = useCallback((nodeID: string) => {
    return readWorkbenchGenieTextureCacheEntry(
      minimizedGenieTextureByNodeIDRef.current,
      nodeID
    );
  }, []);

  const writeMinimizedGenieTexture = useCallback(
    (nodeID: string, texture: CapturedGenieTexture) => {
      writeWorkbenchGenieTextureCacheEntry(
        minimizedGenieTextureByNodeIDRef.current,
        nodeID,
        texture,
        {
          maxBytes: minimizedGenieTextureCacheMaxBytes,
          maxEntries: minimizedGenieTextureCacheMaxEntries
        }
      );
    },
    []
  );

  const clearMinimizedGenieTexture = useCallback((nodeID: string) => {
    minimizedGenieTextureByNodeIDRef.current.delete(nodeID);
  }, []);

  const pruneRemovedNodeGenieTextures = useCallback(() => {
    const existingNodeIDs = new Set(
      controller.getSnapshot().nodes.map((node) => node.id)
    );
    pruneRemovedWorkbenchGenieTextureCacheEntries(
      minimizedGenieTextureByNodeIDRef.current,
      existingNodeIDs
    );
  }, [controller]);

  const hideNodeForGenie = useCallback(
    (nodeID: string) => {
      return nodeVisibility.hide(nodeID);
    },
    [nodeVisibility]
  );

  const showNodeForGenie = useCallback(
    (nodeID: string, token?: WorkbenchGenieNodeVisibilityToken) => {
      return nodeVisibility.show(nodeID, token);
    },
    [nodeVisibility]
  );

  const clearPendingMinimizedNode = useCallback((nodeID: string) => {
    setPendingMinimizedNode((current) =>
      current?.id === nodeID ? null : current
    );
  }, []);

  const clearRenderedPreviewCapture = useCallback((id: number) => {
    if (pendingRenderedPreviewCaptureRef.current?.id !== id) {
      return;
    }
    pendingRenderedPreviewCaptureRef.current = null;
    renderedPreviewCaptureElementRef.current = null;
    setPendingRenderedPreviewCapture(null);
  }, []);

  const requestRenderedGeniePreviewTexture = useCallback(
    async ({
      node,
      textureRect
    }: {
      node: WorkbenchNode<TData>;
      textureRect: WorkbenchGenieViewportRect;
    }): Promise<CapturedGenieTexture | null> => {
      if (!isUsableGenieRect(textureRect)) {
        return null;
      }

      const previewViewport = {
        height: textureRect.height,
        width: textureRect.width
      };
      let preview: ReactNode = null;
      try {
        preview =
          renderNodeGeniePreview?.(node, {
            previewViewport
          }) ?? null;
      } catch {
        preview = null;
      }
      if (isEmptyGeniePreview(preview)) {
        return null;
      }
      const captureID = renderedPreviewCaptureIDRef.current + 1;
      renderedPreviewCaptureIDRef.current = captureID;
      const pendingCapture: PendingRenderedGeniePreviewCapture = {
        id: captureID,
        nodeID: node.id,
        preview,
        rect: textureRect,
        usedFallbackPreview: false
      };

      pendingRenderedPreviewCaptureRef.current = pendingCapture;
      flushSync(() => {
        setPendingRenderedPreviewCapture(pendingCapture);
      });

      try {
        await waitForNextAnimationFrame();
        await waitForNextAnimationFrame();

        if (pendingRenderedPreviewCaptureRef.current?.id !== captureID) {
          return null;
        }

        const element = renderedPreviewCaptureElementRef.current;
        if (!element) {
          return null;
        }

        const preparedCapture = prepareGenieTextureCapture(element);
        if (!preparedCapture) {
          return null;
        }

        prepareRenderedGeniePreviewCloneForTexture(
          preparedCapture.clone,
          textureRect
        );
        const texture = await renderPreparedElementTexture({
          ...preparedCapture,
          rect: textureRect
        });
        return texture;
      } catch {
        return null;
      } finally {
        clearRenderedPreviewCapture(captureID);
      }
    },
    [clearRenderedPreviewCapture, renderNodeGeniePreview]
  );

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
    const pixelWidth = Math.max(
      1,
      Math.round(viewportWidth * devicePixelRatio)
    );
    const pixelHeight = Math.max(
      1,
      Math.round(viewportHeight * devicePixelRatio)
    );
    if (canvas.width !== pixelWidth) {
      canvas.width = pixelWidth;
    }
    if (canvas.height !== pixelHeight) {
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    return { context, viewportHeight, viewportWidth };
  }, []);

  useEffect(() => {
    if (
      minimizeAnimation !== "genie" ||
      shouldReduceMotion() ||
      typeof window.requestIdleCallback !== "function"
    ) {
      return;
    }

    return scheduleWorkbenchGenieWarmup({
      isAnimationActive: () => rafRef.current !== null,
      isWarmupComplete: () =>
        !isMountedRef.current || genieCanvasWarmupCompletedRef.current,
      renderWarmup: function warmGenieCanvas() {
        const setup = setupCanvas();
        if (!setup) {
          return;
        }
        const warmupSize = resolveGenieWarmupTextureSize(
          setup.viewportWidth,
          setup.viewportHeight
        );
        const warmupTexture = document.createElement("canvas");
        warmupTexture.width = warmupSize.width;
        warmupTexture.height = warmupSize.height;
        const warmupContext = warmupTexture.getContext("2d");
        warmupContext?.fillRect(
          0,
          0,
          warmupTexture.width,
          warmupTexture.height
        );
        renderGenieWarmupFrames(
          setup.context,
          setup.viewportWidth,
          setup.viewportHeight,
          warmupTexture
        );
        genieCanvasWarmupCompletedRef.current = true;
      },
      scheduler: {
        cancelIdleCallback: (idleID) => {
          window.cancelIdleCallback(idleID);
        },
        requestIdleCallback: (callback) => window.requestIdleCallback(callback)
      }
    });
  }, [minimizeAnimation, setupCanvas]);

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

  const runScaleWindowAnimation = useCallback(
    ({
      direction,
      dockRect,
      nodeElement,
      onCancel,
      onComplete,
      skipStop
    }: {
      direction: WorkbenchGenieDirection;
      dockRect: WorkbenchGenieViewportRect;
      nodeElement: HTMLElement;
      onCancel: () => void;
      onComplete: () => void;
      skipStop?: boolean;
    }) => {
      if (!skipStop) {
        stopAnimation();
      }
      const windowRect = viewportRectFromElement(nodeElement);
      if (!isUsableGenieRect(windowRect) || !isUsableGenieRect(dockRect)) {
        onComplete();
        return;
      }

      const generation = animationGenerationRef.current;
      const fromCenter = centerPointFromRect(windowRect);
      const toCenter = centerPointFromRect(dockRect);
      const targetScale = Math.max(
        0.04,
        Math.min(
          0.32,
          dockRect.width / Math.max(1, windowRect.width),
          dockRect.height / Math.max(1, windowRect.height)
        )
      );
      const previousPointerEvents = nodeElement.style.pointerEvents;
      const previousTransformOrigin = nodeElement.style.transformOrigin;
      const previousVisibility = nodeElement.style.visibility;
      const previousZIndex = nodeElement.style.zIndex;
      nodeElement.style.pointerEvents = "none";
      nodeElement.style.transformOrigin = "center center";
      nodeElement.style.visibility = "visible";
      nodeElement.style.zIndex = "var(--z-workbench-genie)";

      const dockTransform = `translate3d(${toCenter.x - fromCenter.x}px, ${
        toCenter.y - fromCenter.y
      }px, 0) scale(${targetScale})`;
      const windowTransform = "translate3d(0, 0, 0) scale(1)";
      const keyframes =
        direction === "open"
          ? [
              {
                opacity: 0,
                transform: dockTransform
              },
              {
                opacity: 1,
                transform: windowTransform
              }
            ]
          : [
              {
                opacity: 1,
                transform: windowTransform
              },
              {
                opacity: 0,
                transform: dockTransform
              }
            ];
      const animation = nodeElement.animate(keyframes, {
        duration: scaleMinimizeDurationMs,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards"
      });

      const restoreElement = () => {
        animation.cancel();
        nodeElement.style.pointerEvents = previousPointerEvents;
        nodeElement.style.transformOrigin = previousTransformOrigin;
        nodeElement.style.visibility = previousVisibility;
        nodeElement.style.zIndex = previousZIndex;
      };

      animationCleanupRef.current = () => {
        restoreElement();
        onCancel();
      };
      animation.finished
        .then(() => {
          if (generation !== animationGenerationRef.current) {
            return;
          }
          animationCleanupRef.current = null;
          restoreElement();
          onComplete();
        })
        .catch(() => {
          if (generation !== animationGenerationRef.current) {
            return;
          }
          animationCleanupRef.current = null;
          restoreElement();
          onComplete();
        });
    },
    [stopAnimation]
  );

  useEffect(() => () => stopAnimation(false), [stopAnimation]);

  const startOpenOrRestoreAnimation = useCallback(
    async (
      nodeID: string,
      anchorKey: string,
      generation: number,
      dockRectFallback: WorkbenchGenieViewportRect | null,
      minimizedNode: WorkbenchNode<TData> | null
    ) => {
      const effectiveMinimizeAnimation = shouldReduceMotion()
        ? "off"
        : minimizeAnimation;
      if (effectiveMinimizeAnimation === "off") {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        clearMinimizedGenieTexture(nodeID);
        return;
      }

      await waitForNextAnimationFrame();
      if (generation !== animationGenerationRef.current) {
        return;
      }
      const resolvedDockRect = resolveDockAnchorRect(anchorKey);
      const dockRect =
        resolvedDockRect && isUsableGenieRect(resolvedDockRect)
          ? resolvedDockRect
          : dockRectFallback;
      const nodeElement = resolveNodeElement(nodeID);
      if (effectiveMinimizeAnimation === "scale") {
        if (!dockRect || !nodeElement || !isUsableGenieRect(dockRect)) {
          animationCleanupRef.current = null;
          showNodeForGenie(nodeID);
          clearMinimizedGenieTexture(nodeID);
          return;
        }
        flushSync(() => {
          nodePresentationTransitions.setActive(nodeID, "scale-restore", true);
          showNodeForGenie(nodeID);
        });
        runScaleWindowAnimation({
          direction: "open",
          dockRect,
          nodeElement,
          onCancel: () => {
            flushSync(() => {
              showNodeForGenie(nodeID);
              nodePresentationTransitions.setActive(
                nodeID,
                "scale-restore",
                false
              );
            });
            clearMinimizedGenieTexture(nodeID);
          },
          onComplete: () => {
            flushSync(() => {
              showNodeForGenie(nodeID);
              nodePresentationTransitions.setActive(
                nodeID,
                "scale-restore",
                false
              );
            });
            clearMinimizedGenieTexture(nodeID);
          }
        });
        return;
      }

      if (!dockRect || !isUsableGenieRect(dockRect)) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        clearMinimizedGenieTexture(nodeID);
        return;
      }

      const cachedTexture = readMinimizedGenieTexture(nodeID);
      const restoredWindowRect = nodeElement
        ? viewportRectFromElement(nodeElement)
        : null;
      const shouldRestoreFromRenderedPreview =
        minimizedNode !== null &&
        (shouldCaptureNodePreviewImage?.(minimizedNode) ?? true) === false;
      const renderedPreviewTexture =
        cachedTexture ||
        !shouldRestoreFromRenderedPreview ||
        !restoredWindowRect ||
        !isUsableGenieRect(restoredWindowRect)
          ? null
          : await requestRenderedGeniePreviewTexture({
              node: minimizedNode,
              textureRect: restoredWindowRect
            }).catch(() => null);
      if (generation !== animationGenerationRef.current) {
        return;
      }
      const captureTarget =
        cachedTexture || renderedPreviewTexture || !nodeElement
          ? null
          : resolveWorkbenchCaptureElement(nodeElement);
      if (!cachedTexture && !renderedPreviewTexture && !captureTarget) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        clearMinimizedGenieTexture(nodeID);
        return;
      }

      const texture =
        cachedTexture ??
        renderedPreviewTexture ??
        (captureTarget
          ? await captureElementTexture(captureTarget).catch(() => null)
          : null);
      if (generation !== animationGenerationRef.current) {
        return;
      }
      if (!texture) {
        animationCleanupRef.current = null;
        showNodeForGenie(nodeID);
        clearMinimizedGenieTexture(nodeID);
        return;
      }

      runGenieAnimation({
        direction: "open",
        dockRect,
        onCancel: () => {
          flushSync(() => {
            showNodeForGenie(nodeID);
          });
          clearMinimizedGenieTexture(nodeID);
          clearCanvas();
        },
        onComplete: () => {
          flushSync(() => {
            showNodeForGenie(nodeID);
          });
          clearMinimizedGenieTexture(nodeID);
          clearCanvas();
        },
        skipStop: true,
        texture
      });
    },
    [
      clearCanvas,
      clearMinimizedGenieTexture,
      minimizeAnimation,
      nodePresentationTransitions,
      readMinimizedGenieTexture,
      requestRenderedGeniePreviewTexture,
      resolveDockAnchorRect,
      resolveNodeElement,
      runGenieAnimation,
      runScaleWindowAnimation,
      shouldCaptureNodePreviewImage,
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

      const effectiveMinimizeAnimation = shouldReduceMotion()
        ? "off"
        : minimizeAnimation;
      if (effectiveMinimizeAnimation === "off") {
        stopAnimation();
        flushSync(() => {
          showNodeForGenie(nodeID);
        });
        void Promise.resolve(launch()).catch(() => {});
        return;
      }

      stopAnimation();
      const dockRectFallback = resolveDockAnchorRect(anchorKey);
      let visibilityToken: WorkbenchGenieNodeVisibilityToken | null = null;
      flushSync(() => {
        visibilityToken = hideNodeForGenie(nodeID);
      });
      let launchPromise: Promise<string | null | void> | null = null;
      const launchOnce = (): Promise<string | null | void> => {
        if (!isMountedRef.current) {
          return Promise.resolve(null);
        }
        launchPromise ??= Promise.resolve(launch()).catch(() => null);
        return launchPromise;
      };
      const cachedTexture = readMinimizedGenieTexture(nodeID);
      if (
        effectiveMinimizeAnimation === "genie" &&
        cachedTexture &&
        dockRectFallback &&
        isUsableGenieRect(dockRectFallback)
      ) {
        const generation = animationGenerationRef.current;
        const revealLaunchedNode = () => {
          const settledVisibilityToken = visibilityToken;
          if (!isMountedRef.current || !settledVisibilityToken) {
            return;
          }
          flushSync(() => {
            showNodeForGenie(nodeID, settledVisibilityToken);
          });
          if (generation === animationGenerationRef.current) {
            clearCanvas();
          }
        };
        startCachedWorkbenchGenieRestore({
          launch: launchOnce,
          onLaunchSettled: revealLaunchedNode,
          scheduleTask: (callback) => {
            window.setTimeout(callback, 0);
          },
          startAnimation: (onAnimationSettled) => {
            runGenieAnimation({
              direction: "open",
              dockRect: dockRectFallback,
              onCancel: onAnimationSettled,
              onComplete: onAnimationSettled,
              skipStop: true,
              texture: cachedTexture
            });
          }
        });
        return;
      }
      animationCleanupRef.current = () => {
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        flushSync(() => {
          showNodeForGenie(nodeID);
        });
        clearMinimizedGenieTexture(nodeID);
        clearCanvas();
      };
      const generation = animationGenerationRef.current;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        if (generation !== animationGenerationRef.current) {
          return;
        }
        void launchOnce().then(() => {
          if (generation !== animationGenerationRef.current) {
            return;
          }
          void startOpenOrRestoreAnimation(
            nodeID,
            anchorKey,
            generation,
            dockRectFallback,
            target
          );
        });
      });
    },
    [
      clearCanvas,
      clearMinimizedGenieTexture,
      controller,
      hideNodeForGenie,
      minimizeAnimation,
      readMinimizedGenieTexture,
      resolveDockAnchorRect,
      runGenieAnimation,
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
          pruneRemovedNodeGenieTextures();
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.minimize.skipped",
            {
              nodeId: nodeID,
              reason: "target_missing"
            },
            "warn"
          );
          return;
        }
        pruneRemovedNodeGenieTextures();
        const runMinimize =
          minimize ?? (() => controller.commands.minimizeNode(nodeID));
        const effectiveMinimizeAnimation = shouldReduceMotion()
          ? "off"
          : minimizeAnimation;
        if (effectiveMinimizeAnimation !== "genie") {
          clearMinimizedGenieTexture(nodeID);
        }
        const shouldCapturePreview =
          shouldCaptureNodePreviewImage?.(target) ?? true;
        if (effectiveMinimizeAnimation === "off") {
          stopAnimation();
          let frameID: number | null = null;
          let timerID: ReturnType<typeof setTimeout> | null = null;
          let minimizeCommitted = false;
          const commitMinimize = () => {
            if (minimizeCommitted) {
              return;
            }
            minimizeCommitted = true;
            if (frameID !== null) {
              window.cancelAnimationFrame(frameID);
              frameID = null;
            }
            if (timerID !== null) {
              clearTimeout(timerID);
              timerID = null;
            }
            animationCleanupRef.current = null;
            flushSync(() => {
              clearPendingMinimizedNode(nodeID);
              showNodeForGenie(nodeID);
              runMinimize();
            });
            scheduleReleaseMinimizedDockEnterAnimation(nodeID);
          };
          animationCleanupRef.current = () => {
            releaseMinimizedDockEnterAnimation(nodeID);
            commitMinimize();
          };
          registerMinimizedDockEnterAnimation(nodeID);
          flushSync(() => {
            hideNodeForGenie(nodeID);
            setPendingMinimizedNode({
              ...target,
              isMinimized: true,
              minimizedAtUnixMs: Date.now()
            });
          });
          if (shouldCapturePreview) {
            void captureProvidedWorkbenchNodePreviewImageForNode(target, {
              captureNodePreviewImage,
              dockPreviewCache,
              resolveDockPreviewCacheKey
            });
          }
          frameID = window.requestAnimationFrame(() => {
            frameID = null;
            timerID = setTimeout(commitMinimize, 0);
          });
          return;
        }

        if (effectiveMinimizeAnimation === "scale") {
          stopAnimation();
          const generation = animationGenerationRef.current;
          const nodeElement = resolveNodeElement(nodeID);
          if (!nodeElement) {
            logWorkbenchGenieDiagnostic(
              debugDiagnostics,
              "workbench.genie.minimize.skipped",
              {
                ...describeGenieNode(target),
                mode: "scale",
                reason: "node_element_missing"
              },
              "warn"
            );
            runMinimize();
            return;
          }
          const wasFocusedForCapture =
            shouldCapturePreview && isFocusedWorkbenchNode(controller, nodeID);
          if (shouldCapturePreview && !wasFocusedForCapture) {
            flushSync(() => {
              controller.commands.focusNode(nodeID);
            });
            await waitForNextAnimationFrame();
            if (generation !== animationGenerationRef.current) {
              return;
            }
          }

          if (shouldCapturePreview) {
            void captureProvidedWorkbenchNodePreviewImageForNode(target, {
              captureNodePreviewImage,
              dockPreviewCache,
              resolveDockPreviewCacheKey
            });
          }

          let minimizeCommitted = false;
          const commitMinimize = () => {
            if (minimizeCommitted) {
              return;
            }
            minimizeCommitted = true;
            runMinimize();
          };
          const cleanupPendingMinimize = () => {
            releaseMinimizedDockEnterAnimation(nodeID);
            flushSync(() => {
              clearPendingMinimizedNode(nodeID);
              commitMinimize();
            });
          };
          const pendingMinimizedNode: WorkbenchNode<TData> = {
            ...target,
            isMinimized: true,
            minimizedAtUnixMs: Date.now()
          };
          registerMinimizedDockEnterAnimation(nodeID);

          flushSync(() => {
            setPendingMinimizedNode(pendingMinimizedNode);
          });
          animationCleanupRef.current = cleanupPendingMinimize;

          await waitForNextAnimationFrame();
          if (generation !== animationGenerationRef.current) {
            return;
          }

          const anchorKey = resolveAnchorKeyForNode(pendingMinimizedNode);
          const dockRect = await resolveDockAnchorRectAfterRender(
            anchorKey,
            () => generation === animationGenerationRef.current
          );
          if (generation !== animationGenerationRef.current) {
            return;
          }
          if (
            !nodeElement.isConnected ||
            !dockRect ||
            !isUsableGenieRect(dockRect)
          ) {
            logWorkbenchGenieDiagnostic(
              debugDiagnostics,
              "workbench.genie.minimize.skipped",
              {
                ...describeGenieNode(target),
                anchorKey,
                dockRect,
                mode: "scale",
                nodeElementConnected: nodeElement.isConnected,
                registeredDockAnchorKeys: Array.from(
                  dockAnchorElementsRef.current.keys()
                ).filter((key) => key.startsWith("minimized:")),
                reason: "dock_rect_unusable"
              },
              "warn"
            );
            cleanupPendingMinimize();
            return;
          }

          runScaleWindowAnimation({
            direction: "minimize",
            dockRect,
            nodeElement,
            onCancel: () => {
              cleanupPendingMinimize();
            },
            onComplete: () => {
              animationCleanupRef.current = null;
              flushSync(() => {
                clearPendingMinimizedNode(nodeID);
                commitMinimize();
              });
              scheduleReleaseMinimizedDockEnterAnimation(nodeID);
            },
            skipStop: true
          });
          return;
        }

        stopAnimation();
        const generation = animationGenerationRef.current;
        const nodeElement = resolveNodeElement(nodeID);
        if (!nodeElement) {
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.minimize.skipped",
            {
              ...describeGenieNode(target),
              mode: "genie",
              reason: "node_element_missing"
            },
            "warn"
          );
          runMinimize();
          return;
        }
        const windowRect = viewportRectFromElement(nodeElement);
        if (!isUsableGenieRect(windowRect)) {
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.minimize.skipped",
            {
              ...describeGenieNode(target),
              mode: "genie",
              reason: "window_rect_unusable",
              windowRect
            },
            "warn"
          );
          runMinimize();
          return;
        }
        const pendingMinimizedNode: WorkbenchNode<TData> = {
          ...target,
          isMinimized: true,
          minimizedAtUnixMs: Date.now()
        };
        const cachedTexture = shouldCapturePreview
          ? readMinimizedGenieTexture(nodeID)
          : null;
        const reusableTexture =
          cachedTexture &&
          isGenieTextureResolutionSufficient(cachedTexture.canvas, windowRect)
            ? { canvas: cachedTexture.canvas, rect: windowRect }
            : null;
        const componentPreviewTexture =
          reusableTexture || shouldCapturePreview
            ? null
            : await requestRenderedGeniePreviewTexture({
                node: pendingMinimizedNode,
                textureRect: windowRect
              }).catch(() => null);
        if (generation !== animationGenerationRef.current) {
          return;
        }
        if (!reusableTexture && !shouldCapturePreview) {
          if (!componentPreviewTexture) {
            logWorkbenchGenieDiagnostic(
              debugDiagnostics,
              "workbench.genie.texture.missing",
              {
                ...describeGenieNode(target),
                mode: "genie",
                reason: "component_preview_texture_missing",
                shouldCapturePreview,
                windowRect
              },
              "warn"
            );
            runMinimize();
            return;
          }
        }

        const wasFocusedForCapture = isFocusedWorkbenchNode(controller, nodeID);
        if (shouldCapturePreview && !wasFocusedForCapture) {
          flushSync(() => {
            controller.commands.focusNode(nodeID);
          });
          await waitForNextAnimationFrame();
          if (generation !== animationGenerationRef.current) {
            return;
          }
        }
        const previewImagesPromise = shouldCapturePreview
          ? captureNodePreviewImages
            ? Promise.resolve(captureNodePreviewImages(target)).catch(
                () => null
              )
            : Promise.resolve(captureNodePreviewImage?.(target) ?? null)
                .then((previewImageUrl) =>
                  previewImageUrl
                    ? {
                        dockPreviewImageUrl: previewImageUrl,
                        genieImageUrl: previewImageUrl
                      }
                    : null
                )
                .catch(() => null)
          : Promise.resolve(null);
        const previewImageUrlPromise = previewImagesPromise.then(
          (images) => images?.genieImageUrl ?? null
        );
        let preparedTexture: PreparedGenieTextureCapture | null = null;
        let previewImageTexture: CapturedGenieTexture | null = null;
        const nativeFirstResult =
          shouldCapturePreview && !reusableTexture
            ? await resolveNativeFirstGenieTexture({
                nativeImageUrlPromise: previewImageUrlPromise,
                renderDomFallback: () => {
                  preparedTexture = prepareGenieTextureCapture(
                    resolveWorkbenchCaptureElement(nodeElement)
                  );
                  return preparedTexture
                    ? renderPreparedElementTexture(preparedTexture)
                    : null;
                },
                renderNativeImage: async (previewImageUrl) => {
                  previewImageTexture = await renderPreviewImageTexture({
                    previewImageUrl,
                    rect: windowRect
                  }).catch(() => null);
                  return previewImageTexture;
                },
                timeoutMs: previewCaptureRaceTimeoutMs
              })
            : null;
        const previewImages =
          nativeFirstResult?.nativeStatus === "resolved"
            ? await previewImagesPromise
            : null;
        const dockPreviewImageUrl = previewImages?.dockPreviewImageUrl ?? null;
        if (reusableTexture || nativeFirstResult?.nativeStatus === "pending") {
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.preview_capture.deferred",
            {
              ...describeGenieNode(target),
              mode: "genie",
              reusedCachedTexture: Boolean(reusableTexture),
              timeoutMs: previewCaptureRaceTimeoutMs
            },
            "debug"
          );
          void previewImagesPromise.then((latePreviewImages) => {
            const latePreviewImageUrl = latePreviewImages?.genieImageUrl;
            const lateDockPreviewImageUrl =
              latePreviewImages?.dockPreviewImageUrl;
            if (generation !== animationGenerationRef.current) {
              return;
            }
            if (lateDockPreviewImageUrl) {
              writeCachedWorkbenchNodePreviewImage(
                nodeID,
                lateDockPreviewImageUrl
              );
              persistWorkbenchNodePreviewImage(
                target,
                lateDockPreviewImageUrl,
                {
                  dockPreviewCache,
                  resolveDockPreviewCacheKey
                }
              );
            }
            if (
              !latePreviewImageUrl ||
              typeof window.requestIdleCallback !== "function"
            ) {
              return;
            }
            scheduleWorkbenchGeniePostAnimationIdleTask({
              isAnimationActive: () => rafRef.current !== null,
              isCancelled: () =>
                !isMountedRef.current ||
                generation !== animationGenerationRef.current,
              runTask: () => {
                void renderPreviewImageTexture({
                  previewImageUrl: latePreviewImageUrl,
                  rect: windowRect
                })
                  .catch(() => null)
                  .then((refreshedTexture) => {
                    if (
                      refreshedTexture &&
                      generation === animationGenerationRef.current
                    ) {
                      writeMinimizedGenieTexture(nodeID, refreshedTexture);
                    }
                  });
              },
              scheduler: {
                cancelIdleCallback: (idleID) => {
                  window.cancelIdleCallback(idleID);
                },
                requestIdleCallback: (callback) =>
                  window.requestIdleCallback(callback)
              }
            });
          });
        }
        const texture =
          reusableTexture ??
          componentPreviewTexture ??
          nativeFirstResult?.texture ??
          null;
        if (generation !== animationGenerationRef.current) {
          return;
        }
        if (!texture) {
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.minimize.skipped",
            {
              ...describeGenieNode(target),
              hasComponentPreviewTexture: Boolean(componentPreviewTexture),
              hasPreparedDomTexture: Boolean(preparedTexture),
              hasPreviewImageTexture: Boolean(previewImageTexture),
              mode: "genie",
              reason: "texture_missing",
              shouldCapturePreview
            },
            "warn"
          );
          if (dockPreviewImageUrl) {
            writeCachedWorkbenchNodePreviewImage(nodeID, dockPreviewImageUrl);
            persistWorkbenchNodePreviewImage(target, dockPreviewImageUrl, {
              dockPreviewCache,
              resolveDockPreviewCacheKey
            });
          }
          runMinimize();
          return;
        }
        if (dockPreviewImageUrl) {
          writeCachedWorkbenchNodePreviewImage(nodeID, dockPreviewImageUrl);
          persistWorkbenchNodePreviewImage(target, dockPreviewImageUrl, {
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
        writeMinimizedGenieTexture(nodeID, texture);
        pruneRemovedNodeGenieTextures();

        let minimizeCommitted = false;
        const commitMinimize = () => {
          if (minimizeCommitted) {
            return;
          }
          minimizeCommitted = true;
          runMinimize();
        };
        const cleanupPendingGenieMinimize = () => {
          releaseMinimizedDockEnterAnimation(nodeID);
          flushSync(() => {
            clearPendingMinimizedNode(nodeID);
            showNodeForGenie(nodeID);
            commitMinimize();
          });
          clearCanvas();
        };
        animationCleanupRef.current = cleanupPendingGenieMinimize;

        registerMinimizedDockEnterAnimation(nodeID);

        flushSync(() => {
          setPendingMinimizedNode(pendingMinimizedNode);
        });

        await waitForNextAnimationFrame();
        if (generation !== animationGenerationRef.current) {
          return;
        }

        const anchorKey = resolveAnchorKeyForNode(pendingMinimizedNode);
        const dockRect = await resolveDockAnchorRectAfterRender(
          anchorKey,
          () => generation === animationGenerationRef.current
        );
        if (generation !== animationGenerationRef.current) {
          return;
        }
        if (!dockRect || !isUsableGenieRect(dockRect)) {
          logWorkbenchGenieDiagnostic(
            debugDiagnostics,
            "workbench.genie.minimize.skipped",
            {
              ...describeGenieNode(target),
              anchorKey,
              dockRect,
              mode: "genie",
              registeredDockAnchorKeys: Array.from(
                dockAnchorElementsRef.current.keys()
              ).filter((key) => key.startsWith("minimized:")),
              reason: "dock_rect_unusable"
            },
            "warn"
          );
          animationCleanupRef.current = null;
          cleanupPendingGenieMinimize();
          return;
        }

        // Hide the node BEFORE starting the genie animation so that if
        // setupCanvas fails inside runGenieAnimation and onComplete fires
        // synchronously, showNodeForGenie in onComplete can properly
        // un-hide the node. Calling hideNodeForGenie after runGenieAnimation
        // would re-hide the node after onComplete already showed it, leaving
        // the node stuck invisible.
        flushSync(() => {
          hideNodeForGenie(nodeID);
        });
        runGenieAnimation({
          direction: "minimize",
          dockRect,
          onCancel: () => {
            cleanupPendingGenieMinimize();
          },
          onComplete: () => {
            window.setTimeout(() => {
              if (!isMountedRef.current) {
                commitMinimize();
                return;
              }
              scheduleReleaseMinimizedDockEnterAnimation(nodeID);
              flushSync(() => {
                clearPendingMinimizedNode(nodeID);
                showNodeForGenie(nodeID);
                commitMinimize();
              });
              clearCanvas();
            }, 0);
          },
          skipStop: true,
          texture
        });
      })();
    },
    [
      clearCanvas,
      clearMinimizedGenieTexture,
      controller,
      captureNodePreviewImage,
      captureNodePreviewImages,
      clearPendingMinimizedNode,
      debugDiagnostics,
      dockPreviewCache,
      hideNodeForGenie,
      minimizeAnimation,
      pruneRemovedNodeGenieTextures,
      readMinimizedGenieTexture,
      registerMinimizedDockEnterAnimation,
      releaseMinimizedDockEnterAnimation,
      requestRenderedGeniePreviewTexture,
      resolveAnchorKeyForNode,
      resolveDockPreviewCacheKey,
      resolveDockAnchorRect,
      resolveNodeElement,
      runGenieAnimation,
      runScaleWindowAnimation,
      scheduleReleaseMinimizedDockEnterAnimation,
      shouldCaptureNodePreviewImage,
      setupCanvas,
      showNodeForGenie,
      stopAnimation,
      writeMinimizedGenieTexture
    ]
  );

  useEffect(() => {
    pruneRemovedNodeGenieTextures();
    return controller.subscribe(() => {
      pruneRemovedNodeGenieTextures();
    });
  }, [controller, pruneRemovedNodeGenieTextures]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const timer of minimizedDockEnterAnimationTimersRef.current.values()) {
        clearTimeout(timer);
      }
      minimizedDockEnterAnimationTimersRef.current.clear();
      minimizedDockEnterAnimationNodeIdsRef.current.clear();
      minimizedGenieTextureByNodeIDRef.current.clear();
      nodeVisibility.dispose();
    };
  }, [nodeVisibility]);

  const minimizeNodeToAnchorRef = useRef(minimizeNodeToAnchor);
  useLayoutEffect(() => {
    minimizeNodeToAnchorRef.current = minimizeNodeToAnchor;
  }, [minimizeNodeToAnchor]);
  const stableMinimizeNodeToAnchor = useCallback(
    (nodeID: string, minimize?: () => void) => {
      minimizeNodeToAnchorRef.current(nodeID, minimize);
    },
    []
  );
  const genieLayer = useMemo(
    () =>
      typeof document === "undefined"
        ? null
        : createPortal(
            <>
              <canvas
                ref={canvasRef}
                className="workbench-genie-layer"
                data-workbench-genie-layer-state={
                  isCanvasActive ? "active" : "idle"
                }
                aria-hidden
              />
              {pendingRenderedPreviewCapture ? (
                <div
                  ref={renderedPreviewCaptureElementRef}
                  className="workbench-genie-preview-capture"
                  data-workbench-genie-preview-capture-id={
                    pendingRenderedPreviewCapture.id
                  }
                  data-workbench-genie-preview-node-id={
                    pendingRenderedPreviewCapture.nodeID
                  }
                  data-workbench-genie-preview-used-fallback={
                    pendingRenderedPreviewCapture.usedFallbackPreview
                      ? "true"
                      : "false"
                  }
                  style={{
                    height: pendingRenderedPreviewCapture.rect.height,
                    width: pendingRenderedPreviewCapture.rect.width
                  }}
                  aria-hidden
                >
                  {pendingRenderedPreviewCapture.preview}
                </div>
              ) : null}
            </>,
            document.body
          ),
    [isCanvasActive, pendingRenderedPreviewCapture]
  );
  const isPendingMinimizedDockNode = useCallback(
    (nodeID: string) => pendingMinimizedNode?.id === nodeID,
    [pendingMinimizedNode]
  );

  return useMemo(
    () => ({
      genieLayer,
      isPendingMinimizedDockNode,
      launchNodeFromAnchor,
      minimizeNodeToAnchor: stableMinimizeNodeToAnchor,
      nodeVisibility,
      pendingMinimizedNode,
      registerDockAnchor,
      shouldAnimateMinimizedDockEnter
    }),
    [
      genieLayer,
      isPendingMinimizedDockNode,
      launchNodeFromAnchor,
      nodeVisibility,
      pendingMinimizedNode,
      registerDockAnchor,
      shouldAnimateMinimizedDockEnter,
      stableMinimizeNodeToAnchor
    ]
  );
}
