import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  Button,
  CheckIcon,
  CloseIcon,
  FileCreateIcon,
  MaximizeIcon,
  MinimizeIcon,
  OverviewLayoutIcon,
  PinFilledIcon,
  PinIcon,
  cn
} from "@tutti-os/ui-system";
import type { WorkbenchNode } from "../core/types.ts";
import {
  captureWorkbenchNodePreviewImage,
  writeCachedWorkbenchNodePreviewImage
} from "../react/useWorkbenchGenieAnimation.tsx";
import type {
  WorkbenchDockPreviewContent,
  WorkbenchHostDockPopupCardLabelMode,
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostProps
} from "./types.ts";
import type { WorkbenchDockPlacement } from "../react/types.ts";
import {
  resolveInitialMinimizedStackScrollOffset,
  resolveMinimizedStackLeftGutterPx,
  resolveMinimizedStackPanelWidthPx,
  resolveMinimizedStackPopupLeftPx,
  resolveMinimizedStackPopupTopPx,
  resolveMinimizedStackTrackHeightPx,
  resolveMinimizedStackTrackTranslateXPx,
  resolveMinimizedStackViewportHeightPx
} from "./minimizedStackScroll.ts";
import { resolveDockPopupVerticalClampOffsetPx } from "./dockPopupViewportClamp.ts";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey,
  WorkbenchDockPreviewCacheKeyResolver
} from "../react/dockPreviewCache.ts";

const dockPopupCardWidthPx = 165;
const dockPopupGridGapPx = 8;
const dockPopupPanelPaddingInlinePx = 12;
const dockPopupPanelBorderInlinePx = 2;
const dockPopupPlacementGapPx = 14;
const dockPopupMinimizedStackLaunchDisappearMs = 0;
const dockPopupMinimizedStackPopupZIndex = 100300;
const dockPopupPreviewCacheMaxEntries = 64;
const dockPopupPreviewByMemoryKey = new Map<
  string,
  WorkbenchHostDockPopupCapturedPreview
>();
const pendingDockPopupPreviewMemoryKeys = new Set<string>();

type WorkbenchHostDockPopupCapturedPreview = {
  preview: WorkbenchDockPreviewContent | null;
  revision: string | null;
};

type WorkbenchHostDockPopupPreviewState =
  | {
      preview: WorkbenchDockPreviewContent;
      status: "ready";
    }
  | {
      status: "loading" | "fallback";
    };

