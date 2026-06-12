import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { Button, CloseIcon, FileCreateIcon, cn } from "@tutti-os/ui-system";
import type { WorkbenchNode } from "../core/types.ts";
import {
  captureWorkbenchNodePreviewImage,
  writeCachedWorkbenchNodePreviewImage
} from "../react/useWorkbenchGenieAnimation.tsx";
import type {
  WorkbenchHostDockPopupCardLabelMode,
  WorkbenchHostNodeData
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
}

export interface WorkbenchHostDockPopupItem {
  isFocused: boolean;
  isMinimized: boolean;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  previewImageUrl: string | null;
  subtitle: string | null;
  title: string | null;
}

export type WorkbenchHostDockPopupVariant = "default" | "minimized-stack";

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

export function WorkbenchHostDockPopup({
  anchorRect,
  capturePreview,
  dockPreviewCache,
  items,
  label,
  labelMode,
  newWindowLabel,
  closeWindowLabel,
  onClose,
  onCloseNode,
  onCreateNew,
  onSelectNode,
  placement = "bottom",
  resolveDockPreviewCacheKey,
  showCreateNew,
  variant
}: {
  anchorRect: WorkbenchHostDockPopupState["anchorRect"];
  capturePreview?: (
    item: WorkbenchHostDockPopupItem
  ) => Promise<string | null> | string | null;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  items: WorkbenchHostDockPopupItem[];
  label: string;
  labelMode?: WorkbenchHostDockPopupCardLabelMode;
  newWindowLabel: string;
  closeWindowLabel: (title: string) => string;
  onClose: () => void;
  onCloseNode: (nodeId: string) => void;
  onCreateNew: () => void;
  onSelectNode: (nodeId: string) => void;
  placement?: WorkbenchDockPlacement;
  resolveDockPreviewCacheKey?: WorkbenchDockPreviewCacheKeyResolver<WorkbenchHostNodeData>;
  showCreateNew?: boolean;
  variant?: WorkbenchHostDockPopupVariant;
}) {
  const resolvedLabelMode = labelMode ?? "hover-overlay";
  const resolvedVariant = variant ?? "default";
  const isMinimizedStack = resolvedVariant === "minimized-stack";
  const createCardCount = showCreateNew === false ? 0 : 1;
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const minimizedStackViewportRef = useRef<HTMLDivElement | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [minimizedStackScrollOffset, setMinimizedStackScrollOffset] =
    useState(0);
  const [capturedPreviewByNodeId, setCapturedPreviewByNodeId] = useState<
    Record<string, string | undefined>
  >({});
  const columnCount = Math.min(Math.max(items.length + createCardCount, 1), 3);
  const popupWidthPx =
    columnCount * dockPopupCardWidthPx +
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
      : {})
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

  const registerCard = useCallback(
    (nodeId: string) => (element: HTMLElement | null) => {
      if (element) {
        cardElementsRef.current.set(nodeId, element);
      } else {
        cardElementsRef.current.delete(nodeId);
      }
    },
    []
  );

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
    .map((item) => `${item.node.id}:${item.previewImageUrl ?? ""}`)
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
    let cancelled = false;
    const missingItems = items.filter(
      (item) => !item.previewImageUrl && !capturedPreviewByNodeId[item.node.id]
    );
    if (missingItems.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      missingItems.map(async (item) => {
        const cacheKey = resolveDockPreviewCacheKey?.(item.node) ?? null;
        if (item.isMinimized && cacheKey) {
          const minimizedPersistedPreview = await readPersistedDockPreview(
            dockPreviewCache,
            cacheKey
          );
          if (minimizedPersistedPreview) {
            writeCachedWorkbenchNodePreviewImage(
              item.node.id,
              minimizedPersistedPreview
            );
            return {
              nodeId: item.node.id,
              previewImageUrl: minimizedPersistedPreview
            };
          }
        }

        const previewImageUrl =
          (await capturePreview?.(item)) ??
          (await captureWorkbenchNodePreviewImage(item.node.id, {
            bypassCache: !item.isMinimized
          }));
        if (previewImageUrl) {
          writeCachedWorkbenchNodePreviewImage(item.node.id, previewImageUrl);
          if (cacheKey) {
            dockPreviewCache?.write({ key: cacheKey, previewImageUrl });
          }
          return {
            nodeId: item.node.id,
            previewImageUrl
          };
        }

        const fallbackPersistedPreview =
          !item.isMinimized && cacheKey
            ? await readPersistedDockPreview(dockPreviewCache, cacheKey)
            : null;
        if (fallbackPersistedPreview) {
          writeCachedWorkbenchNodePreviewImage(
            item.node.id,
            fallbackPersistedPreview
          );
        }
        return {
          nodeId: item.node.id,
          previewImageUrl: fallbackPersistedPreview
        };
      })
    ).then((results) => {
      if (cancelled) {
        return;
      }
      const nextEntries = results.filter(
        (result): result is { nodeId: string; previewImageUrl: string } =>
          Boolean(result.previewImageUrl)
      );
      if (nextEntries.length === 0) {
        return;
      }
      setCapturedPreviewByNodeId((current) => ({
        ...current,
        ...Object.fromEntries(
          nextEntries.map((entry) => [entry.nodeId, entry.previewImageUrl])
        )
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [
    capturePreview,
    capturedPreviewByNodeId,
    dockPreviewCache,
    items,
    previewCaptureKey,
    resolveDockPreviewCacheKey
  ]);

  const content = (
    <div
      className="desktop-dock-popup-root"
      data-dock-placement={placement}
      data-desktop-dock-popup-root="true"
      data-popup-variant={resolvedVariant}
      style={popupStyle}
    >
      <div
        aria-label={label}
        className={cn(
          "desktop-dock-popup relative origin-bottom rounded-lg border border-[var(--border-1)] bg-background-fronted p-3 text-[var(--text-primary)] shadow-panel motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2 motion-safe:duration-[175ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
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
                const previewImageUrl =
                  item.previewImageUrl ?? capturedPreviewByNodeId[item.node.id];
                return (
                  <WorkbenchHostDockPopupCard
                    key={item.node.id}
                    ref={registerCard(item.node.id)}
                    closeWindowLabel={closeWindowLabel}
                    item={item}
                    labelMode={resolvedLabelMode}
                    onCloseNode={onCloseNode}
                    onSelectNode={onSelectNode}
                    previewImageUrl={previewImageUrl}
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
              const previewImageUrl =
                item.previewImageUrl ?? capturedPreviewByNodeId[item.node.id];
              return (
                <WorkbenchHostDockPopupCard
                  key={item.node.id}
                  ref={registerCard(item.node.id)}
                  closeWindowLabel={closeWindowLabel}
                  item={item}
                  labelMode={resolvedLabelMode}
                  onCloseNode={onCloseNode}
                  onSelectNode={onSelectNode}
                  previewImageUrl={previewImageUrl}
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
      </div>
    </div>
  );

  if (typeof document === "undefined" || !document.body) {
    return content;
  }
  return createPortal(content, document.body);
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

interface WorkbenchHostDockPopupCardProps {
  closeWindowLabel: (title: string) => string;
  item: WorkbenchHostDockPopupItem;
  labelMode?: WorkbenchHostDockPopupCardLabelMode;
  onCloseNode: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  previewImageUrl?: string;
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
    previewImageUrl,
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

  return (
    <div
      ref={ref}
      className={cn(
        "group/dock-popup-card relative flex h-[103px] w-[165px] min-w-0 flex-col overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-background-fronted text-left text-[var(--text-primary)] transition-[border-color,color] duration-150",
        item.isFocused &&
          "border-transparent shadow-[inset_0_0_0_2px_var(--border-focus)]",
        item.isMinimized && "text-[var(--text-secondary)]"
      )}
      data-active={item.isFocused ? "true" : undefined}
      data-desktop-dock-popup-card="true"
      data-fan-card={isMinimizedStack ? "true" : undefined}
      data-launching={isLaunching ? "true" : undefined}
      data-minimized={item.isMinimized ? "true" : undefined}
      style={style}
    >
      <button
        aria-label={title}
        data-active={item.isFocused ? "true" : undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-transparent p-1 text-inherit"
        type="button"
        onClick={handleSelect}
      >
        {previewImageUrl ? (
          <span
            className="block min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-transparency-block"
            aria-hidden="true"
          >
            <img
              alt=""
              className="block h-full max-h-full w-full max-w-full object-contain object-center"
              draggable={false}
              src={previewImageUrl}
            />
          </span>
        ) : (
          <span
            className="flex size-full flex-col justify-center gap-[7px] rounded-md border border-[var(--border-1)] bg-transparency-block px-3 py-[11px]"
            aria-hidden="true"
          >
            <span className="block h-[7px] w-[72%] rounded-full bg-transparency-hover" />
            <span className="block h-[7px] w-[58%] rounded-full bg-transparency-hover" />
            <span className="block h-[7px] w-[34%] rounded-full bg-transparency-hover" />
          </span>
        )}
        {labelMode === "hover-overlay" && item.title?.trim() ? (
          <WorkbenchHostDockPopupCardLabel title={item.title} />
        ) : null}
      </button>
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
      {isMinimizedStack ? (
        <span className="desktop-dock-popup__fan-title-tip" title={title}>
          {title}
        </span>
      ) : null}
    </div>
  );
});

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
