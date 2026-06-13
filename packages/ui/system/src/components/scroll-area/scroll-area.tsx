import * as React from "react";

import { cn } from "#lib/utils";

const MIN_THUMB_SIZE_PX = 24;

type ScrollAreaType = "auto" | "always" | "scroll" | "hover";
type ScrollAreaOrientation = "vertical" | "horizontal";

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  scrollbarMode?: "custom" | "native";
  scrollHideDelay?: number;
  type?: ScrollAreaType;
  viewportClassName?: string;
  viewportContentStyle?: React.CSSProperties;
  viewportProps?: Omit<
    React.ComponentPropsWithoutRef<"div">,
    "children" | "className" | "ref"
  >;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportTestId?: string;
};

type ScrollBarProps = React.HTMLAttributes<HTMLDivElement> & {
  forceMount?: true;
  orientation?: ScrollAreaOrientation;
};

type ScrollAreaImplementationProps = Omit<
  ScrollAreaProps,
  "scrollbarMode" | "scrollHideDelay"
> & {
  scrollbarMode: NonNullable<ScrollAreaProps["scrollbarMode"]>;
};

type ScrollbarDragState = {
  maxScrollOffset: number;
  maxThumbOffset: number;
  startClientOffset: number;
  startScrollOffset: number;
};

function ScrollArea({
  className,
  children,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  scrollbarMode = "custom",
  scrollHideDelay: _scrollHideDelay,
  type,
  viewportClassName,
  viewportContentStyle,
  viewportProps,
  viewportRef,
  viewportTestId,
  ...props
}: ScrollAreaProps) {
  const implementationProps = {
    className,
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    scrollbarMode,
    type,
    viewportClassName,
    viewportContentStyle,
    viewportProps,
    viewportRef,
    viewportTestId,
    ...props
  } satisfies ScrollAreaImplementationProps;

  if (scrollbarMode === "native") {
    return (
      <NativeScrollArea {...implementationProps}>{children}</NativeScrollArea>
    );
  }

  return (
    <CustomScrollArea {...implementationProps}>{children}</CustomScrollArea>
  );
}

function NativeScrollArea({
  className,
  children,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  scrollbarMode,
  type,
  viewportClassName,
  viewportContentStyle,
  viewportProps,
  viewportRef,
  viewportTestId,
  ...props
}: ScrollAreaImplementationProps) {
  const alwaysVisible =
    type === "always" ||
    type === "scroll" ||
    hasAlwaysVisibleScrollbarSelector(className);

  return (
    <ScrollAreaFrame
      {...props}
      className={className}
      data-scrollbar-mode={scrollbarMode}
      onBlur={onBlur}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      alwaysVisible={false}
      viewportClassName={cn(
        nativeScrollbarClassName(alwaysVisible),
        viewportClassName
      )}
      viewportContentStyle={viewportContentStyle}
      viewportProps={viewportProps}
      viewportRef={viewportRef}
      viewportTestId={viewportTestId}
    >
      {children}
    </ScrollAreaFrame>
  );
}

function CustomScrollArea({
  className,
  children,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  scrollbarMode,
  type,
  viewportClassName,
  viewportContentStyle,
  viewportProps,
  viewportRef,
  viewportTestId,
  ...props
}: ScrollAreaImplementationProps) {
  const localViewportRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [active, setActive] = React.useState(false);

  const alwaysVisible =
    type === "always" ||
    type === "scroll" ||
    hasAlwaysVisibleScrollbarSelector(className);

  return (
    <ScrollAreaFrame
      {...props}
      className={className}
      contentRef={contentRef}
      data-scrollbar-mode={scrollbarMode}
      onBlur={(event) => {
        onBlur?.(event);
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setActive(false);
        }
      }}
      onFocus={(event) => {
        onFocus?.(event);
        setActive(true);
      }}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        setActive(true);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        setActive(false);
      }}
      alwaysVisible={alwaysVisible}
      viewportClassName={cn(
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        viewportClassName
      )}
      viewportContentStyle={viewportContentStyle}
      viewportProps={viewportProps}
      viewportRef={setRefs(localViewportRef, viewportRef)}
      viewportTestId={viewportTestId}
    >
      {children}
      <ScrollAreaScrollbar
        active={active || alwaysVisible}
        contentRef={contentRef}
        orientation="vertical"
        viewportRef={localViewportRef}
      />
    </ScrollAreaFrame>
  );
}

