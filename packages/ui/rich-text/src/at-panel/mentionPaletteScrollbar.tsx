import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import { cn } from "@tutti-os/ui-system/utils";

interface MentionPaletteScrollbarState {
  scrollable: boolean;
  thumbHeight: number;
  thumbTop: number;
}

interface MentionPaletteScrollbarDragState {
  maxScrollTop: number;
  maxThumbTop: number;
  startClientY: number;
  startScrollTop: number;
}

const MENTION_PALETTE_SCROLLBAR_MIN_THUMB_HEIGHT = 24;
const MENTION_PALETTE_SCROLLBAR_HIDDEN_STATE: MentionPaletteScrollbarState = {
  scrollable: false,
  thumbHeight: 0,
  thumbTop: 0
};

export function MentionPaletteScrollbar({
  scrollBodyRef,
  className,
  thumbClassName,
  testId
}: {
  scrollBodyRef: RefObject<HTMLDivElement | null>;
  className: string;
  thumbClassName: string;
  testId: string;
}): JSX.Element {
  "use memo";
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<MentionPaletteScrollbarDragState | null>(null);
  const [scrollbarState, setScrollbarState] =
    useState<MentionPaletteScrollbarState>({
      scrollable: false,
      thumbHeight: 0,
      thumbTop: 0
    });
  const [dragging, setDragging] = useState(false);

  const hideScrollbar = useCallback((): void => {
    setScrollbarState((previous) =>
      previous.scrollable ||
      previous.thumbHeight !== 0 ||
      previous.thumbTop !== 0
        ? MENTION_PALETTE_SCROLLBAR_HIDDEN_STATE
        : previous
    );
  }, []);

  const syncScrollbarState = useCallback((): void => {
    const contentElement = scrollBodyRef.current;
    if (!contentElement) {
      hideScrollbar();
      return;
    }

    const { scrollHeight, scrollTop, clientHeight } = contentElement;
    const measuredTrackHeight = trackRef.current?.clientHeight ?? 0;
    const trackHeight =
      measuredTrackHeight > 0 ? measuredTrackHeight : clientHeight;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);

    if (clientHeight <= 0 || trackHeight <= 0 || maxScrollTop <= 0) {
      hideScrollbar();
      return;
    }

    const thumbHeight = Math.max(
      MENTION_PALETTE_SCROLLBAR_MIN_THUMB_HEIGHT,
      Math.round((clientHeight / scrollHeight) * trackHeight)
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = Math.round((scrollTop / maxScrollTop) * maxThumbTop);
    setScrollbarState((previous) =>
      previous.scrollable &&
      previous.thumbHeight === thumbHeight &&
      previous.thumbTop === thumbTop
        ? previous
        : { scrollable: true, thumbHeight, thumbTop }
    );
  }, [hideScrollbar, scrollBodyRef]);

  useEffect(() => {
    const contentElement = scrollBodyRef.current;
    if (!contentElement) {
      hideScrollbar();
      return;
    }

    syncScrollbarState();
    contentElement.addEventListener("scroll", syncScrollbarState, {
      passive: true
    });
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncScrollbarState)
        : null;
    resizeObserver?.observe(contentElement);
    if (trackRef.current) {
      resizeObserver?.observe(trackRef.current);
    }
    const animationFrameId = window.requestAnimationFrame(syncScrollbarState);
    return () => {
      contentElement.removeEventListener("scroll", syncScrollbarState);
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [hideScrollbar, scrollBodyRef, syncScrollbarState]);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const handleMouseMove = (event: MouseEvent): void => {
      const contentElement = scrollBodyRef.current;
      const dragState = dragStateRef.current;
      if (!contentElement || !dragState || dragState.maxThumbTop <= 0) {
        return;
      }
      const delta = event.clientY - dragState.startClientY;
      const nextThumbTop =
        (dragState.startScrollTop / dragState.maxScrollTop) *
          dragState.maxThumbTop +
        delta;
      contentElement.scrollTop =
        (Math.min(Math.max(0, nextThumbTop), dragState.maxThumbTop) /
          dragState.maxThumbTop) *
        dragState.maxScrollTop;
      syncScrollbarState();
    };

    const handleMouseUp = (): void => {
      dragStateRef.current = null;
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, scrollBodyRef, syncScrollbarState]);

  const scrollContentToThumbTop = (thumbTop: number): void => {
    const contentElement = scrollBodyRef.current;
    const trackElement = trackRef.current;
    if (!contentElement || !trackElement) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      contentElement.scrollHeight - contentElement.clientHeight
    );
    const maxThumbTop = Math.max(
      0,
      trackElement.clientHeight - scrollbarState.thumbHeight
    );
    if (maxScrollTop <= 0 || maxThumbTop <= 0) {
      return;
    }
    contentElement.scrollTop =
      (Math.min(Math.max(0, thumbTop), maxThumbTop) / maxThumbTop) *
      maxScrollTop;
    syncScrollbarState();
  };

  const handleTrackMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>
  ): void => {
    if (
      event.button !== 0 ||
      !scrollbarState.scrollable ||
      event.target !== event.currentTarget
    ) {
      return;
    }
    event.preventDefault();
    const trackRect = event.currentTarget.getBoundingClientRect();
    scrollContentToThumbTop(
      event.clientY - trackRect.top - scrollbarState.thumbHeight / 2
    );
  };

  const handleThumbMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>
  ): void => {
    if (event.button !== 0 || !scrollbarState.scrollable) {
      return;
    }
    const contentElement = scrollBodyRef.current;
    const trackElement = trackRef.current;
    if (!contentElement || !trackElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      maxScrollTop: Math.max(
        0,
        contentElement.scrollHeight - contentElement.clientHeight
      ),
      maxThumbTop: Math.max(
        0,
        trackElement.clientHeight - scrollbarState.thumbHeight
      ),
      startClientY: event.clientY,
      startScrollTop: contentElement.scrollTop
    };
    setDragging(true);
  };

  if (!scrollbarState.scrollable && !dragging) {
    return <div ref={trackRef} className="hidden" aria-hidden="true" />;
  }

  return (
    <div
      ref={trackRef}
      className={cn("group/status-scrollbar", className)}
      data-scrollable={scrollbarState.scrollable ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-testid={testId}
      aria-hidden="true"
      onMouseDown={handleTrackMouseDown}
    >
      <div
        className={thumbClassName}
        onMouseDown={handleThumbMouseDown}
        style={{
          height: `${scrollbarState.thumbHeight}px`,
          transform: `translateY(${scrollbarState.thumbTop}px)`
        }}
      />
    </div>
  );
}
