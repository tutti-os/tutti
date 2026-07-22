import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject
} from "react";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import {
  setTimelineScrollTopInstantly,
  setTimelineScrollTopWithUserTransition
} from "./AgentGUIConversationTimelinePane";
import styles from "../AgentGUINode.styles";

const AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX = 24;
const AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX = 240;
const AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX = 1;

interface Input {
  actions: AgentGUINodeViewProps["actions"];
  bottomDockRef: RefObject<HTMLDivElement | null>;
  bottomDockStoreRevision: string;
  conversation: AgentConversationVM | null;
  pendingPrependScrollAnchorRef: MutableRefObject<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>;
  showTimelineSkeleton: boolean;
  submittedPromptScrollConversationRef: MutableRefObject<string | null>;
  timelineConversationId: string | null;
  timelineContentRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  timelineScrollAnchorRef: MutableRefObject<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
  } | null>;
  viewModel: AgentGUINodeViewModel;
}

export function useAgentGUIDetailScroll(input: Input) {
  const {
    actions,
    bottomDockRef,
    bottomDockStoreRevision,
    conversation,
    pendingPrependScrollAnchorRef,
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineConversationId,
    timelineContentRef,
    timelineRef,
    timelineScrollAnchorRef,
    viewModel
  } = input;
  const [isTimelineScrolledToTop, setIsTimelineScrolledToTop] = useState(true);
  const [isTimelineScrolledToBottom, setIsTimelineScrolledToBottom] =
    useState(true);
  const bottomLockOwnerRef = useRef<string | null>(null);
  const userScrollAwayIntentConversationRef = useRef<string | null>(null);
  const lastShowTimelineSkeletonRef = useRef(showTimelineSkeleton);
  useLayoutEffect(() => {
    const timelineSkeletonChanged =
      lastShowTimelineSkeletonRef.current !== showTimelineSkeleton;
    lastShowTimelineSkeletonRef.current = showTimelineSkeleton;
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const activeConversationId = timelineConversationId;
    if (!activeConversationId) {
      timelineScrollAnchorRef.current = null;
      bottomLockOwnerRef.current = null;
      pendingPrependScrollAnchorRef.current = null;
      submittedPromptScrollConversationRef.current = null;
      userScrollAwayIntentConversationRef.current = null;
      setIsTimelineScrolledToTop(true);
      setIsTimelineScrolledToBottom(true);
      return;
    }

    const anchor = timelineScrollAnchorRef.current;
    const prependAnchor = pendingPrependScrollAnchorRef.current;
    const shouldScrollSubmittedPromptToBottom =
      submittedPromptScrollConversationRef.current === activeConversationId;
    const conversationChanged =
      !anchor || anchor.conversationId !== activeConversationId;
    const shouldRestorePrependAnchor =
      prependAnchor?.conversationId === activeConversationId;
    if (
      !conversationChanged &&
      !shouldScrollSubmittedPromptToBottom &&
      !shouldRestorePrependAnchor &&
      !timelineSkeletonChanged
    ) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    let nextScrollTop: number;
    if (conversationChanged || shouldScrollSubmittedPromptToBottom) {
      bottomLockOwnerRef.current = activeConversationId;
      userScrollAwayIntentConversationRef.current = null;
    }
    const shouldKeepBottomLocked =
      bottomLockOwnerRef.current === activeConversationId;

    if (
      conversationChanged ||
      shouldScrollSubmittedPromptToBottom ||
      shouldKeepBottomLocked
    ) {
      setTimelineScrollTopInstantly(timeline, maxScrollTop);
      nextScrollTop = maxScrollTop;
      submittedPromptScrollConversationRef.current = null;
      if (shouldScrollSubmittedPromptToBottom) {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else if (shouldRestorePrependAnchor && prependAnchor) {
      const nextScrollHeight = timeline.scrollHeight;
      const delta = nextScrollHeight - prependAnchor.scrollHeight;
      nextScrollTop = Math.max(0, prependAnchor.scrollTop + delta);
      timeline.scrollTop = nextScrollTop;
      if (viewModel.detail.isLoadingOlderMessages) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: nextScrollHeight,
          scrollTop: nextScrollTop
        };
      } else {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else {
      const distanceFromBottom =
        anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
      if (distanceFromBottom <= AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX) {
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        nextScrollTop = Math.min(maxScrollTop, anchor.scrollTop);
        timeline.scrollTop = nextScrollTop;
      }
    }

    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: timeline.scrollHeight,
      scrollTop: nextScrollTop,
      clientHeight: timeline.clientHeight
    };
    setIsTimelineScrolledToTop(
      nextScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
    setIsTimelineScrolledToBottom(
      maxScrollTop - nextScrollTop <= AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX
    );
  }, [
    conversation,
    showTimelineSkeleton,
    timelineConversationId,
    viewModel.detail.isLoadingOlderMessages
  ]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const bottomDock = bottomDockRef.current;
    const activeConversationId = timelineConversationId;
    if (!timeline || !bottomDock || !activeConversationId) {
      return;
    }

    let animationFrameId: number | null = null;

    const syncBottomDockSafeArea = (): void => {
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
        // The prompt input box expands upward past the dock top while the
        // user drafts a long prompt. That transient overhang must not grow
        // the timeline's reserved bottom space: reserving for it re-pins the
        // scroll position and visibly pushes the message stream up. Only the
        // input area's own box contributes to the floating controls' offset;
        // clipped editor descendants can have layout positions above that box
        // and would otherwise create an oversized gap.
        if (element.closest(`.${styles.composerInputShell}`)) {
          if (element.matches(".agent-gui-node__composer-prompt-input-area")) {
            floatingVisualTop = Math.min(floatingVisualTop, rect.top);
          }
          return;
        }
        floatingVisualTop = Math.min(floatingVisualTop, rect.top);
        timelineVisualTop = Math.min(timelineVisualTop, rect.top);
      });
      const timelineOverflowHeight = Math.max(
        0,
        Math.ceil(bottomDockRect.top - timelineVisualTop)
      );
      const floatingOverflowHeight = Math.max(
        0,
        Math.ceil(bottomDockRect.top - floatingVisualTop)
      );
      timeline.style.setProperty(
        "--agent-gui-bottom-dock-safe-area",
        `${timelineOverflowHeight}px`
      );
      bottomDock.style.setProperty(
        "--agent-gui-bottom-dock-floating-safe-area",
        `${floatingOverflowHeight}px`
      );
    };

    const syncBottomDockSpace = (): void => {
      syncBottomDockSafeArea();

      if (activeConversationId !== viewModel.rail.activeConversationId) {
        return;
      }

      const anchor = timelineScrollAnchorRef.current;
      const bottomLocked = bottomLockOwnerRef.current === activeConversationId;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return;
      }

      const distanceFromBottom =
        anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
      if (
        !bottomLocked &&
        distanceFromBottom > AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX
      ) {
        return;
      }

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const latestAnchor = timelineScrollAnchorRef.current;
        if (
          !latestAnchor ||
          latestAnchor.conversationId !== activeConversationId
        ) {
          return;
        }
        const latestDistanceFromBottom =
          latestAnchor.scrollHeight -
          latestAnchor.scrollTop -
          latestAnchor.clientHeight;
        const latestBottomLocked =
          bottomLockOwnerRef.current === activeConversationId;
        if (
          !latestBottomLocked &&
          latestDistanceFromBottom > AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX
        ) {
          return;
        }
        const maxScrollTop = Math.max(
          0,
          timeline.scrollHeight - timeline.clientHeight
        );
        timeline.scrollTop = maxScrollTop;
        timelineScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: timeline.scrollHeight,
          scrollTop: maxScrollTop,
          clientHeight: timeline.clientHeight
        };
        setIsTimelineScrolledToTop(
          maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
        );
        setIsTimelineScrolledToBottom(true);
      });
    };

    syncBottomDockSpace();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
        bottomDock.style.removeProperty(
          "--agent-gui-bottom-dock-floating-safe-area"
        );
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
        }
      };
    }

    const observer = new ResizeObserver(syncBottomDockSpace);
    observer.observe(bottomDock);
    const promptInputArea = bottomDock.querySelector(
      ".agent-gui-node__composer-prompt-input-area"
    );
    if (promptInputArea instanceof Element) {
      observer.observe(promptInputArea);
    }
    return () => {
      timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
      bottomDock.style.removeProperty(
        "--agent-gui-bottom-dock-floating-safe-area"
      );
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      observer.disconnect();
    };
  }, [
    bottomDockStoreRevision,
    timelineConversationId,
    viewModel.rail.activeConversationId
  ]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const timelineContent = timelineContentRef.current;
    const activeConversationId = timelineConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const captureScrollAnchor = (): void => {
      const previousAnchor = timelineScrollAnchorRef.current;
      if (
        !previousAnchor ||
        previousAnchor.conversationId !== activeConversationId
      ) {
        return;
      }
      const scrollTop = timeline.scrollTop;
      const inferredUserScrollAway = scrollTop < previousAnchor.scrollTop - 1;
      const explicitUserScrollAway =
        userScrollAwayIntentConversationRef.current === activeConversationId;
      if (explicitUserScrollAway || inferredUserScrollAway) {
        bottomLockOwnerRef.current = null;
        userScrollAwayIntentConversationRef.current = null;
      }
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight: previousAnchor.scrollHeight,
        scrollTop,
        clientHeight: previousAnchor.clientHeight
      };
      const atBottom =
        previousAnchor.scrollHeight - scrollTop - previousAnchor.clientHeight <=
        AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX;
      if (atBottom) {
        bottomLockOwnerRef.current = activeConversationId;
      }
      const effectiveAtBottom =
        atBottom || bottomLockOwnerRef.current === activeConversationId;
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      setIsTimelineScrolledToBottom(effectiveAtBottom);
      if (
        activeConversationId === viewModel.rail.activeConversationId &&
        viewModel.detail.hasOlderMessages &&
        !viewModel.detail.isLoadingOlderMessages &&
        scrollTop <= AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX
      ) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: previousAnchor.scrollHeight,
          scrollTop
        };
        actions.loadOlderConversationMessages();
      }
    };

    const syncObservedTimelineGeometry = (): void => {
      const anchor = timelineScrollAnchorRef.current;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return;
      }

      const scrollHeight = timeline.scrollHeight;
      const clientHeight = timeline.clientHeight;
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
      const bottomLocked = bottomLockOwnerRef.current === activeConversationId;
      let scrollTop = Math.min(maxScrollTop, timeline.scrollTop);
      if (bottomLocked) {
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        scrollTop = maxScrollTop;
      }
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight,
        scrollTop,
        clientHeight
      };
      const atBottom =
        maxScrollTop - scrollTop <= AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX;
      if (atBottom) {
        bottomLockOwnerRef.current = activeConversationId;
      }
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      setIsTimelineScrolledToBottom(bottomLocked || atBottom);
    };

    const captureWheelIntent = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        userScrollAwayIntentConversationRef.current = activeConversationId;
      }
    };
    const captureKeyboardIntent = (event: KeyboardEvent): void => {
      if (
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "PageUp"
      ) {
        userScrollAwayIntentConversationRef.current = activeConversationId;
      }
    };

    captureScrollAnchor();
    timeline.addEventListener("scroll", captureScrollAnchor, { passive: true });
    timeline.addEventListener("wheel", captureWheelIntent, { passive: true });
    timeline.addEventListener("keydown", captureKeyboardIntent);
    const geometryObserver =
      timelineContent && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncObservedTimelineGeometry)
        : null;
    geometryObserver?.observe(timeline);
    if (timelineContent) {
      geometryObserver?.observe(timelineContent);
    }
    return () => {
      geometryObserver?.disconnect();
      timeline.removeEventListener("scroll", captureScrollAnchor);
      timeline.removeEventListener("wheel", captureWheelIntent);
      timeline.removeEventListener("keydown", captureKeyboardIntent);
    };
  }, [
    actions,
    timelineConversationId,
    viewModel.rail.activeConversationId,
    viewModel.detail.hasOlderMessages,
    viewModel.detail.isLoadingOlderMessages
  ]);

  const scrollTimelineToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    const activeConversationId = timelineConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }
    if (activeConversationId !== viewModel.rail.activeConversationId) {
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    bottomLockOwnerRef.current = activeConversationId;
    userScrollAwayIntentConversationRef.current = null;
    setTimelineScrollTopWithUserTransition(timeline, maxScrollTop);
    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: timeline.scrollHeight,
      scrollTop: maxScrollTop,
      clientHeight: timeline.clientHeight
    };
    setIsTimelineScrolledToTop(
      maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
    setIsTimelineScrolledToBottom(true);
  }, [timelineConversationId, viewModel.rail.activeConversationId]);

  return {
    isTimelineScrolledToBottom,
    isTimelineScrolledToTop,
    scrollTimelineToBottom
  };
}