function ScrollAreaFrame({
  alwaysVisible,
  children,
  className,
  contentRef,
  viewportClassName,
  viewportContentStyle,
  viewportProps,
  viewportRef,
  viewportTestId,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  alwaysVisible: boolean;
  contentRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  viewportContentStyle?: React.CSSProperties;
  viewportProps?: ScrollAreaProps["viewportProps"];
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportTestId?: string;
}) {
  return (
    <div
      data-slot="scroll-area"
      className={cn(
        "group/scroll-area relative",
        alwaysVisible
          ? "[&_[data-slot=scroll-area-scrollbar]]:opacity-100"
          : null,
        className
      )}
      {...props}
    >
      <div
        {...viewportProps}
        data-slot="scroll-area-viewport"
        data-testid={viewportTestId}
        ref={viewportRef}
        className={cn(
          "size-full overflow-auto rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
      >
        <div
          ref={contentRef}
          data-slot="scroll-area-content"
          style={{
            minWidth: "100%",
            display: "block",
            ...viewportContentStyle
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function ScrollAreaScrollbar({
  active,
  contentRef,
  orientation,
  viewportRef
}: {
  active: boolean;
  contentRef: React.RefObject<HTMLElement | null>;
  orientation: ScrollAreaOrientation;
  viewportRef: React.RefObject<HTMLElement | null>;
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const thumbRef = React.useRef<HTMLDivElement | null>(null);
  const dragStateRef = React.useRef<ScrollbarDragState | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const scrollableRef = React.useRef(false);
  const [dragging, setDragging] = React.useState(false);
  const [scrollable, setScrollable] = React.useState(false);
  const [trackActive, setTrackActive] = React.useState(false);

  const syncScrollbarState = React.useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) {
      updateScrollable(false, scrollableRef, setScrollable);
      return;
    }

    const viewportSize =
      orientation === "vertical" ? viewport.clientHeight : viewport.clientWidth;
    const scrollSize =
      orientation === "vertical" ? viewport.scrollHeight : viewport.scrollWidth;
    const scrollOffset =
      orientation === "vertical" ? viewport.scrollTop : viewport.scrollLeft;
    const trackSize =
      orientation === "vertical" ? track.clientHeight : track.clientWidth;
    const maxScrollOffset = Math.max(0, scrollSize - viewportSize);
    if (viewportSize <= 0 || trackSize <= 0 || maxScrollOffset <= 0) {
      updateScrollable(false, scrollableRef, setScrollable);
      return;
    }

    const thumbSize = Math.min(
      trackSize,
      Math.max(
        MIN_THUMB_SIZE_PX,
        Math.round((viewportSize / scrollSize) * trackSize)
      )
    );
    const maxThumbOffset = Math.max(0, trackSize - thumbSize);
    const thumbOffset = Math.round(
      (scrollOffset / maxScrollOffset) * maxThumbOffset
    );

    if (orientation === "vertical") {
      thumb.style.height = `${thumbSize}px`;
      thumb.style.width = "";
      thumb.style.transform = `translateY(${thumbOffset}px)`;
    } else {
      thumb.style.width = `${thumbSize}px`;
      thumb.style.height = "";
      thumb.style.transform = `translateX(${thumbOffset}px)`;
    }

    updateScrollable(true, scrollableRef, setScrollable);
  }, [orientation, viewportRef]);

  const scheduleSync = React.useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }

    frameRef.current = requestAnimationFrameSafely(() => {
      frameRef.current = null;
      syncScrollbarState();
    });
  }, [syncScrollbarState]);

  const scrollViewportToThumbOffset = React.useCallback(
    (thumbOffset: number) => {
      const viewport = viewportRef.current;
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!viewport || !track || !thumb) {
        return;
      }

      const viewportSize =
        orientation === "vertical"
          ? viewport.clientHeight
          : viewport.clientWidth;
      const scrollSize =
        orientation === "vertical"
          ? viewport.scrollHeight
          : viewport.scrollWidth;
      const trackSize =
        orientation === "vertical" ? track.clientHeight : track.clientWidth;
      const thumbSize =
        orientation === "vertical" ? thumb.offsetHeight : thumb.offsetWidth;
      const maxScrollOffset = Math.max(0, scrollSize - viewportSize);
      const maxThumbOffset = Math.max(0, trackSize - thumbSize);
      if (maxScrollOffset <= 0 || maxThumbOffset <= 0) {
        return;
      }

      const nextScrollOffset =
        (clamp(thumbOffset, 0, maxThumbOffset) / maxThumbOffset) *
        maxScrollOffset;
      if (orientation === "vertical") {
        viewport.scrollTop = nextScrollOffset;
      } else {
        viewport.scrollLeft = nextScrollOffset;
      }
      syncScrollbarState();
    },
    [orientation, syncScrollbarState, viewportRef]
  );

  const handleTrackPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !scrollableRef.current) {
        return;
      }

      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!track || !thumb || event.target === thumb) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const trackRect = track.getBoundingClientRect();
      const clientOffset =
        orientation === "vertical" ? event.clientY : event.clientX;
      const trackStart =
        orientation === "vertical" ? trackRect.top : trackRect.left;
      const thumbSize =
        orientation === "vertical" ? thumb.offsetHeight : thumb.offsetWidth;
      scrollViewportToThumbOffset(clientOffset - trackStart - thumbSize / 2);
    },
    [orientation, scrollViewportToThumbOffset]
  );

  const handleThumbPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !scrollableRef.current) {
        return;
      }

      const viewport = viewportRef.current;
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!viewport || !track || !thumb) {
        return;
      }

      const viewportSize =
        orientation === "vertical"
          ? viewport.clientHeight
          : viewport.clientWidth;
      const scrollSize =
        orientation === "vertical"
          ? viewport.scrollHeight
          : viewport.scrollWidth;
      const trackSize =
        orientation === "vertical" ? track.clientHeight : track.clientWidth;
      const thumbSize =
        orientation === "vertical" ? thumb.offsetHeight : thumb.offsetWidth;
      const maxScrollOffset = Math.max(0, scrollSize - viewportSize);
      const maxThumbOffset = Math.max(0, trackSize - thumbSize);
      if (maxScrollOffset <= 0 || maxThumbOffset <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      dragStateRef.current = {
        maxScrollOffset,
        maxThumbOffset,
        startClientOffset:
          orientation === "vertical" ? event.clientY : event.clientX,
        startScrollOffset:
          orientation === "vertical" ? viewport.scrollTop : viewport.scrollLeft
      };
      setDragging(true);
    },
    [orientation, viewportRef]
  );

  React.useEffect(() => {
    if (!dragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const dragState = dragStateRef.current;
      const viewport = viewportRef.current;
      if (!dragState || !viewport) {
        return;
      }

      const clientOffset =
        orientation === "vertical" ? event.clientY : event.clientX;
      const nextThumbOffset =
        (dragState.startScrollOffset / dragState.maxScrollOffset) *
          dragState.maxThumbOffset +
        (clientOffset - dragState.startClientOffset);
      const nextScrollOffset =
        (clamp(nextThumbOffset, 0, dragState.maxThumbOffset) /
          dragState.maxThumbOffset) *
        dragState.maxScrollOffset;

      if (orientation === "vertical") {
        viewport.scrollTop = nextScrollOffset;
      } else {
        viewport.scrollLeft = nextScrollOffset;
      }
      syncScrollbarState();
    };

    const handlePointerUp = (): void => {
      dragStateRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragging, orientation, syncScrollbarState, viewportRef]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      updateScrollable(false, scrollableRef, setScrollable);
      return;
    }

    syncScrollbarState();
    viewport.addEventListener("scroll", scheduleSync, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleSync)
        : null;
    resizeObserver?.observe(viewport);
    if (contentRef.current) {
      resizeObserver?.observe(contentRef.current);
    }

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrameSafely(frameRef.current);
        frameRef.current = null;
      }
      viewport.removeEventListener("scroll", scheduleSync);
      resizeObserver?.disconnect();
    };
  }, [contentRef, scheduleSync, syncScrollbarState, viewportRef]);

  React.useEffect(() => {
    scheduleSync();
  });

  return (
    <div
      ref={trackRef}
      data-dragging={dragging ? "true" : "false"}
      data-orientation={orientation}
      data-scrollable={scrollable ? "true" : "false"}
      data-slot="scroll-area-scrollbar"
      aria-hidden="true"
      className={scrollbarClassName(orientation)}
      style={scrollbarStyle({
        active: active || dragging,
        orientation,
        scrollable
      })}
      onPointerEnter={() => setTrackActive(true)}
      onPointerLeave={() => setTrackActive(false)}
      onPointerDown={handleTrackPointerDown}
    >
      <div
        ref={thumbRef}
        data-slot="scroll-area-thumb"
        className={thumbClassName(orientation)}
        style={thumbStyle({ active: trackActive || dragging, orientation })}
        onPointerDown={handleThumbPointerDown}
      />
    </div>
  );
}