export interface WorkbenchHostDockPopupAnchorRect {
  dockRight?: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface WorkbenchHostDockPopupState {
  anchorRect: WorkbenchHostDockPopupAnchorRect;
  entryId: string;
  kind: "context-menu" | "preview";
}

export interface WorkbenchHostDockPopupItem {
  externalNodeState?: unknown;
  externalWorkspaceState?: unknown;
  host: WorkbenchHostHandle;
  isFocused: boolean;
  isMinimized: boolean;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  preview: WorkbenchDockPreviewContent | null;
  previewRevision: string | null;
  subtitle: string | null;
  title: string | null;
}

export type WorkbenchHostDockPopupVariant =
  | "context-menu"
  | "default"
  | "minimized-stack";

export interface WorkbenchHostDockPopupRetentionAction {
  checked: boolean;
  disabled?: boolean;
  label: string;
  pendingLabel?: string;
}

interface WorkbenchHostDockPopupCardStyle extends CSSProperties {
  "--desktop-dock-popup-card-lift"?: string;
  "--desktop-dock-popup-card-scale"?: string;
  "--desktop-dock-popup-card-z-index"?: string;
  "--desktop-dock-popup-fan-delay"?: string;
  "--desktop-dock-popup-fan-rotate"?: string;
  "--desktop-dock-popup-fan-x"?: string;
  "--desktop-dock-popup-fan-y"?: string;
}

interface WorkbenchHostDockPopupRootStyle extends CSSProperties {
  "--desktop-dock-minimized-stack-width"?: string;
  "--desktop-dock-popup-clamp-offset"?: string;
  "--desktop-dock-popup-columns": string;
  "--desktop-dock-popup-width": string;
}

const popupCardMagnificationRange = 160;
const popupCardMaxScale = 1.16;
const popupCardMaxLiftPx = 10;

function resolvePopupCardMagnificationStyle(
  pointer: { x: number; y: number } | null,
  element: HTMLElement | null
): WorkbenchHostDockPopupCardStyle | undefined {
  if (!pointer || !element) {
    return undefined;
  }

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distance = Math.hypot(pointer.x - centerX, pointer.y - centerY);
  const influence = Math.max(0, 1 - distance / popupCardMagnificationRange);
  if (influence <= 0) {
    return undefined;
  }

  const eased = influence * influence * (3 - 2 * influence);
  const scale = 1 + (popupCardMaxScale - 1) * eased;
  const lift = -popupCardMaxLiftPx * eased;
  return {
    "--desktop-dock-popup-card-lift": `${Math.round(lift * 10) / 10}px`,
    "--desktop-dock-popup-card-scale": `${Math.round(scale * 1000) / 1000}`,
    "--desktop-dock-popup-card-z-index": `${Math.round(1 + influence * 20)}`
  };
}

function resolvePopupFanCardStyle(
  index: number,
  count: number,
  placement: WorkbenchDockPlacement
): WorkbenchHostDockPopupCardStyle {
  const safeCount = Math.max(1, count);
  const cappedIndex = Math.min(index, safeCount - 1);
  const arcDirection = placement === "left" ? -1 : 1;
  const arcX = cappedIndex * 6 * arcDirection;
  const arcY = -18 - cappedIndex * 78;
  const rotateDeg = (-2 + cappedIndex * 0.8) * arcDirection;

  return {
    "--desktop-dock-popup-fan-delay": `${index * 22}ms`,
    "--desktop-dock-popup-fan-rotate": `${Math.round(rotateDeg * 10) / 10}deg`,
    "--desktop-dock-popup-fan-x": `${Math.round(arcX)}px`,
    "--desktop-dock-popup-fan-y": `${Math.round(arcY)}px`
  };
}

function readDockPopupPreviewImage(
  memoryKey: string
): WorkbenchHostDockPopupCapturedPreview | undefined {
  return dockPopupPreviewByMemoryKey.get(memoryKey);
}

function writeDockPopupPreviewImage(
  memoryKey: string,
  preview: WorkbenchDockPreviewContent | null,
  revision: string | null
): void {
  dockPopupPreviewByMemoryKey.delete(memoryKey);
  dockPopupPreviewByMemoryKey.set(memoryKey, { preview, revision });
  while (dockPopupPreviewByMemoryKey.size > dockPopupPreviewCacheMaxEntries) {
    const oldestMemoryKey = dockPopupPreviewByMemoryKey.keys().next().value;
    if (typeof oldestMemoryKey !== "string") {
      break;
    }
    dockPopupPreviewByMemoryKey.delete(oldestMemoryKey);
  }
}

export function WorkbenchHostDockPopup({
  anchorRect,
  canEnterFullscreen,
  canShowAllWindows,
  capturePreview,
  debugDiagnostics,
  dockRetention,
  dockPreviewCache,
  fullscreenLabel,
  hideLabel,
  items,
  label,
  labelMode,
  newWindowLabel,
  closeWindowLabel,
  onClose,
  onCloseNode,
  onCreateNew,
  onEnterFullscreen,
  onHide,
  onRunDockRetentionAction,
  onSelectNode,
  onShowAllWindows,
  onQuit,
  placement = "bottom",
  quitLabel,
  resolveDockPreviewCacheKey,
  showAllWindowsLabel,
  showCreateNew,
  showOpen,
  variant
}: {
  anchorRect: WorkbenchHostDockPopupState["anchorRect"];
  canEnterFullscreen?: boolean;
  canShowAllWindows?: boolean;
  capturePreview?: (
    item: WorkbenchHostDockPopupItem
  ) =>
    | Promise<WorkbenchDockPreviewContent | string | null>
    | WorkbenchDockPreviewContent
    | string
    | null;
  debugDiagnostics?: WorkbenchHostProps["debugDiagnostics"];
  dockRetention?: WorkbenchHostDockPopupRetentionAction | null;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  fullscreenLabel?: string;
  hideLabel?: string;
  items: WorkbenchHostDockPopupItem[];
  label: string;
  labelMode?: WorkbenchHostDockPopupCardLabelMode;
  newWindowLabel: string;
  closeWindowLabel: (title: string) => string;
  onClose: () => void;
  onCloseNode: (nodeId: string) => void;
  onCreateNew: () => void;
  onEnterFullscreen?: () => void;
  onHide?: () => void;
  onRunDockRetentionAction?: () => void;
  onSelectNode: (nodeId: string) => void;
  onShowAllWindows?: () => void;
  onQuit?: () => void;
  placement?: WorkbenchDockPlacement;
  quitLabel?: string;
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<WorkbenchHostNodeData>;
  showAllWindowsLabel?: string;
  showCreateNew?: boolean;
  showOpen?: boolean;
  variant?: WorkbenchHostDockPopupVariant;
}) {
  const resolvedLabelMode = labelMode ?? "hover-overlay";
  const resolvedVariant = variant ?? "default";
  const isMinimizedStack = resolvedVariant === "minimized-stack";
  const isContextMenu = resolvedVariant === "context-menu";
  const createCardCount = showCreateNew === false ? 0 : 1;
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const cardRefCallbacksRef = useRef(
    new Map<string, (element: HTMLElement | null) => void>()
  );
  const popupRootRef = useRef<HTMLDivElement | null>(null);
  const minimizedStackViewportRef = useRef<HTMLDivElement | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [minimizedStackScrollOffset, setMinimizedStackScrollOffset] =
    useState(0);
  const [verticalClampOffsetPx, setVerticalClampOffsetPx] = useState(0);
  const [capturedPreviewByMemoryKey, setCapturedPreviewByMemoryKey] = useState<
    Record<string, WorkbenchHostDockPopupCapturedPreview | undefined>
  >({});
  const columnCount = isContextMenu
    ? 1
    : Math.min(Math.max(items.length + createCardCount, 1), 3);
  const popupWidthPx = isContextMenu
    ? 268
    : columnCount * dockPopupCardWidthPx +
      Math.max(0, columnCount - 1) * dockPopupGridGapPx +
      dockPopupPanelPaddingInlinePx * 2 +
      dockPopupPanelBorderInlinePx;
  const popupCenterY = anchorRect.top + anchorRect.height / 2;
  const isLeftMinimizedStack = placement === "left" && isMinimizedStack;
  const minimizedStackTrackHeightPx = resolveMinimizedStackTrackHeightPx(
    items.length
  );
  const minimizedStackViewportHeightPx = isMinimizedStack
    ? resolveMinimizedStackViewportHeightPx({
        anchorCenterY: popupCenterY,
        placement,
        trackHeightPx: minimizedStackTrackHeightPx
      })
    : minimizedStackTrackHeightPx;
  const minimizedStackTrackTranslateXPx = isMinimizedStack
    ? resolveMinimizedStackTrackTranslateXPx({
        itemCount: items.length,
        placement,
        scrollOffset: minimizedStackScrollOffset,
        trackHeightPx: minimizedStackTrackHeightPx,
        viewportHeightPx: minimizedStackViewportHeightPx
      })
    : 0;
  const minimizedStackLeftGutterPx = isLeftMinimizedStack
    ? resolveMinimizedStackLeftGutterPx({
        itemCount: items.length,
        placement,
        scrollOffset: minimizedStackScrollOffset,
        trackHeightPx: minimizedStackTrackHeightPx,
        viewportHeightPx: minimizedStackViewportHeightPx,
        trackTranslateXPx: minimizedStackTrackTranslateXPx
      })
    : 0;
  const minimizedStackPanelWidthPx = isLeftMinimizedStack
    ? resolveMinimizedStackPanelWidthPx(items.length, placement, {
        leftGutterPx: minimizedStackLeftGutterPx
      })
    : null;
  const popupStyle: WorkbenchHostDockPopupRootStyle = {
    "--desktop-dock-popup-columns": String(columnCount),
    "--desktop-dock-popup-width":
      minimizedStackPanelWidthPx != null
        ? `${minimizedStackPanelWidthPx}px`
        : `${popupWidthPx}px`,
    ...(minimizedStackPanelWidthPx != null
      ? {
          "--desktop-dock-minimized-stack-width": `${minimizedStackPanelWidthPx}px`,
          minWidth: minimizedStackPanelWidthPx,
          width: minimizedStackPanelWidthPx
        }
      : {}),
    left: isLeftMinimizedStack
      ? resolveMinimizedStackPopupLeftPx({
          anchorLeft: anchorRect.left,
          anchorWidth: anchorRect.width,
          dockRightPx: anchorRect.dockRight,
          leftGutterPx: minimizedStackLeftGutterPx
        })
      : placement === "left"
        ? anchorRect.left + anchorRect.width + dockPopupPlacementGapPx
        : anchorRect.left + anchorRect.width / 2,
    top: isLeftMinimizedStack
      ? resolveMinimizedStackPopupTopPx({ anchorTop: anchorRect.top })
      : placement === "left"
        ? popupCenterY
        : anchorRect.top - dockPopupPlacementGapPx,
    ...(isLeftMinimizedStack
      ? { zIndex: dockPopupMinimizedStackPopupZIndex }
      : {}),
    ...(isMinimizedStack
      ? {}
      : { "--desktop-dock-popup-clamp-offset": `${verticalClampOffsetPx}px` })
  };
  const minimizedStackMaxScrollOffset = Math.max(
    0,
    minimizedStackTrackHeightPx - minimizedStackViewportHeightPx
  );
  const initialMinimizedStackScrollOffset =
    resolveInitialMinimizedStackScrollOffset({
      maxScrollOffset: minimizedStackMaxScrollOffset
    });
  const panelStyle: CSSProperties = {
    "--desktop-dock-popup-columns": String(columnCount),
    "--desktop-dock-popup-item-count": String(Math.max(1, items.length)),
    ...(isMinimizedStack
      ? {
          height: minimizedStackViewportHeightPx,
          minHeight: minimizedStackViewportHeightPx,
          ...(isLeftMinimizedStack && minimizedStackPanelWidthPx != null
            ? {
                width: minimizedStackPanelWidthPx,
                minWidth: minimizedStackPanelWidthPx,
                "--desktop-dock-minimized-stack-left-gutter": `${minimizedStackLeftGutterPx}px`
              }
            : {})
        }
      : {})
  } as CSSProperties;
  const popupDiagnosticKey = items.map((item) => item.node.id).join("|");

  useEffect(() => {
    logWorkbenchDockPopupDebug("dock.popup.rendered", debugDiagnostics, {
      hasCapturePreview: Boolean(capturePreview),
      itemCount: popupDiagnosticKey ? popupDiagnosticKey.split("|").length : 0,
      nodeIds: popupDiagnosticKey ? popupDiagnosticKey.split("|") : [],
      placement,
      variant: resolvedVariant
    });
  }, [
    capturePreview,
    debugDiagnostics,
    placement,
    popupDiagnosticKey,
    resolvedVariant
  ]);

  useLayoutEffect(() => {
    const rootElement = popupRootRef.current;
    const panelElement =
      rootElement?.querySelector<HTMLElement>(
        "[data-desktop-dock-popup-panel]"
      ) ?? null;
    logWorkbenchDockPopupDebug("dock.popup.layout", debugDiagnostics, {
      panelRect: panelElement ? rectToDiagnostic(panelElement) : null,
      rootRect: rootElement ? rectToDiagnostic(rootElement) : null,
      rootStyle: rootElement ? styleToDiagnostic(rootElement) : null,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    });
  }, [debugDiagnostics, popupDiagnosticKey]);

  useLayoutEffect(() => {
    if (isMinimizedStack || typeof window === "undefined") {
      return;
    }
    const rootElement = popupRootRef.current;
    const panelElement = rootElement?.querySelector<HTMLElement>(
      "[data-desktop-dock-popup-panel]"
    );
    if (!panelElement) {
      return;
    }

    const measureAndClamp = () => {
      const panelHeightPx = panelElement.offsetHeight;
      const naturalTopPx =
        placement === "left"
          ? popupCenterY - panelHeightPx / 2
          : anchorRect.top - dockPopupPlacementGapPx - panelHeightPx;
      const naturalBottomPx =
        placement === "left"
          ? popupCenterY + panelHeightPx / 2
          : anchorRect.top - dockPopupPlacementGapPx;
      const offsetPx = resolveDockPopupVerticalClampOffsetPx({
        naturalBottomPx,
        naturalTopPx,
        viewportHeightPx: window.innerHeight
      });
      setVerticalClampOffsetPx((current) =>
        current === offsetPx ? current : offsetPx
      );
    };

    measureAndClamp();

    const resizeObserver = new ResizeObserver(measureAndClamp);
    resizeObserver.observe(panelElement);
    window.addEventListener("resize", measureAndClamp);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureAndClamp);
    };
  }, [
    anchorRect.top,
    isMinimizedStack,
    placement,
    popupCenterY,
    popupDiagnosticKey
  ]);

  const registerCard = useCallback((nodeId: string) => {
    const existing = cardRefCallbacksRef.current.get(nodeId);
    if (existing) {
      return existing;
    }

    const callback = (element: HTMLElement | null) => {
      if (element) {
        cardElementsRef.current.set(nodeId, element);
      } else {
        cardElementsRef.current.delete(nodeId);
      }
    };
    cardRefCallbacksRef.current.set(nodeId, callback);
    return callback;
  }, []);

  useEffect(() => {
    if (!isLeftMinimizedStack) {
      return;
    }
    document.body.setAttribute(
      "data-desktop-dock-minimized-stack-open",
      "true"
    );
    return () => {
      document.body.removeAttribute("data-desktop-dock-minimized-stack-open");
    };
  }, [isLeftMinimizedStack]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) {
        onClose();
        return;
      }
      if (
        event.target.closest("[data-desktop-dock-slot]") ||
        event.target.closest("[data-desktop-dock-popup-card]") ||
        event.target.closest(
          '.desktop-dock-popup-root:not([data-popup-variant="minimized-stack"])'
        )
      ) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const previewCaptureKey = items
    .map(
      (item) =>
        `${item.node.id}:${previewCacheToken(item.preview)}:${item.previewRevision ?? ""}`
    )
    .join("|");

  useEffect(() => {
    if (!isMinimizedStack) {
      return;
    }
    setMinimizedStackScrollOffset(initialMinimizedStackScrollOffset);
  }, [initialMinimizedStackScrollOffset, isMinimizedStack, items.length]);

  useEffect(() => {
    if (!isMinimizedStack) {
      return;
    }
    const viewport = minimizedStackViewportRef.current;
    if (!viewport) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setMinimizedStackScrollOffset((current) =>
        Math.min(
          minimizedStackMaxScrollOffset,
          Math.max(0, current + event.deltaY)
        )
      );
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [isMinimizedStack, minimizedStackMaxScrollOffset]);

  useEffect(() => {
    if (!capturePreview || isContextMenu) {
      return;
    }
    let cancelled = false;
    const missingItems = items.filter((item) => {
      const revision = item.previewRevision;
      const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
        item.node,
        resolveDockPreviewCacheKey?.(item.node) ?? null
      );
      const capturedPreview =
        capturedPreviewByMemoryKey[previewMemoryKey] ??
        readDockPopupPreviewImage(previewMemoryKey);
      const hasCapturedPreview =
        capturedPreview !== undefined && capturedPreview.revision === revision;
      const shouldCaptureMissingPreview = !item.preview && !hasCapturedPreview;
      return (
        shouldCaptureMissingPreview &&
        !pendingDockPopupPreviewMemoryKeys.has(previewMemoryKey)
      );
    });
    if (missingItems.length === 0) {
      logWorkbenchDockPopupDebug(
        "dock.popup.preview_capture.batch",
        debugDiagnostics,
        {
          itemCount: items.length,
          missingNodeIds: []
        }
      );
      return () => {
        cancelled = true;
      };
    }
    logWorkbenchDockPopupDebug(
      "dock.popup.preview_capture.batch",
      debugDiagnostics,
      {
        itemCount: items.length,
        missingNodeIds: missingItems.map((item) => item.node.id)
      }
    );

    for (const item of missingItems) {
      pendingDockPopupPreviewMemoryKeys.add(
        resolveDockPopupPreviewMemoryKey(
          item.node,
          resolveDockPreviewCacheKey?.(item.node) ?? null
        )
      );
    }

    void (async () => {
      for (const item of missingItems) {
        if (cancelled) {
          break;
        }

        const revision = item.previewRevision;
        logWorkbenchDockPopupDebug(
          "dock.popup.preview_capture.started",
          debugDiagnostics,
          {
            isMinimized: item.isMinimized,
            nodeId: item.node.id,
            revision
          }
        );
        const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
          item.node,
          resolveDockPreviewCacheKey?.(item.node) ?? null
        );
        const cacheKey = resolveDockPopupPreviewCacheKey(
          resolveDockPreviewCacheKey?.(item.node) ?? null,
          revision
        );
        if (item.isMinimized && cacheKey) {
          const minimizedPersistedPreview = await readPersistedDockPreview(
            dockPreviewCache,
            cacheKey
          );
          if (cancelled) {
            break;
          }
          if (minimizedPersistedPreview) {
            const persistedPreview: WorkbenchDockPreviewContent = {
              kind: "image",
              src: minimizedPersistedPreview
            };
            writeCachedWorkbenchNodePreviewImage(
              item.node.id,
              minimizedPersistedPreview
            );
            writeDockPopupPreviewImage(
              previewMemoryKey,
              persistedPreview,
              revision
            );
            setCapturedPreviewByMemoryKey((current) => ({
              ...current,
              [previewMemoryKey]: {
                preview: persistedPreview,
                revision
              }
            }));
            pendingDockPopupPreviewMemoryKeys.delete(previewMemoryKey);
            continue;
          }
        }

        const preview = normalizeDockPopupPreviewContentResult(
          item.isMinimized
            ? ((await capturePreview?.(item)) ??
                (await captureWorkbenchNodePreviewImage(item.node.id, {
                  bypassCache: false
                })))
            : await Promise.resolve(capturePreview?.(item) ?? null).catch(
                () => null
              ),
          revision
        );
        if (cancelled) {
          break;
        }
        logWorkbenchDockPopupDebug(
          "dock.popup.preview_capture.resolved",
          debugDiagnostics,
          {
            hasPreview: Boolean(preview),
            nodeId: item.node.id,
            providerRevision: preview?.revision ?? null,
            revision
          }
        );
        if (preview) {
          if (preview.kind === "image") {
            writeCachedWorkbenchNodePreviewImage(item.node.id, preview.src);
          }
          writeDockPopupPreviewImage(previewMemoryKey, preview, revision);
          if (cacheKey && preview.kind === "image") {
            dockPreviewCache?.write({
              key: cacheKey,
              previewImageUrl: preview.src
            });
          }
          setCapturedPreviewByMemoryKey((current) => ({
            ...current,
            [previewMemoryKey]: { preview, revision }
          }));
          pendingDockPopupPreviewMemoryKeys.delete(previewMemoryKey);
          continue;
        }

        const fallbackPersistedPreview =
          !item.isMinimized && cacheKey
            ? await readPersistedDockPreview(dockPreviewCache, cacheKey)
            : null;
        if (cancelled) {
          break;
        }
        if (fallbackPersistedPreview) {
          writeCachedWorkbenchNodePreviewImage(
            item.node.id,
            fallbackPersistedPreview
          );
        }
        if (fallbackPersistedPreview || item.isMinimized) {
          const fallbackPreview: WorkbenchDockPreviewContent | null =
            fallbackPersistedPreview
              ? { kind: "image", src: fallbackPersistedPreview }
              : null;
          writeDockPopupPreviewImage(
            previewMemoryKey,
            fallbackPreview,
            revision
          );
        }
        if (!cancelled) {
          const fallbackPreview: WorkbenchDockPreviewContent | null =
            fallbackPersistedPreview
              ? { kind: "image", src: fallbackPersistedPreview }
              : null;
          setCapturedPreviewByMemoryKey((current) => ({
            ...current,
            [previewMemoryKey]: { preview: fallbackPreview, revision }
          }));
        }
        pendingDockPopupPreviewMemoryKeys.delete(previewMemoryKey);
      }
    })().catch(() => {
      for (const item of missingItems) {
        const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
          item.node,
          resolveDockPreviewCacheKey?.(item.node) ?? null
        );
        writeDockPopupPreviewImage(
          previewMemoryKey,
          null,
          item.previewRevision
        );
        pendingDockPopupPreviewMemoryKeys.delete(previewMemoryKey);
      }
      if (!cancelled) {
        setCapturedPreviewByMemoryKey((current) => ({
          ...current,
          ...Object.fromEntries(
            missingItems.map((item) => {
              const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
                item.node,
                resolveDockPreviewCacheKey?.(item.node) ?? null
              );
              return [
                previewMemoryKey,
                { preview: null, revision: item.previewRevision }
              ];
            })
          )
        }));
      }
    });

    return () => {
      cancelled = true;
      for (const item of missingItems) {
        pendingDockPopupPreviewMemoryKeys.delete(
          resolveDockPopupPreviewMemoryKey(
            item.node,
            resolveDockPreviewCacheKey?.(item.node) ?? null
          )
        );
      }
    };
  }, [
    capturePreview,
    dockPreviewCache,
    isContextMenu,
    items,
    previewCaptureKey,
    resolveDockPreviewCacheKey
  ]);

  const content = (
    <div
      ref={popupRootRef}
      className="desktop-dock-popup-root"
      data-dock-placement={placement}
      data-desktop-dock-popup-root="true"
      data-popup-variant={resolvedVariant}
      style={popupStyle}
    >
      <div
        aria-label={label}
        className={cn(
          "desktop-dock-popup relative origin-bottom rounded-lg border border-[var(--border-1)] bg-background-fronted text-[var(--text-primary)] shadow-panel motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2 motion-safe:duration-[175ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
          isContextMenu ? "p-1" : "p-3",
          isLeftMinimizedStack
            ? "w-full min-w-0 max-w-none"
            : "w-[min(var(--desktop-dock-popup-width,366px),calc(100vw-32px))]"
        )}
        data-desktop-dock-popup-panel="true"
        data-popup-variant={resolvedVariant}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={
          isMinimizedStack
            ? (event) => setPointer({ x: event.clientX, y: event.clientY })
            : undefined
        }
        onPointerLeave={isMinimizedStack ? () => setPointer(null) : undefined}
        role="dialog"
        style={panelStyle}
      >
        {isContextMenu ? (
          <WorkbenchHostDockContextMenu
            canCreateNew={showCreateNew !== false}
            canEnterFullscreen={canEnterFullscreen === true}
            canShowAllWindows={canShowAllWindows === true}
            dockRetention={dockRetention}
            fullscreenLabel={fullscreenLabel}
            hideLabel={hideLabel}
            items={items}
            newWindowLabel={newWindowLabel}
            onCreateNew={onCreateNew}
            onEnterFullscreen={onEnterFullscreen}
            onHide={onHide}
            onQuit={onQuit}
            onRunDockRetentionAction={onRunDockRetentionAction}
            onSelectNode={onSelectNode}
            onShowAllWindows={onShowAllWindows}
            quitLabel={quitLabel}
            showAllWindowsLabel={showAllWindowsLabel}
            showOpen={showOpen === true}
          />
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="min-w-0 truncate text-sm font-semibold">
                {label}
              </span>
            </div>
            {isMinimizedStack ? (
              <div
                ref={minimizedStackViewportRef}
                className="desktop-dock-popup__minimized-stack-viewport"
                style={{
                  height: minimizedStackViewportHeightPx,
                  ...(isLeftMinimizedStack
                    ? { paddingLeft: minimizedStackLeftGutterPx }
                    : {})
                }}
              >
                <div
                  className="desktop-dock-popup__minimized-stack-track"
                  style={{
                    minHeight: minimizedStackTrackHeightPx,
                    transform: `translate(${minimizedStackTrackTranslateXPx}px, ${-minimizedStackScrollOffset}px)`
                  }}
                >
                  {items.map((item, index) => {
                    const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
                      item.node,
                      resolveDockPreviewCacheKey?.(item.node) ?? null
                    );
                    const capturedPreview =
                      capturedPreviewByMemoryKey[previewMemoryKey] !== undefined
                        ? capturedPreviewByMemoryKey[previewMemoryKey]
                        : readDockPopupPreviewImage(previewMemoryKey);
                    const previewState = resolveDockPopupItemPreviewState(
                      item,
                      capturedPreview,
                      Boolean(capturePreview)
                    );
                    return (
                      <WorkbenchHostDockPopupCard
                        key={item.node.id}
                        ref={registerCard(item.node.id)}
                        closeWindowLabel={closeWindowLabel}
                        item={item}
                        labelMode={resolvedLabelMode}
                        onCloseNode={onCloseNode}
                        onSelectNode={onSelectNode}
                        previewState={previewState}
                        style={{
                          ...resolvePopupFanCardStyle(
                            index,
                            items.length,
                            placement
                          ),
                          ...resolvePopupCardMagnificationStyle(
                            pointer,
                            cardElementsRef.current.get(item.node.id) ?? null
                          )
                        }}
                        variant={resolvedVariant}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="grid max-h-[min(52vh,420px)] grid-cols-[repeat(var(--desktop-dock-popup-columns,2),165px)] gap-2 overflow-auto overscroll-contain">
                {items.map((item) => {
                  const previewMemoryKey = resolveDockPopupPreviewMemoryKey(
                    item.node,
                    resolveDockPreviewCacheKey?.(item.node) ?? null
                  );
                  const capturedPreview =
                    capturedPreviewByMemoryKey[previewMemoryKey] !== undefined
                      ? capturedPreviewByMemoryKey[previewMemoryKey]
                      : readDockPopupPreviewImage(previewMemoryKey);
                  const previewState = resolveDockPopupItemPreviewState(
                    item,
                    capturedPreview,
                    Boolean(capturePreview)
                  );
                  return (
                    <WorkbenchHostDockPopupCard
                      key={item.node.id}
                      ref={registerCard(item.node.id)}
                      closeWindowLabel={closeWindowLabel}
                      item={item}
                      labelMode={resolvedLabelMode}
                      onCloseNode={onCloseNode}
                      onSelectNode={onSelectNode}
                      previewState={previewState}
                      variant={resolvedVariant}
                    />
                  );
                })}
                {showCreateNew !== false ? (
                  <button
                    className="flex h-[103px] w-[165px] min-w-0 flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-[var(--border-1)] bg-transparency-block text-center text-[var(--text-secondary)] transition-colors hover:bg-transparency-hover hover:text-[var(--text-primary)]"
                    type="button"
                    onClick={onCreateNew}
                  >
                    <FileCreateIcon
                      aria-hidden="true"
                      className="text-[var(--text-primary)]"
                      size={28}
                    />
                    <span className="text-xs font-semibold text-[var(--text-primary)]">
                      {newWindowLabel}
                    </span>
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (typeof document === "undefined" || !document.body) {
    return content;
  }
  return createPortal(content, document.body);
}

function WorkbenchHostDockContextMenu({
  canCreateNew,
  canEnterFullscreen,
  canShowAllWindows,
  dockRetention,
  fullscreenLabel,
  hideLabel,
  items,
  newWindowLabel,
  onCreateNew,
  onEnterFullscreen,
  onHide,
  onQuit,
  onRunDockRetentionAction,
  onSelectNode,
  onShowAllWindows,
  quitLabel,
  showAllWindowsLabel,
  showOpen
}: {
  canCreateNew: boolean;
  canEnterFullscreen: boolean;
  canShowAllWindows: boolean;
  dockRetention?: WorkbenchHostDockPopupRetentionAction | null;
  fullscreenLabel?: string;
  hideLabel?: string;
  items: WorkbenchHostDockPopupItem[];
  newWindowLabel: string;
  onCreateNew: () => void;
  onEnterFullscreen?: () => void;
  onHide?: () => void;
  onQuit?: () => void;
  onRunDockRetentionAction?: () => void;
  onSelectNode: (nodeId: string) => void;
  onShowAllWindows?: () => void;
  quitLabel?: string;
  showAllWindowsLabel?: string;
  showOpen: boolean;
}) {
  const hasOpenWindows = items.length > 0;
  const hasNewWindowCommand = hasOpenWindows && canCreateNew;
  const hasOpenCommand = !hasOpenWindows;
  const hasDockActionGroup =
    Boolean(dockRetention) || hasNewWindowCommand || hasOpenCommand;
  const hasWindowActionGroup = hasOpenWindows;

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-desktop-dock-context-menu="true"
      role="menu"
    >
      {hasOpenWindows ? (
        <>
          <div className="max-h-48 min-w-0 overflow-auto overscroll-contain">
            {items.map((item) => (
              <WorkbenchHostDockContextMenuItem
                key={item.node.id}
                checked={!item.isMinimized}
                label={item.title?.trim() || item.node.title}
                onSelect={() => onSelectNode(item.node.id)}
              />
            ))}
          </div>
        </>
      ) : null}
      {hasOpenWindows && (hasDockActionGroup || hasWindowActionGroup) ? (
        <WorkbenchHostDockContextMenuSeparator />
      ) : null}
      {dockRetention ? (
        <WorkbenchHostDockContextMenuItem
          checked={dockRetention.checked}
          checkedIcon={
            <PinFilledIcon
              aria-hidden="true"
              className="size-4 text-[var(--tutti-purple)]"
            />
          }
          disabled={dockRetention.disabled}
          icon={<PinIcon aria-hidden="true" className="size-4" />}
          label={dockRetention.pendingLabel ?? dockRetention.label}
          onSelect={onRunDockRetentionAction}
        />
      ) : null}
      {hasNewWindowCommand ? (
        <WorkbenchHostDockContextMenuItem
          icon={<FileCreateIcon aria-hidden="true" className="size-4" />}
          label={newWindowLabel}
          onSelect={onCreateNew}
        />
      ) : null}
      {hasOpenCommand ? (
        <WorkbenchHostDockContextMenuItem
          disabled={!showOpen}
          icon={<FileCreateIcon aria-hidden="true" className="size-4" />}
          label={newWindowLabel}
          onSelect={onCreateNew}
        />
      ) : null}
      {hasOpenWindows ? (
        <>
          {hasDockActionGroup ? (
            <WorkbenchHostDockContextMenuSeparator />
          ) : null}
          {canShowAllWindows && onShowAllWindows ? (
            <WorkbenchHostDockContextMenuItem
              icon={
                <OverviewLayoutIcon aria-hidden="true" className="size-4" />
              }
              label={showAllWindowsLabel}
              onSelect={onShowAllWindows}
            />
          ) : null}
          <WorkbenchHostDockContextMenuItem
            disabled={!canEnterFullscreen || !onEnterFullscreen}
            icon={<MaximizeIcon aria-hidden="true" className="size-4" />}
            label={fullscreenLabel}
            onSelect={onEnterFullscreen}
          />
          <WorkbenchHostDockContextMenuItem
            disabled={!onHide}
            icon={<MinimizeIcon aria-hidden="true" className="size-4" />}
            label={hideLabel}
            onSelect={onHide}
          />
          <WorkbenchHostDockContextMenuItem
            disabled={!onQuit}
            icon={<CloseIcon aria-hidden="true" className="size-4" />}
            label={quitLabel}
            onSelect={onQuit}
          />
        </>
      ) : null}
    </div>
  );
}

function WorkbenchHostDockContextMenuItem({
  checked,
  checkedIcon,
  disabled,
  icon,
  label,
  onSelect
}: {
  checked?: boolean;
  checkedIcon?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  label?: string;
  onSelect?: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--text-primary)] transition-colors",
        disabled
          ? "cursor-default opacity-45"
          : "hover:bg-transparency-hover focus-visible:bg-transparency-hover focus-visible:outline-none"
      )}
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => {
        if (disabled || !onSelect) {
          return;
        }
        onSelect();
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {checked && checkedIcon ? (
          checkedIcon
        ) : checked ? (
          <CheckIcon
            aria-hidden="true"
            className="size-4 text-[var(--tutti-purple)]"
          />
        ) : (
          (icon ?? null)
        )}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function WorkbenchHostDockContextMenuSeparator() {
  return (
    <div
      aria-hidden="true"
      className="mx-2 my-1 h-px bg-[var(--border-1)]"
      role="separator"
    />
  );
}

function readPersistedDockPreview(
  dockPreviewCache: WorkbenchDockPreviewCache | undefined,
  cacheKey: WorkbenchDockPreviewCacheKey | null
): Promise<string | null> {
  if (!cacheKey) {
    return Promise.resolve(null);
  }
  return (
    dockPreviewCache?.read(cacheKey).catch(() => null) ?? Promise.resolve(null)
  );
}

function resolveDockPopupPreviewCacheKey(
  cacheKey: WorkbenchDockPreviewCacheKey | null,
  revision: string | null
): WorkbenchDockPreviewCacheKey | null {
  return cacheKey ? { ...cacheKey, revision } : null;
}

function resolveDockPopupPreviewMemoryKey(
  node: WorkbenchNode<WorkbenchHostNodeData>,
  cacheKey: WorkbenchDockPreviewCacheKey | null
): string {
  if (!cacheKey) {
    return `node:${node.id}`;
  }
  return `cache:${JSON.stringify({
    instanceId: cacheKey.instanceId,
    instanceKey: cacheKey.instanceKey ?? null,
    nodeId: cacheKey.nodeId,
    typeId: cacheKey.typeId,
    workspaceId: cacheKey.workspaceId
  })}`;
}

function normalizeDockPopupPreviewContentResult(
  preview: WorkbenchDockPreviewContent | string | null | undefined,
  revision: string | null
): WorkbenchDockPreviewContent | null {
  if (!preview) {
    return null;
  }
  if (typeof preview === "string") {
    return { kind: "image", revision: revision ?? undefined, src: preview };
  }
  return {
    ...preview,
    revision: preview.revision ?? revision ?? undefined
  };
}

function resolveDockPopupItemPreviewState(
  item: WorkbenchHostDockPopupItem,
  capturedPreview: WorkbenchHostDockPopupCapturedPreview | undefined,
  hasPreviewProvider: boolean
): WorkbenchHostDockPopupPreviewState {
  const revision = item.previewRevision;
  if (item.preview) {
    return { preview: item.preview, status: "ready" };
  }
  if (
    capturedPreview &&
    capturedPreview.revision === revision &&
    capturedPreview.preview
  ) {
    return { preview: capturedPreview.preview, status: "ready" };
  }
  if (
    (capturedPreview !== undefined && capturedPreview.revision === revision) ||
    !hasPreviewProvider
  ) {
    return { status: "fallback" };
  }
  return { status: "loading" };
}

function previewCacheToken(
  preview: WorkbenchDockPreviewContent | null | undefined
): string {
  if (!preview) {
    return "";
  }
  switch (preview.kind) {
    case "component":
      return `component:${preview.revision ?? ""}`;
    case "image":
      return `image:${preview.revision ?? ""}:${preview.src}`;
  }
}

function logWorkbenchDockPopupDebug(
  event: string,
  debugDiagnostics: WorkbenchHostProps["debugDiagnostics"],
  details: Record<string, unknown>
): void {
  if (!debugDiagnostics?.log) {
    return;
  }
  void Promise.resolve(
    debugDiagnostics.log({
      details,
      event,
      level: "info",
      source: "workbench-dock"
    })
  ).catch(() => undefined);
}

function rectToDiagnostic(element: HTMLElement): Record<string, number> {
  const rect = element.getBoundingClientRect();
  return {
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    top: Math.round(rect.top),
    width: Math.round(rect.width)
  };
}

function styleToDiagnostic(element: HTMLElement): Record<string, string> {
  const style = window.getComputedStyle(element);
  return {
    display: style.display,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    position: style.position,
    transform: style.transform,
    visibility: style.visibility,
    zIndex: style.zIndex
  };
}

interface WorkbenchHostDockPopupCardProps {
  closeWindowLabel: (title: string) => string;
  item: WorkbenchHostDockPopupItem;
  labelMode?: WorkbenchHostDockPopupCardLabelMode;
  onCloseNode: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  previewState: WorkbenchHostDockPopupPreviewState;
  style?: CSSProperties;
  variant?: WorkbenchHostDockPopupVariant;
}

const WorkbenchHostDockPopupCard = forwardRef<
  HTMLDivElement,
  WorkbenchHostDockPopupCardProps
>(function WorkbenchHostDockPopupCard(
  {
    closeWindowLabel,
    item,
    labelMode,
    onCloseNode,
    onSelectNode,
    previewState,
    style,
    variant
  },
  ref
) {
  const title = item.title?.trim() || item.node.title;
  const isMinimizedStack = variant === "minimized-stack";
  const [isLaunching, setIsLaunching] = useState(false);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (launchTimerRef.current !== null) {
        clearTimeout(launchTimerRef.current);
      }
    },
    []
  );

  const handleSelect = useCallback(() => {
    if (!isMinimizedStack) {
      onSelectNode(item.node.id);
      return;
    }
    if (launchTimerRef.current !== null) {
      return;
    }
    setIsLaunching(true);
    launchTimerRef.current = setTimeout(() => {
      launchTimerRef.current = null;
      onSelectNode(item.node.id);
    }, dockPopupMinimizedStackLaunchDisappearMs);
  }, [isMinimizedStack, item.node.id, onSelectNode]);
  const handleSelectKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      handleSelect();
    },
    [handleSelect]
  );
  const hasReadyPreview = previewState.status === "ready";

  return (
    <div
      ref={ref}
      className={cn(
        "group/dock-popup-card relative flex h-[103px] w-[165px] min-w-0 flex-col overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-background-fronted text-left text-[var(--text-primary)] transition-[border-color,color] duration-150",
        item.isMinimized && "text-[var(--text-secondary)]"
      )}
      data-active={item.isFocused ? "true" : undefined}
      data-desktop-dock-popup-card="true"
      data-fan-card={isMinimizedStack ? "true" : undefined}
      data-launching={isLaunching ? "true" : undefined}
      data-minimized={item.isMinimized ? "true" : undefined}
      style={style}
    >
      <div
        aria-label={title}
        data-active={item.isFocused ? "true" : undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 cursor-pointer flex-col overflow-hidden rounded-md bg-transparent text-inherit",
          hasReadyPreview ? "p-0" : "p-1"
        )}
        role="button"
        tabIndex={0}
        onClick={handleSelect}
        onKeyDown={handleSelectKeyDown}
      >
        <WorkbenchHostDockPopupCardPreview previewState={previewState} />
        {labelMode === "hover-overlay" && item.title?.trim() ? (
          <WorkbenchHostDockPopupCardLabel title={item.title} />
        ) : null}
      </div>
      <Button
        aria-label={closeWindowLabel(title)}
        className="absolute top-1.5 right-1.5 z-[2] rounded-full bg-[var(--background-fronted)] opacity-0 transition-[background-color,opacity] duration-150 hover:bg-[var(--background-fronted)] focus-visible:bg-[var(--background-fronted)] group-hover/dock-popup-card:opacity-100 group-focus-within/dock-popup-card:opacity-100 focus-visible:opacity-100"
        size="icon-sm"
        title={closeWindowLabel(title)}
        type="button"
        variant="ghost"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseNode(item.node.id);
        }}
      >
        <CloseIcon className="size-3.5" />
      </Button>
      {item.isFocused ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[3] rounded-md shadow-[inset_0_0_0_2px_var(--border-focus)]"
          data-desktop-dock-popup-card-active-overlay="true"
        />
      ) : null}
      {isMinimizedStack ? (
        <span className="desktop-dock-popup__fan-title-tip" title={title}>
          {title}
        </span>
      ) : null}
    </div>
  );
});

