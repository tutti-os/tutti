import {
  cancelUiAnimationFrame,
  requestUiAnimationFrame
} from "./agentTranscriptPresentationScheduler";

const AGENT_TRANSCRIPT_SCROLL_DURATION_MS = 260;
const AGENT_TRANSCRIPT_SCROLL_INTENT_TIMEOUT_MS = 1_000;
export const AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX = 64;
const AGENT_TRANSCRIPT_WHEEL_LINE_HEIGHT_PX = 16;

export type AgentTranscriptUserScrollDirection = "away" | "toward-end";

export interface AgentTranscriptScrollPadding {
  bottom: number;
  top: number;
}

interface ActiveScroll {
  animationFrameId: number;
}

const activeScrollByElement = new WeakMap<HTMLElement, ActiveScroll>();

export function normalizeAgentTranscriptWheelDelta(
  event: Pick<WheelEvent, "deltaMode" | "deltaY">,
  viewportHeightPx: number
): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * AGENT_TRANSCRIPT_WHEEL_LINE_HEIGHT_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewportHeightPx;
  }
  return event.deltaY;
}

export function agentTranscriptKeyboardScrollDirection(
  event: Pick<
    KeyboardEvent,
    "defaultPrevented" | "key" | "repeat" | "shiftKey"
  >,
  scrollElement: HTMLElement,
  target: EventTarget | null
): AgentTranscriptUserScrollDirection | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (target instanceof HTMLElement && target !== scrollElement) {
    if (
      target.isContentEditable ||
      target.closest("input, select, textarea") ||
      ((event.key === " " || event.key === "Spacebar") &&
        target.closest('button, [role="button"]'))
    ) {
      return null;
    }
  }
  switch (event.key) {
    case "ArrowUp":
    case "Home":
    case "PageUp":
      return "away";
    case " ":
    case "Spacebar":
      return event.shiftKey ? "away" : "toward-end";
    case "ArrowDown":
    case "End":
    case "PageDown":
      return "toward-end";
    default:
      return null;
  }
}

export function nativeAgentTranscriptDistanceFromBottom(
  scrollTopPx: number
): number {
  return Math.max(0, -scrollTopPx);
}

export function agentTranscriptDistanceFromBottom(
  scrollTopPx: number,
  _scrollPaddingBottomPx: number
): number {
  return nativeAgentTranscriptDistanceFromBottom(scrollTopPx);
}

export function agentTranscriptNativeScrollTopForDistance(
  distanceFromBottomPx: number,
  _scrollPaddingBottomPx: number
): number {
  const distance = Math.max(0, distanceFromBottomPx);
  return distance === 0 ? 0 : -distance;
}

export function agentTranscriptDistanceFromTop(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">
): number {
  return Math.max(
    0,
    element.scrollHeight -
      element.clientHeight -
      nativeAgentTranscriptDistanceFromBottom(element.scrollTop)
  );
}

export function agentTranscriptLogicalScrollTop(
  nativeScrollTopPx: number,
  viewportHeightPx: number,
  scrollMarginPx: number,
  totalHeightPx: number,
  scrollPaddingBottomPx: number
): number {
  return Math.max(
    0,
    scrollMarginPx +
      totalHeightPx -
      viewportHeightPx -
      nativeAgentTranscriptDistanceFromBottom(nativeScrollTopPx) +
      scrollPaddingBottomPx
  );
}

export function readAgentTranscriptScrollPadding(
  scrollElement: HTMLElement
): AgentTranscriptScrollPadding {
  const style = window.getComputedStyle(scrollElement);
  const bottom = Number.parseFloat(style.scrollPaddingBottom);
  const top = Number.parseFloat(style.scrollPaddingTop);
  return {
    bottom: Number.isFinite(bottom) ? Math.max(0, bottom) : 0,
    top: Number.isFinite(top) ? Math.max(0, top) : 0
  };
}

export function agentTranscriptDistanceForTarget(input: {
  align: "center" | "top";
  scrollElement: HTMLElement;
  scrollPadding: AgentTranscriptScrollPadding;
  target: HTMLElement;
  viewportHeightPx: number;
}): number {
  const { align, scrollElement, scrollPadding, target, viewportHeightPx } =
    input;
  const targetRect = target.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  const visibleTop = scrollRect.top + scrollPadding.top;
  const visibleHeight = Math.max(
    0,
    viewportHeightPx - scrollPadding.top - scrollPadding.bottom
  );
  const targetDelta =
    align === "top"
      ? targetRect.top - visibleTop
      : targetRect.top +
        targetRect.height / 2 -
        (visibleTop + visibleHeight / 2);
  return agentTranscriptDistanceFromBottom(
    Math.min(0, scrollElement.scrollTop + targetDelta),
    scrollPadding.bottom
  );
}

