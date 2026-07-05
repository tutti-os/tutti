import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../app/renderer/lib/utils";
import { DESKTOP_WINDOW_TOP_MARGIN } from "../../workspaceDesktop/constants";

const COMPOSER_MENU_GAP_PX = 8;
const COMPOSER_MENU_VIEWPORT_PADDING_PX = 8;
// Keep the menu clear of the workspace window's own header, where the macOS
// traffic lights live (see `workspaceWindowHeaderHeightPx` in
// apps/desktop/src/main/windows/workspaceWindow.ts and the matching
// `DESKTOP_WINDOW_TOP_MARGIN` reserve used to place node windows below that
// header). Anchors near the top of the canvas otherwise collapse this menu's
// top offset down to the bare viewport padding, landing it on top of the
// traffic lights and drag region.
const COMPOSER_MENU_TOP_SAFE_AREA_PX = DESKTOP_WINDOW_TOP_MARGIN;
const COMPOSER_MENU_MIN_HEIGHT_PX = 280;

export interface ComposerAnchoredMenuFrame {
  bottom: number;
  height: number;
  left: number;
  portalTarget: Element;
  top: number;
  width: number;
  zIndex: number | string;
}

export interface UseComposerAnchoredMenuFrameOptions {
  anchorRef: RefObject<HTMLElement | null>;
  maxHeight: number;
  open: boolean;
}

export type ComposerFloatingMenuPlacement = "fixed-height" | "dynamic-above";

export interface ComposerFloatingMenuSurfaceProps {
  anchorRef: RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  dismissBoundaryRef?: RefObject<HTMLElement | null>;
  maxHeight: number;
  onDismiss?: () => void;
  open: boolean;
  placement: ComposerFloatingMenuPlacement;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  testId: string;
}

function resolveComposerMenuPortalTarget(anchor: HTMLElement): Element {
  return (
    anchor.closest('[data-slot="viewport-menu-boundary"]') ??
    anchor.closest(
      "[data-workbench-window-id], [data-workspace-node-window-root='true']"
    ) ??
    document.body
  );
}

function resolveComposerMenuZIndex(anchor: HTMLElement): number | string {
  let current: HTMLElement | null = anchor;
  while (current) {
    if (
      current.matches(
        "[data-workbench-window-id], [data-workspace-node-window-root='true']"
      )
    ) {
      const windowZIndex = Number.parseInt(
        window.getComputedStyle(current).zIndex,
        10
      );
      if (Number.isFinite(windowZIndex)) {
        return windowZIndex + 1;
      }
    }
    current = current.parentElement;
  }
  return "var(--z-popover)";
}

function computeComposerAnchoredMenuFrame(
  anchor: HTMLElement,
  maxHeight: number
): ComposerAnchoredMenuFrame {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(
    0,
    Math.min(rect.width, viewportWidth - COMPOSER_MENU_VIEWPORT_PADDING_PX * 2)
  );
  const left = Math.max(
    COMPOSER_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      rect.left,
      viewportWidth - COMPOSER_MENU_VIEWPORT_PADDING_PX - width
    )
  );
  const availableAbove =
    rect.top - COMPOSER_MENU_GAP_PX - COMPOSER_MENU_TOP_SAFE_AREA_PX;
  const height =
    availableAbove >= maxHeight
      ? maxHeight
      : Math.max(
          COMPOSER_MENU_MIN_HEIGHT_PX,
          Math.min(maxHeight, availableAbove)
        );

  return {
    bottom: Math.max(
      COMPOSER_MENU_VIEWPORT_PADDING_PX,
      viewportHeight - rect.top + COMPOSER_MENU_GAP_PX
    ),
    height,
    left,
    portalTarget: resolveComposerMenuPortalTarget(anchor),
    top: Math.max(
      COMPOSER_MENU_TOP_SAFE_AREA_PX,
      Math.min(
        rect.top - COMPOSER_MENU_GAP_PX - height,
        viewportHeight - COMPOSER_MENU_VIEWPORT_PADDING_PX - height
      )
    ),
    width,
    zIndex: resolveComposerMenuZIndex(anchor)
  };
}

function sameComposerAnchoredMenuFrame(
  left: ComposerAnchoredMenuFrame | null,
  right: ComposerAnchoredMenuFrame
): boolean {
  return (
    left !== null &&
    left.portalTarget === right.portalTarget &&
    left.zIndex === right.zIndex &&
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5 &&
    Math.abs(left.bottom - right.bottom) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
  );
}

