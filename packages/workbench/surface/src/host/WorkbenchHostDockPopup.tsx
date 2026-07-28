import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { FileCreateIcon, cn } from "@tutti-os/ui-system";
import type { WorkbenchNode } from "../core/types.ts";
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
  WorkbenchDockPreviewCacheKeyResolver
} from "../react/dockPreviewCache.ts";
import {
  resolvePopupCardMagnificationStyle,
  resolvePopupFanCardStyle,
  WorkbenchHostDockContextMenu,
  WorkbenchHostDockPopupCard
} from "./WorkbenchHostDockPopupPresentation.tsx";
import {
  logWorkbenchDockPopupDebug,
  useWorkbenchHostDockPopupPreviewCapture
} from "./useWorkbenchHostDockPopupPreviewCapture.ts";

const dockPopupCardWidthPx = 165;
const dockPopupCardHeightPx = 103;
const dockPopupPreviewInsetPx = 4;
export const workbenchHostDockPopupPreviewViewport = Object.freeze({
  height: dockPopupCardHeightPx - dockPopupPreviewInsetPx * 2,
  width: dockPopupCardWidthPx - dockPopupPreviewInsetPx * 2
});
const dockPopupGridGapPx = 8;
const dockPopupPanelPaddingInlinePx = 12;
const dockPopupPanelBorderInlinePx = 2;
const dockPopupPlacementGapPx = 14;
const dockPopupMinimizedStackPopupZIndex = 100300;

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

interface WorkbenchHostDockPopupRootStyle extends CSSProperties {
  "--desktop-dock-minimized-stack-width"?: string;
  "--desktop-dock-popup-clamp-offset"?: string;
  "--desktop-dock-popup-columns": string;
  "--desktop-dock-popup-width": string;
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
  showCreateNewInContextMenu,
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
  showCreateNewInContextMenu?: boolean;
  showOpen?: boolean;
  variant?: WorkbenchHostDockPopupVariant;
}) {
  const resolvedShowCreateNewInContextMenu =
    showCreateNewInContextMenu ?? showCreateNew;
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
  const { previewStateFor } = useWorkbenchHostDockPopupPreviewCapture({
    capturePreview,
    debugDiagnostics,
    dockPreviewCache,
    isContextMenu,
    items,
    resolveDockPreviewCacheKey
  });
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
            canCreateNew={resolvedShowCreateNewInContextMenu !== false}
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
                    const previewState = previewStateFor(item);
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
                  const previewState = previewStateFor(item);
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