function WorkbenchHostDockPopupCardPreview({
  previewState
}: {
  previewState: WorkbenchHostDockPopupPreviewState;
}) {
  if (previewState.status !== "ready") {
    return (
      <span
        className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-[7px] rounded-md border border-[var(--border-1)] bg-transparency-block px-3 py-[11px]"
        aria-hidden="true"
        data-preview-state={previewState.status}
      >
        <span className="block h-[7px] w-[72%] rounded-full bg-transparency-hover" />
        <span className="block h-[7px] w-[58%] rounded-full bg-transparency-hover" />
        <span className="block h-[7px] w-[34%] rounded-full bg-transparency-hover" />
      </span>
    );
  }

  const preview = previewState.preview;
  if (preview.kind === "component") {
    return (
      <span
        className="block min-h-0 min-w-0 flex-1 overflow-hidden rounded-md"
        aria-hidden="true"
        data-preview-kind={preview.kind}
        data-preview-state={previewState.status}
      >
        {preview.element}
      </span>
    );
  }

  return (
    <span
      className="block min-h-0 min-w-0 flex-1 overflow-hidden rounded-md"
      aria-hidden="true"
      data-preview-kind={preview.kind}
      data-preview-state={previewState.status}
    >
      <img
        alt=""
        className="block h-full max-h-full w-full max-w-full object-contain object-center"
        draggable={false}
        src={preview.src}
      />
    </span>
  );
}

function WorkbenchHostDockPopupCardLabel({ title }: { title: string }) {
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex h-[30px] items-end px-[10px] pb-0.5 text-[var(--white-stationary)] opacity-0 transition-opacity duration-150 [text-shadow:0_1px_2px_rgb(0_0_0_/_20%)] group-hover/dock-popup-card:opacity-100 group-focus-within/dock-popup-card:opacity-100"
      style={{
        background:
          "linear-gradient(180deg, transparent 0%, color-mix(in srgb, hsl(var(--card)) 28%, transparent) 18%, color-mix(in srgb, hsl(var(--card)) 82%, transparent) 56%, color-mix(in srgb, hsl(var(--card)) 98%, transparent) 100%)"
      }}
      title={title}
    >
      <span className="desktop-dock-popup__title-viewport block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        <span className="desktop-dock-popup__title-marquee inline-block max-w-full overflow-hidden text-[12px] font-semibold leading-5 text-ellipsis whitespace-nowrap">
          {title}
        </span>
      </span>
    </span>
  );
}