export function useComposerAnchoredMenuFrame({
  anchorRef,
  maxHeight,
  open
}: UseComposerAnchoredMenuFrameOptions): ComposerAnchoredMenuFrame | null {
  const [frame, setFrame] = useState<ComposerAnchoredMenuFrame | null>(null);

  const syncFrame = useCallback((): void => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === "undefined") {
      setFrame(null);
      return;
    }

    const nextFrame = computeComposerAnchoredMenuFrame(anchor, maxHeight);
    setFrame((previous) =>
      sameComposerAnchoredMenuFrame(previous, nextFrame) ? previous : nextFrame
    );
  }, [anchorRef, maxHeight]);

  useLayoutEffect(() => {
    if (!open) {
      setFrame(null);
      return;
    }

    syncFrame();
    const anchor = anchorRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncFrame);
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    window.addEventListener("resize", syncFrame);
    window.addEventListener("scroll", syncFrame, {
      capture: true,
      passive: true
    });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncFrame);
      window.removeEventListener("scroll", syncFrame, true);
    };
  }, [anchorRef, open, syncFrame]);

  return frame;
}

function assignRef<T>(ref: RefObject<T | null> | undefined, value: T | null) {
  if (ref) {
    ref.current = value;
  }
}

export const ComposerFloatingMenuSurface = forwardRef<
  HTMLDivElement,
  ComposerFloatingMenuSurfaceProps
>(function ComposerFloatingMenuSurface(
  {
    anchorRef,
    children,
    className,
    contentClassName,
    dismissBoundaryRef,
    maxHeight,
    onDismiss,
    open,
    placement,
    surfaceRef,
    testId
  },
  forwardedRef
): React.JSX.Element | null {
  const localSurfaceRef = useRef<HTMLDivElement | null>(null);
  const frame = useComposerAnchoredMenuFrame({
    anchorRef,
    maxHeight,
    open
  });

  const setSurfaceRef = useCallback(
    (node: HTMLDivElement | null): void => {
      localSurfaceRef.current = node;
      assignRef(surfaceRef, node);
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef, surfaceRef]
  );

  useEffect(() => {
    if (!open || !onDismiss) {
      return;
    }

    const isInsideMenu = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) {
        return false;
      }
      const boundaryRef = dismissBoundaryRef ?? anchorRef;
      return Boolean(
        boundaryRef.current?.contains(target) ||
        localSurfaceRef.current?.contains(target)
      );
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onDismiss();
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (isInsideMenu(event.target)) {
        return;
      }
      onDismiss();
    };

    const handleFocusIn = (event: FocusEvent): void => {
      if (isInsideMenu(event.target)) {
        return;
      }
      onDismiss();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [anchorRef, dismissBoundaryRef, onDismiss, open]);

  const style = useMemo<CSSProperties>(() => {
    const baseStyle: CSSProperties = {
      position: "fixed",
      left: `${frame?.left ?? 0}px`,
      width: `${frame?.width ?? 0}px`,
      maxWidth: `${frame?.width ?? 0}px`,
      overflow: "hidden",
      zIndex: frame?.zIndex ?? "var(--z-popover)"
    };
    if (placement === "fixed-height") {
      return {
        ...baseStyle,
        top: `${frame?.top ?? 0}px`,
        minHeight: `${COMPOSER_MENU_MIN_HEIGHT_PX}px`,
        height: `${frame?.height ?? maxHeight}px`,
        maxHeight: `${maxHeight}px`
      };
    }
    return {
      ...baseStyle,
      bottom: `${frame?.bottom ?? 0}px`,
      maxHeight: `${frame?.height ?? maxHeight}px`
    };
  }, [frame, maxHeight, placement]);

  if (!open || typeof document === "undefined" || !document.body) {
    return null;
  }

  const portalTarget =
    frame?.portalTarget ??
    (anchorRef.current
      ? resolveComposerMenuPortalTarget(anchorRef.current)
      : document.body);

  return createPortal(
    <div
      data-testid={testId}
      ref={setSurfaceRef}
      className={cn(
        "nodrag isolate rounded-[12px] border border-hairline bg-background-fronted p-[4px] text-foreground shadow-[var(--tsh-shell-shadow)] [-webkit-app-region:no-drag]",
        "overflow-hidden",
        className
      )}
      style={style}
    >
      {contentClassName ? (
        <div className={contentClassName}>{children}</div>
      ) : (
        children
      )}
    </div>,
    portalTarget
  );
});