export function connectAgentTranscriptScrollInput(input: {
  element: HTMLElement;
  getViewportHeightPx(): number;
  onCancelLayoutPreservation?(): void;
  onDirection(direction: AgentTranscriptUserScrollDirection): void;
  onUserScrollToTop?(): void;
  onScroll(): {
    nextDistanceFromBottomPx: number;
    previousDistanceFromBottomPx: number;
  } | null;
  onWheelDelta?(deltaPx: number): void;
}): () => void {
  const {
    element,
    getViewportHeightPx,
    onCancelLayoutPreservation,
    onDirection,
    onScroll,
    onUserScrollToTop,
    onWheelDelta
  } = input;
  let directionIntent: {
    direction: AgentTranscriptUserScrollDirection;
    lastAtMs: number;
  } | null = null;
  let pointerSnapshot: {
    scrollHeightPx: number;
    scrollTopPx: number;
  } | null = null;
  let touchStart: {
    identifier: number;
    x: number;
    y: number;
  } | null = null;
  const recordDirectionIntent = (
    direction: AgentTranscriptUserScrollDirection
  ): void => {
    cancelAgentTranscriptScroll(element);
    const canMove =
      direction === "away"
        ? agentTranscriptDistanceFromTop(element) > 0
        : nativeAgentTranscriptDistanceFromBottom(element.scrollTop) > 0;
    directionIntent = canMove
      ? { direction, lastAtMs: performance.now() }
      : null;
  };
  const captureWheelIntent = (event: WheelEvent): void => {
    const delta = normalizeAgentTranscriptWheelDelta(
      event,
      getViewportHeightPx()
    );
    if (delta !== 0) {
      onWheelDelta?.(delta);
      if (delta < 0 && agentTranscriptDistanceFromTop(element) <= 0) {
        onUserScrollToTop?.();
      }
      recordDirectionIntent(delta < 0 ? "away" : "toward-end");
    }
  };
  const captureKeyboardIntent = (event: KeyboardEvent): void => {
    const direction = agentTranscriptKeyboardScrollDirection(
      event,
      element,
      event.target
    );
    if (direction) {
      onCancelLayoutPreservation?.();
      recordDirectionIntent(direction);
    }
  };
  const capturePointerIntent = (event: PointerEvent): void => {
    pointerSnapshot = null;
    directionIntent = null;
    if (event.pointerType !== "mouse" || event.target !== element) return;
    onCancelLayoutPreservation?.();
    cancelAgentTranscriptScroll(element);
    pointerSnapshot = {
      scrollHeightPx: element.scrollHeight,
      scrollTopPx: element.scrollTop
    };
  };
  const clearPointerIntent = (): void => {
    pointerSnapshot = null;
  };
  const captureTouchStart = (event: TouchEvent): void => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    touchStart = touch
      ? {
          identifier: touch.identifier,
          x: touch.clientX,
          y: touch.clientY
        }
      : null;
  };
  const captureTouchMove = (event: TouchEvent): void => {
    const start = touchStart;
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!start || !touch || touch.identifier !== start.identifier) {
      touchStart = null;
      return;
    }
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (
      Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8 ||
      Math.abs(deltaY) <= Math.abs(deltaX)
    ) {
      return;
    }
    touchStart = null;
    const direction = deltaY > 0 ? "away" : "toward-end";
    onCancelLayoutPreservation?.();
    recordDirectionIntent(direction);
    if (
      deltaY > Math.abs(deltaX) &&
      agentTranscriptDistanceFromTop(element) <= 0
    ) {
      onUserScrollToTop?.();
    }
  };
  const clearTouchIntent = (): void => {
    touchStart = null;
  };
  const captureSemanticScrollAwayIntent = (event: MouseEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-agent-transcript-scroll-away-intent]")
    ) {
      onCancelLayoutPreservation?.();
      cancelAgentTranscriptScroll(element);
      onDirection("away");
    }
  };
  const captureScroll = (): void => {
    const pointer = pointerSnapshot;
    pointerSnapshot = null;
    const change = onScroll();
    if (!change) return;
    if (
      pointer &&
      element.scrollHeight === pointer.scrollHeightPx &&
      element.scrollTop !== pointer.scrollTopPx &&
      change.nextDistanceFromBottomPx !== change.previousDistanceFromBottomPx
    ) {
      directionIntent = {
        direction:
          change.nextDistanceFromBottomPx > change.previousDistanceFromBottomPx
            ? "away"
            : "toward-end",
        lastAtMs: performance.now()
      };
    }
    const intent = directionIntent;
    if (!intent) return;
    const now = performance.now();
    if (now - intent.lastAtMs > AGENT_TRANSCRIPT_SCROLL_INTENT_TIMEOUT_MS) {
      directionIntent = null;
      return;
    }
    const actualDirection =
      change.nextDistanceFromBottomPx > change.previousDistanceFromBottomPx
        ? "away"
        : change.nextDistanceFromBottomPx < change.previousDistanceFromBottomPx
          ? "toward-end"
          : null;
    if (actualDirection !== intent.direction) return;
    intent.lastAtMs = now;
    onDirection(actualDirection);
    if (
      actualDirection === "away" &&
      agentTranscriptDistanceFromTop(element) <=
        AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX
    ) {
      onUserScrollToTop?.();
    }
    if (change.nextDistanceFromBottomPx === 0) {
      directionIntent = null;
    }
  };

  element.addEventListener("wheel", captureWheelIntent, { passive: true });
  element.addEventListener("keydown", captureKeyboardIntent);
  element.addEventListener("click", captureSemanticScrollAwayIntent);
  element.addEventListener("scroll", captureScroll, { passive: true });
  element.addEventListener("pointerdown", capturePointerIntent, {
    passive: true
  });
  element.addEventListener("touchstart", captureTouchStart, { passive: true });
  element.addEventListener("touchmove", captureTouchMove, { passive: true });
  element.addEventListener("touchend", clearTouchIntent, { passive: true });
  element.addEventListener("touchcancel", clearTouchIntent, { passive: true });
  element.addEventListener("pointerup", clearPointerIntent, { passive: true });
  element.addEventListener("pointercancel", clearPointerIntent, {
    passive: true
  });

  return () => {
    cancelAgentTranscriptScroll(element);
    element.removeEventListener("wheel", captureWheelIntent);
    element.removeEventListener("keydown", captureKeyboardIntent);
    element.removeEventListener("click", captureSemanticScrollAwayIntent);
    element.removeEventListener("scroll", captureScroll);
    element.removeEventListener("pointerdown", capturePointerIntent);
    element.removeEventListener("touchstart", captureTouchStart);
    element.removeEventListener("touchmove", captureTouchMove);
    element.removeEventListener("touchend", clearTouchIntent);
    element.removeEventListener("touchcancel", clearTouchIntent);
    element.removeEventListener("pointerup", clearPointerIntent);
    element.removeEventListener("pointercancel", clearPointerIntent);
  };
}