function ScrollBar({
  className,
  forceMount: _forceMount,
  orientation = "vertical",
  ...props
}: ScrollBarProps) {
  return (
    <div
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      className={cn(scrollbarClassName(orientation), className)}
      style={scrollbarStyle({ active: false, orientation, scrollable: true })}
      {...props}
    >
      <div
        data-slot="scroll-area-thumb"
        className={thumbClassName(orientation)}
        style={thumbStyle({ active: false, orientation })}
      />
    </div>
  );
}

function scrollbarClassName(orientation: ScrollAreaOrientation): string {
  return cn(
    orientation === "horizontal"
      ? "data-[orientation=horizontal]:h-2"
      : "data-[orientation=vertical]:w-2"
  );
}

function thumbClassName(orientation: ScrollAreaOrientation): string {
  return cn(
    "rounded-full",
    orientation === "horizontal"
      ? "top-[2px] bottom-[2px]"
      : "right-[2px] left-[2px]"
  );
}

function nativeScrollbarClassName(alwaysVisible: boolean): string {
  return cn(
    "[scrollbar-width:thin] [scrollbar-color:transparent_transparent]",
    "[&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2",
    "[&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent",
    "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content",
    alwaysVisible
      ? "[scrollbar-color:var(--transparency-block)_transparent] [&::-webkit-scrollbar-thumb]:bg-[var(--transparency-block)] hover:[&::-webkit-scrollbar-thumb]:bg-[var(--transparency-hover)]"
      : "hover:[scrollbar-color:var(--transparency-block)_transparent] focus-within:[scrollbar-color:var(--transparency-block)_transparent] hover:[&::-webkit-scrollbar-thumb]:bg-[var(--transparency-block)] focus-within:[&::-webkit-scrollbar-thumb]:bg-[var(--transparency-block)]"
  );
}

