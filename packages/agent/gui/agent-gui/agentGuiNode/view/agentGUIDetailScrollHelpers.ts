import type { RefObject } from "react";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import styles from "../AgentGUINode.styles";

export interface TimelineGeometry {
  clientHeight: number;
  maxScrollTop: number;
  scrollHeight: number;
}

export interface BottomDockSafeArea {
  bottomDock: HTMLDivElement;
  floatingOverflowHeight: number;
  revision: string;
  timelineOverflowHeight: number;
}

export function readTimelineGeometry(timeline: HTMLElement): TimelineGeometry {
  const scrollHeight = timeline.scrollHeight;
  const clientHeight = timeline.clientHeight;
  return {
    clientHeight,
    maxScrollTop: Math.max(0, scrollHeight - clientHeight),
    scrollHeight
  };
}

export function matchingVirtualScrollController(
  controllerRef: RefObject<AgentTranscriptVirtualScrollController | null>,
  agentSessionId: string
): AgentTranscriptVirtualScrollController | null {
  const controller = controllerRef.current;
  return controller?.enabled && controller.agentSessionId === agentSessionId
    ? controller
    : null;
}

export function hasStaleVirtualScrollController(
  controllerRef: RefObject<AgentTranscriptVirtualScrollController | null>,
  agentSessionId: string
): boolean {
  const controller = controllerRef.current;
  return (
    controller?.enabled === true && controller.agentSessionId !== agentSessionId
  );
}

export function userScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export function readBottomDockSafeArea(bottomDock: HTMLDivElement): {
  floatingOverflowHeight: number;
  timelineOverflowHeight: number;
} {
  const bottomDockRect = bottomDock.getBoundingClientRect();
  let timelineVisualTop = bottomDockRect.top;
  let floatingVisualTop = bottomDockRect.top;
  bottomDock.querySelectorAll("*").forEach((element) => {
    if (element.closest(`.${styles.bottomDockScrollToBottom}`)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    // The prompt input expands above the dock without changing the timeline's
    // reserved safe area. Its outer input box still moves floating controls.
    if (element.closest(`.${styles.composerInputShell}`)) {
      if (element.matches(".agent-gui-node__composer-prompt-input-area")) {
        floatingVisualTop = Math.min(floatingVisualTop, rect.top);
      }
      return;
    }
    // Disclosure overlays affect floating controls, not transcript spacing.
    if (element.closest(`.${styles.composerDisclosurePanel}`)) {
      floatingVisualTop = Math.min(floatingVisualTop, rect.top);
      return;
    }
    floatingVisualTop = Math.min(floatingVisualTop, rect.top);
    timelineVisualTop = Math.min(timelineVisualTop, rect.top);
  });
  return {
    timelineOverflowHeight: Math.max(
      0,
      Math.ceil(bottomDockRect.top - timelineVisualTop)
    ),
    floatingOverflowHeight: Math.max(
      0,
      Math.ceil(bottomDockRect.top - floatingVisualTop)
    )
  };
}

export function writeBottomDockSafeArea(
  timeline: HTMLDivElement,
  safeArea: Pick<
    BottomDockSafeArea,
    "bottomDock" | "floatingOverflowHeight" | "timelineOverflowHeight"
  >
): void {
  timeline.style.setProperty(
    "--agent-gui-bottom-dock-safe-area",
    `${safeArea.timelineOverflowHeight}px`
  );
  safeArea.bottomDock.style.setProperty(
    "--agent-gui-bottom-dock-floating-safe-area",
    `${safeArea.floatingOverflowHeight}px`
  );
}