export function cancelAgentTranscriptScroll(element: HTMLElement): void {
  const activeScroll = activeScrollByElement.get(element);
  if (!activeScroll) return;
  cancelUiAnimationFrame(activeScroll.animationFrameId);
  activeScrollByElement.delete(element);
}

export function hasActiveAgentTranscriptScroll(element: HTMLElement): boolean {
  return activeScrollByElement.has(element);
}

export function setAgentTranscriptScrollTop(
  element: HTMLElement,
  top: number,
  behavior: ScrollBehavior = "auto",
  onPositionChange?: () => void
): void {
  cancelAgentTranscriptScroll(element);
  const targetTop = Number.isFinite(top) ? top : 0;
  if (
    behavior !== "smooth" ||
    typeof window.requestAnimationFrame !== "function" ||
    prefersReducedMotion()
  ) {
    element.scrollTop = targetTop;
    onPositionChange?.();
    return;
  }

  const startTop = element.scrollTop;
  const delta = targetTop - startTop;
  if (Math.abs(delta) <= 1) {
    element.scrollTop = targetTop;
    onPositionChange?.();
    return;
  }

  const startedAt = performance.now();
  const activeScroll: ActiveScroll = { animationFrameId: 0 };
  const step = (now: number): void => {
    if (activeScrollByElement.get(element) !== activeScroll) return;
    const progress = Math.min(
      1,
      Math.max(0, (now - startedAt) / AGENT_TRANSCRIPT_SCROLL_DURATION_MS)
    );
    const easedProgress = 1 - Math.pow(1 - progress, 3);
    element.scrollTop = startTop + delta * easedProgress;
    if (progress >= 1) {
      element.scrollTop = targetTop;
      onPositionChange?.();
      activeScrollByElement.delete(element);
      return;
    }
    onPositionChange?.();
    // presentation-work: animate the visible timeline with an interruptible frame
    activeScroll.animationFrameId = requestUiAnimationFrame(step);
  };

  activeScroll.animationFrameId = requestUiAnimationFrame(step);
  activeScrollByElement.set(element, activeScroll);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
