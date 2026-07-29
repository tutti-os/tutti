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
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import {
  createAgentConversationFollowEndController,
  type AgentConversationFollowEndEvent
} from "../../../shared/agentConversation/agentConversationFollowEndController";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import {
  hasStaleVirtualScrollController,
  matchingVirtualScrollController,
  readBottomDockSafeArea,
  readTimelineGeometry,
  userScrollBehavior,
  writeBottomDockSafeArea,
  type BottomDockSafeArea
} from "./agentGUIDetailScrollHelpers";
import {
  setTimelineScrollTopInstantly,
  setTimelineScrollTopWithUserTransition
} from "./AgentGUIConversationTimelinePane";

const AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX = 240;
const AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX = 1;
const AGENT_GUI_REACHED_END_EPSILON_PX = 1;

interface Input {
  actions: AgentGUINodeViewProps["actions"];
  bottomDockRef: RefObject<HTMLDivElement | null>;
  bottomDockStoreRevision: string;
  conversation: AgentConversationVM | null;
  isVisible: boolean;
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
  virtualScrollControllerRef: RefObject<AgentTranscriptVirtualScrollController | null>;
  viewModel: AgentGUINodeViewModel;
}

export function useAgentGUIDetailScroll(input: Input) {
  const {
    actions,
    bottomDockRef,
    bottomDockStoreRevision,
    conversation,
    isVisible,
    pendingPrependScrollAnchorRef,
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineConversationId,
    timelineContentRef,
    timelineRef,
    timelineScrollAnchorRef,
    virtualScrollControllerRef,
    viewModel
  } = input;
  const [isTimelineScrolledToTop, setIsTimelineScrolledToTop] = useState(true);
  const followEndControllerRef = useRef(
    createAgentConversationFollowEndController()
  );
  const followEndController = followEndControllerRef.current;
  const [followEndMode, setFollowEndMode] = useState(
    followEndController.getSnapshot
  );
  const dispatchFollowEnd = useCallback(
    (event: AgentConversationFollowEndEvent): void => {
      setFollowEndMode(followEndController.dispatch(event));
    },
    [followEndController]
  );
  const pointerScrollConversationRef = useRef<string | null>(null);
  const userScrollDirectionRef = useRef<"away" | "toward-end" | null>(null);
  const lastShowTimelineSkeletonRef = useRef(showTimelineSkeleton);
  const bottomDockSafeAreaRef = useRef<BottomDockSafeArea | null>(null);
  const [virtualScrollControllerRevision, setVirtualScrollControllerRevision] =
    useState(0);
  const setVirtualScrollController = useCallback(
    (controller: AgentTranscriptVirtualScrollController | null) => {
      if (virtualScrollControllerRef.current === controller) {
        return;
      }
      virtualScrollControllerRef.current = controller;
      if (controller) {
        setVirtualScrollControllerRevision((revision) => revision + 1);
      }
    },
    [virtualScrollControllerRef]
  );
  const lastVirtualScrollControllerRevisionRef = useRef(
    virtualScrollControllerRevision
  );
  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }
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
      pendingPrependScrollAnchorRef.current = null;
      pointerScrollConversationRef.current = null;
      userScrollDirectionRef.current = null;
      submittedPromptScrollConversationRef.current = null;
      setIsTimelineScrolledToTop(true);
      return;
    }
    if (activeConversationId !== viewModel.rail.activeConversationId) {
      return;
    }
    const anchor = timelineScrollAnchorRef.current;
    const conversationChanged =
      !anchor || anchor.conversationId !== activeConversationId;
    if (conversationChanged) {
      dispatchFollowEnd("conversation-changed");
      pointerScrollConversationRef.current = null;
      userScrollDirectionRef.current = null;
    }
    if (
      hasStaleVirtualScrollController(
        virtualScrollControllerRef,
        activeConversationId
      )
    ) {
      return;
    }

    const prependAnchor = pendingPrependScrollAnchorRef.current;
    const shouldScrollSubmittedPromptToBottom =
      submittedPromptScrollConversationRef.current === activeConversationId;
    const shouldRestorePrependAnchor =
      prependAnchor?.conversationId === activeConversationId;
    const virtualScrollControllerChanged =
      lastVirtualScrollControllerRevisionRef.current !==
      virtualScrollControllerRevision;
    if (conversationChanged && showTimelineSkeleton) {
      setIsTimelineScrolledToTop(true);
      return;
    }
    lastVirtualScrollControllerRevisionRef.current =
      virtualScrollControllerRevision;
    if (
      !conversationChanged &&
      !shouldScrollSubmittedPromptToBottom &&
      !shouldRestorePrependAnchor &&
      !timelineSkeletonChanged &&
      !virtualScrollControllerChanged
    ) {
      return;
    }
    const virtualScrollController = matchingVirtualScrollController(
      virtualScrollControllerRef,
      activeConversationId
    );
    if (virtualScrollController) {
      if (
        conversationChanged ||
        shouldScrollSubmittedPromptToBottom ||
        (virtualScrollControllerChanged &&
          followEndController.getSnapshot() === "following")
      ) {
        if (shouldScrollSubmittedPromptToBottom) {
          dispatchFollowEnd("prompt-submitted");
        }
        pointerScrollConversationRef.current = null;
        userScrollDirectionRef.current = null;
        virtualScrollController.scrollToEnd({ behavior: "auto" });
        submittedPromptScrollConversationRef.current = null;
        if (shouldScrollSubmittedPromptToBottom) {
          pendingPrependScrollAnchorRef.current = null;
        }
      } else if (
        shouldRestorePrependAnchor &&
        !viewModel.detail.isLoadingOlderMessages
      ) {
        pendingPrependScrollAnchorRef.current = null;
      }
      const virtualAnchor =
        anchor?.conversationId === activeConversationId
          ? anchor
          : {
              clientHeight: 0,
              conversationId: activeConversationId,
              scrollHeight: Number.POSITIVE_INFINITY,
              scrollTop: 0
            };
      timelineScrollAnchorRef.current = {
        ...virtualAnchor,
        conversationId: activeConversationId
      };
      setIsTimelineScrolledToTop(
        virtualAnchor.scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      return;
    }
    const geometry = readTimelineGeometry(timeline);
    const maxScrollTop = geometry.maxScrollTop;
    let nextScrollTop: number;
    if (conversationChanged || shouldScrollSubmittedPromptToBottom) {
      if (shouldScrollSubmittedPromptToBottom) {
        dispatchFollowEnd("prompt-submitted");
      }
      pointerScrollConversationRef.current = null;
      userScrollDirectionRef.current = null;
    }
    const shouldKeepBottomLocked =
      followEndController.getSnapshot() === "following";

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
      const nextScrollHeight = geometry.scrollHeight;
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
      nextScrollTop = Math.min(maxScrollTop, anchor.scrollTop);
      timeline.scrollTop = nextScrollTop;
    }

    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: geometry.scrollHeight,
      scrollTop: nextScrollTop,
      clientHeight: geometry.clientHeight
    };
    setIsTimelineScrolledToTop(
      nextScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
  }, [
    conversation,
    dispatchFollowEnd,
    followEndController,
    isVisible,
    showTimelineSkeleton,
    timelineConversationId,
    virtualScrollControllerRevision,
    viewModel.rail.activeConversationId,
    viewModel.detail.isLoadingOlderMessages
  ]);

  const hasTimelineConversation = timelineConversationId !== null;
  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }
    const timeline = timelineRef.current;
    const bottomDock = bottomDockRef.current;
    if (!hasTimelineConversation || !timeline || !bottomDock) {
      return;
    }

    let animationFrameId: number | null = null;
    const resolveBottomLockConversation = (): string | null => {
      const activeConversationId =
        timelineScrollAnchorRef.current?.conversationId ?? null;
      if (
        !activeConversationId ||
        followEndController.getSnapshot() !== "following"
      ) {
        return null;
      }
      const anchor = timelineScrollAnchorRef.current;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return null;
      }
      return activeConversationId;
    };

    const syncBottomDockSafeArea = (forceMeasurement: boolean): void => {
      const cachedSafeArea = bottomDockSafeAreaRef.current;
      if (
        !forceMeasurement &&
        cachedSafeArea?.bottomDock === bottomDock &&
        cachedSafeArea.revision === bottomDockStoreRevision
      ) {
        writeBottomDockSafeArea(timeline, cachedSafeArea);
        return;
      }
      const measuredSafeArea = readBottomDockSafeArea(bottomDock);
      if (
        cachedSafeArea?.bottomDock === bottomDock &&
        cachedSafeArea.timelineOverflowHeight ===
          measuredSafeArea.timelineOverflowHeight &&
        cachedSafeArea.floatingOverflowHeight ===
          measuredSafeArea.floatingOverflowHeight
      ) {
        bottomDockSafeAreaRef.current = {
          bottomDock,
          revision: bottomDockStoreRevision,
          ...measuredSafeArea
        };
        return;
      }
      const nextSafeArea: BottomDockSafeArea = {
        bottomDock,
        revision: bottomDockStoreRevision,
        ...measuredSafeArea
      };
      bottomDockSafeAreaRef.current = nextSafeArea;
      writeBottomDockSafeArea(timeline, nextSafeArea);
    };

    const syncConversationBottomLock = (): void => {
      const scheduledConversationId = resolveBottomLockConversation();
      if (!scheduledConversationId) {
        return;
      }

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        if (
          resolveBottomLockConversation() !== scheduledConversationId ||
          timelineRef.current !== timeline
        ) {
          return;
        }
        if (
          hasStaleVirtualScrollController(
            virtualScrollControllerRef,
            scheduledConversationId
          )
        ) {
          return;
        }
        const virtualScrollController = matchingVirtualScrollController(
          virtualScrollControllerRef,
          scheduledConversationId
        );
        if (virtualScrollController) {
          virtualScrollController.scrollToEnd({ behavior: "auto" });
          return;
        }
        const geometry = readTimelineGeometry(timeline);
        const maxScrollTop = geometry.maxScrollTop;
        timeline.scrollTop = maxScrollTop;
        timelineScrollAnchorRef.current = {
          conversationId: scheduledConversationId,
          scrollHeight: geometry.scrollHeight,
          scrollTop: maxScrollTop,
          clientHeight: geometry.clientHeight
        };
        setIsTimelineScrolledToTop(
          maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
        );
      });
    };

    syncBottomDockSafeArea(false);
    syncConversationBottomLock();
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

    const observer = new ResizeObserver(() => {
      syncBottomDockSafeArea(true);
      syncConversationBottomLock();
    });
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
    followEndController,
    hasTimelineConversation,
    isVisible
  ]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
    const timeline = timelineRef.current;
    const timelineContent = timelineContentRef.current;
    const activeConversationId = timelineConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const loadOlderMessagesNearTop = (
      scrollTop: number,
      scrollHeight: number,
      clientHeight: number
    ): void => {
      const bottomLocked = followEndController.getSnapshot() === "following";
      const virtualScrollController = matchingVirtualScrollController(
        virtualScrollControllerRef,
        activeConversationId
      );
      const transcriptGeometryIsReady =
        timelineContent?.querySelector("[data-agent-transcript-row]") !== null;
      const needsMoreContentToFillViewport =
        !virtualScrollController &&
        transcriptGeometryIsReady &&
        scrollHeight <= clientHeight;
      if (
        activeConversationId === viewModel.rail.activeConversationId &&
        viewModel.detail.hasOlderMessages &&
        !viewModel.detail.isLoadingOlderMessages &&
        !showTimelineSkeleton &&
        (!bottomLocked || needsMoreContentToFillViewport) &&
        scrollTop <= AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX
      ) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight,
          scrollTop
        };
        actions.loadOlderConversationMessages();
      }
    };

    const captureScrollAnchor = (): void => {
      const previousAnchor = timelineScrollAnchorRef.current;
      if (
        !previousAnchor ||
        previousAnchor.conversationId !== activeConversationId
      ) {
        return;
      }
      let scrollTop = timeline.scrollTop;
      const pointerDrivenScrollAway =
        pointerScrollConversationRef.current === activeConversationId &&
        scrollTop < previousAnchor.scrollTop - AGENT_GUI_REACHED_END_EPSILON_PX;
      const pointerDrivenScrollTowardEnd =
        pointerScrollConversationRef.current === activeConversationId &&
        scrollTop > previousAnchor.scrollTop + AGENT_GUI_REACHED_END_EPSILON_PX;
      if (pointerDrivenScrollAway) {
        userScrollDirectionRef.current = "away";
        dispatchFollowEnd("user-scrolled-away");
      } else if (pointerDrivenScrollTowardEnd) {
        userScrollDirectionRef.current = "toward-end";
      }
      const virtualScrollController = matchingVirtualScrollController(
        virtualScrollControllerRef,
        activeConversationId
      );
      if (
        !virtualScrollController &&
        followEndController.getSnapshot() === "following"
      ) {
        const anchoredMaxScrollTop = Math.max(
          0,
          previousAnchor.scrollHeight - previousAnchor.clientHeight
        );
        if (
          anchoredMaxScrollTop - scrollTop >
          AGENT_GUI_REACHED_END_EPSILON_PX
        ) {
          setTimelineScrollTopInstantly(timeline, anchoredMaxScrollTop);
          scrollTop = anchoredMaxScrollTop;
        }
      }
      if (
        followEndController.getSnapshot() === "detached" &&
        userScrollDirectionRef.current === "toward-end" &&
        (virtualScrollController
          ? virtualScrollController.isAtEnd(AGENT_GUI_REACHED_END_EPSILON_PX)
          : previousAnchor.scrollHeight -
              scrollTop -
              previousAnchor.clientHeight <=
            AGENT_GUI_REACHED_END_EPSILON_PX)
      ) {
        dispatchFollowEnd("user-reached-end");
      }
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight: previousAnchor.scrollHeight,
        scrollTop,
        clientHeight: previousAnchor.clientHeight
      };
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      loadOlderMessagesNearTop(
        scrollTop,
        previousAnchor.scrollHeight,
        previousAnchor.clientHeight
      );
    };

    const syncObservedTimelineGeometry = (
      entries: readonly ResizeObserverEntry[]
    ): void => {
      const anchor = timelineScrollAnchorRef.current;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return;
      }

      const virtualScrollController = matchingVirtualScrollController(
        virtualScrollControllerRef,
        activeConversationId
      );
      if (virtualScrollController) {
        const scrollTop = timeline.scrollTop;
        const observedClientHeight = entries.find(
          (entry) => entry.target === timeline
        )?.contentRect.height;
        const observedScrollHeight = entries.find(
          (entry) => entry.target === timelineContent
        )?.contentRect.height;
        const clientHeight = observedClientHeight ?? anchor.clientHeight;
        const scrollHeight =
          observedScrollHeight === undefined
            ? anchor.scrollHeight
            : Math.max(clientHeight, observedScrollHeight);
        timelineScrollAnchorRef.current = {
          ...anchor,
          clientHeight,
          scrollHeight,
          scrollTop
        };
        setIsTimelineScrolledToTop(
          scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
        );
        loadOlderMessagesNearTop(scrollTop, scrollHeight, clientHeight);
        return;
      }
      const geometry = readTimelineGeometry(timeline);
      const { clientHeight, maxScrollTop, scrollHeight } = geometry;
      const bottomLocked = followEndController.getSnapshot() === "following";
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
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
    };

    const captureWheelIntent = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        userScrollDirectionRef.current = "away";
        dispatchFollowEnd("user-scrolled-away");
      } else if (event.deltaY > 0) {
        userScrollDirectionRef.current = "toward-end";
      }
    };
    const captureKeyboardIntent = (event: KeyboardEvent): void => {
      if (
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "PageUp"
      ) {
        userScrollDirectionRef.current = "away";
        dispatchFollowEnd("user-scrolled-away");
      } else if (
        event.key === "ArrowDown" ||
        event.key === "End" ||
        event.key === "PageDown" ||
        (event.key === " " && !event.shiftKey)
      ) {
        userScrollDirectionRef.current = "toward-end";
      }
    };
    const captureSemanticScrollAwayIntent = (event: MouseEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-agent-transcript-scroll-away-intent]")
      ) {
        userScrollDirectionRef.current = "away";
        dispatchFollowEnd("user-scrolled-away");
      }
    };
    const capturePointerIntent = (): void => {
      pointerScrollConversationRef.current = activeConversationId;
    };
    const clearPointerIntent = (): void => {
      if (pointerScrollConversationRef.current === activeConversationId) {
        pointerScrollConversationRef.current = null;
      }
    };
    const clearScrollDirection = (): void => {
      userScrollDirectionRef.current = null;
    };

    const initialAnchor = timelineScrollAnchorRef.current;
    if (initialAnchor?.conversationId === activeConversationId) {
      loadOlderMessagesNearTop(
        initialAnchor.scrollTop,
        initialAnchor.scrollHeight,
        initialAnchor.clientHeight
      );
    }
    timeline.addEventListener("scroll", captureScrollAnchor, { passive: true });
    timeline.addEventListener("scrollend", clearScrollDirection);
    timeline.addEventListener("wheel", captureWheelIntent, { passive: true });
    timeline.addEventListener("keydown", captureKeyboardIntent);
    timeline.addEventListener("click", captureSemanticScrollAwayIntent);
    timeline.addEventListener("pointerdown", capturePointerIntent, {
      passive: true
    });
    window.addEventListener("pointerup", clearPointerIntent, { passive: true });
    window.addEventListener("pointercancel", clearPointerIntent, {
      passive: true
    });
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
      timeline.removeEventListener("scrollend", clearScrollDirection);
      timeline.removeEventListener("wheel", captureWheelIntent);
      timeline.removeEventListener("keydown", captureKeyboardIntent);
      timeline.removeEventListener("click", captureSemanticScrollAwayIntent);
      timeline.removeEventListener("pointerdown", capturePointerIntent);
      window.removeEventListener("pointerup", clearPointerIntent);
      window.removeEventListener("pointercancel", clearPointerIntent);
    };
  }, [
    actions,
    dispatchFollowEnd,
    followEndController,
    isVisible,
    timelineConversationId,
    showTimelineSkeleton,
    viewModel.rail.activeConversationId,
    viewModel.detail.hasOlderMessages,
    viewModel.detail.isLoadingOlderMessages
  ]);

  const scrollTimelineToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    const activeConversationId = timelineConversationId;
    if (!isVisible || !timeline || !activeConversationId) {
      return;
    }
    if (activeConversationId !== viewModel.rail.activeConversationId) {
      return;
    }
    if (
      hasStaleVirtualScrollController(
        virtualScrollControllerRef,
        activeConversationId
      )
    ) {
      return;
    }

    const virtualScrollController = matchingVirtualScrollController(
      virtualScrollControllerRef,
      activeConversationId
    );
    dispatchFollowEnd("scroll-to-end-requested");
    userScrollDirectionRef.current = null;
    if (virtualScrollController) {
      virtualScrollController.scrollToEnd({
        behavior: userScrollBehavior()
      });
      return;
    }
    const geometry = readTimelineGeometry(timeline);
    const maxScrollTop = geometry.maxScrollTop;
    setTimelineScrollTopWithUserTransition(timeline, maxScrollTop);
    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: geometry.scrollHeight,
      scrollTop: maxScrollTop,
      clientHeight: geometry.clientHeight
    };
    setIsTimelineScrolledToTop(
      maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
  }, [
    dispatchFollowEnd,
    isVisible,
    timelineConversationId,
    viewModel.rail.activeConversationId,
    virtualScrollControllerRef
  ]);

  return {
    followEndMode,
    isTimelineScrolledToBottom: followEndMode === "following",
    isTimelineScrolledToTop,
    setVirtualScrollController,
    scrollTimelineToBottom
  };
}