function scrollbarStyle({
  active,
  orientation,
  scrollable
}: {
  active: boolean;
  orientation: ScrollAreaOrientation;
  scrollable: boolean;
}): React.CSSProperties {
  return {
    position: "absolute",
    zIndex: 10,
    display: "flex",
    touchAction: "none",
    padding: 2,
    opacity: active && scrollable ? 1 : 0,
    pointerEvents: scrollable ? "auto" : "none",
    userSelect: "none",
    transition: "opacity 150ms ease-in-out",
    cursor: "pointer",
    ...(orientation === "horizontal"
      ? {
          right: 0,
          bottom: 0,
          left: 0,
          height: 8,
          flexDirection: "column"
        }
      : {
          top: 0,
          right: 0,
          bottom: 0,
          width: 8
        })
  };
}

function thumbStyle({
  active,
  orientation
}: {
  active: boolean;
  orientation: ScrollAreaOrientation;
}): React.CSSProperties {
  return {
    position: "absolute",
    minHeight: orientation === "vertical" ? MIN_THUMB_SIZE_PX : undefined,
    minWidth: orientation === "horizontal" ? MIN_THUMB_SIZE_PX : undefined,
    borderRadius: 999,
    background: active
      ? "var(--transparency-hover)"
      : "var(--transparency-block)",
    cursor: active ? "grabbing" : "grab",
    transition: "background-color 150ms ease-in-out",
    ...(orientation === "horizontal"
      ? {
          top: 2,
          bottom: 2
        }
      : {
          right: 2,
          left: 2
        })
  };
}

function hasAlwaysVisibleScrollbarSelector(
  className: ScrollAreaProps["className"]
): boolean {
  return (
    typeof className === "string" &&
    className.includes("scroll-area-scrollbar") &&
    className.includes("opacity-100")
  );
}

function setRefs<T>(
  localRef: React.MutableRefObject<T | null>,
  forwardedRef: React.Ref<T> | undefined
): (node: T | null) => void {
  return (node) => {
    localRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };
}

function updateScrollable(
  nextScrollable: boolean,
  scrollableRef: React.MutableRefObject<boolean>,
  setScrollable: React.Dispatch<React.SetStateAction<boolean>>
): void {
  if (scrollableRef.current === nextScrollable) {
    return;
  }

  scrollableRef.current = nextScrollable;
  setScrollable(nextScrollable);
}

function requestAnimationFrameSafely(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }

  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelAnimationFrameSafely(frameId: number): void {
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frameId);
    return;
  }

  window.clearTimeout(frameId);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export { ScrollArea, ScrollBar };
