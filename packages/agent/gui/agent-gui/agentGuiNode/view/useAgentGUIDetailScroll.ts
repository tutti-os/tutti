import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  pendingRestoreScrollRef: MutableRefObject<{
    conversationId: string;
    scrollTop: number;
  } | null>;
  showTimelineSkeleton: boolean;
  submittedPromptScrollConversationRef: MutableRefObject<string | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  timelineScrollAnchorRef: MutableRefObject<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
  } | null>;
  timelineScrollPositionsRef: MutableRefObject<
    Map<string, { scrollTop: number; atBottom: boolean }>
  >;
  viewModel: AgentGUINodeViewModel;
}

export function useAgentGUIDetailScroll(input: Input) {
  const {
    actions,
    bottomDockRef,
    bottomDockStoreRevision,
    conversation,
    pendingPrependScrollAnchorRef,
    pendingRestoreScrollRef,
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineRef,
    timelineScrollAnchorRef,
    timelineScrollPositionsRef,
    viewModel
  } = input;
  const [isTimelineScrolledToTop, setIsTimelineScrolledToTop] = useState(true);
  const [isTimelineScrolledToBottom, setIsTimelineScrolledToBottom] =
    useState(true);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!activeConversationId) {
      timelineScrollAnchorRef.current = null;
      pendingPrependScrollAnchorRef.current = null;
      submittedPromptScrollConversationRef.current = null;
      setIsTimelineScrolledToTop(true);
      setIsTimelineScrolledToBottom(true);
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    const anchor = timelineScrollAnchorRef.current;
    const prependAnchor = pendingPrependScrollAnchorRef.current;
    const shouldScrollSubmittedPromptToBottom =
      submittedPromptScrollConversationRef.current === activeConversationId;
    let nextScrollTop = timeline.scrollTop;

    const savedScrollPosition = shouldScrollSubmittedPromptToBottom
      ? undefined
      : timelineScrollPositionsRef.current.get(activeConversationId);

    if (
      !anchor ||
      anchor.conversationId !== activeConversationId ||
      shouldScrollSubmittedPromptToBottom
    ) {
      if (
        savedScrollPosition &&
        !savedScrollPosition.atBottom &&
        !showTimelineSkeleton
      ) {
        // Returning to a conversation the user had manually scrolled away
        // from: restore that position instead of snapping to the bottom.
        nextScrollTop = Math.min(maxScrollTop, savedScrollPosition.scrollTop);
        timeline.scrollTop = nextScrollTop;
        pendingRestoreScrollRef.current = null;
      } else if (savedScrollPosition && !savedScrollPosition.atBottom) {
        // Content isn't rendered yet (skeleton) so scrollHeight is not final:
        // defer the restore until the real messages have laid out.
        pendingRestoreScrollRef.current = {
          conversationId: activeConversationId,
          scrollTop: savedScrollPosition.scrollTop
        };
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
        pendingRestoreScrollRef.current = null;
      }
      submittedPromptScrollConversationRef.current = null;
      if (shouldScrollSubmittedPromptToBottom) {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else if (
      pendingRestoreScrollRef.current?.conversationId === activeConversationId
    ) {
      if (showTimelineSkeleton) {
        // Still loading: keep pinned to the bottom until content is ready so
        // the deferred restore can target the final scrollHeight.
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        nextScrollTop = Math.min(
          maxScrollTop,
          pendingRestoreScrollRef.current.scrollTop
        );
        timeline.scrollTop = nextScrollTop;
        pendingRestoreScrollRef.current = null;
      }
    } else if (prependAnchor?.conversationId === activeConversationId) {
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
    viewModel.rail.activeConversationId,
    viewModel.detail.isLoadingOlderMessages
  ]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const bottomDock = bottomDockRef.current;
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!timeline || !bottomDock || !activeConversationId) {
      return;
    }

    let animationFrameId: number | null = null;

    const syncBottomDockSafeArea = (): void => {
      const bottomDockRect = bottomDock.getBoundingClientRect();
      let visualTop = bottomDockRect.top;
      bottomDock.querySelectorAll("*").forEach((element) => {
        if (element.closest(`.${styles.bottomDockScrollToBottom}`)) {
          return;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visualTop = Math.min(visualTop, rect.top);
        }
      });
      const overflowHeight = Math.max(
        0,
        Math.ceil(bottomDockRect.top - visualTop)
      );
      timeline.style.setProperty(
        "--agent-gui-bottom-dock-safe-area",
        `${overflowHeight}px`
      );
      bottomDock.style.setProperty(
        "--agent-gui-bottom-dock-floating-safe-area",
        `${overflowHeight}px`
      );
    };

    const syncBottomDockSpace = (): void => {
      syncBottomDockSafeArea();

      const anchor = timelineScrollAnchorRef.current;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return;
      }

      const distanceFromBottom =
        anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
      if (distanceFromBottom > AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX) {
        return;
      }

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
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
  }, [bottomDockStoreRevision, viewModel.rail.activeConversationId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const captureScrollAnchor = (): void => {
      const scrollTop = timeline.scrollTop;
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight: timeline.scrollHeight,
        scrollTop,
        clientHeight: timeline.clientHeight
      };
      const atBottom =
        timeline.scrollHeight - scrollTop - timeline.clientHeight <=
        AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX;
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      setIsTimelineScrolledToBottom(atBottom);
      // Remember where the user left off so returning to this conversation can
      // restore the position. Skip while a deferred restore is pending so the
      // synchronous jump-to-bottom (during skeleton) doesn't clobber it.
      if (
        pendingRestoreScrollRef.current?.conversationId !== activeConversationId
      ) {
        timelineScrollPositionsRef.current.set(activeConversationId, {
          scrollTop,
          atBottom
        });
      }
      if (
        viewModel.detail.hasOlderMessages &&
        !viewModel.detail.isLoadingOlderMessages &&
        scrollTop <= AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX
      ) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: timeline.scrollHeight,
          scrollTop
        };
        actions.loadOlderConversationMessages();
      }
    };

    captureScrollAnchor();
    timeline.addEventListener("scroll", captureScrollAnchor, { passive: true });
    return () => {
      timeline.removeEventListener("scroll", captureScrollAnchor);
    };
  }, [
    actions,
    viewModel.rail.activeConversationId,
    viewModel.detail.hasOlderMessages,
    viewModel.detail.isLoadingOlderMessages
  ]);

  const scrollTimelineToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
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
  }, [viewModel.rail.activeConversationId]);

  return {
    isTimelineScrolledToBottom,
    isTimelineScrolledToTop,
    scrollTimelineToBottom
  };
}
