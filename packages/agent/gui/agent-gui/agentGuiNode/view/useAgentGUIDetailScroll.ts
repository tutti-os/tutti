import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type {
  AgentTranscriptViewportSnapshot,
  AgentTranscriptVirtualScrollController
} from "../../../shared/agentConversation/components/AgentTranscriptView";
import { AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX } from "../../../shared/agentConversation/components/agentTranscriptScrollController";
import {
  createAgentConversationFollowEndController,
  isAgentConversationViewportAtEnd,
  type AgentConversationFollowEndEvent
} from "../../../shared/agentConversation/agentConversationFollowEndController";
import {
  AgentGUIConversationScrollMemory,
  type TimelineScrollAnchor
} from "./agentGUIScrollMemory";
import type { AgentGUIDetailScrollInput } from "./agentGUIDetailScrollTypes";
import {
  hasStaleVirtualScrollController,
  matchingVirtualScrollController,
  readBottomDockSafeArea,
  userScrollBehavior,
  writeBottomDockSafeArea,
  type BottomDockSafeArea
} from "./agentGUIDetailScrollHelpers";

const AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX = 1;

export function useAgentGUIDetailScroll(input: AgentGUIDetailScrollInput) {
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
    timelineRef,
    timelineScrollAnchorRef,
    virtualScrollControllerRef,
    viewModel
  } = input;
  const [isTimelineScrolledToTop, setIsTimelineScrolledToTop] = useState(true);
  const [isTimelineScrolledToBottom, setIsTimelineScrolledToBottom] =
    useState(true);
  const followEndControllerRef = useRef(
    createAgentConversationFollowEndController()
  );
  const followEndController = followEndControllerRef.current;
  const conversationScrollMemoryRef = useRef(
    new AgentGUIConversationScrollMemory()
  );
  const [followEndMode, setFollowEndMode] = useState(
    followEndController.getSnapshot
  );
  const dispatchFollowEnd = useCallback(
    (event: AgentConversationFollowEndEvent): void => {
      const nextMode = followEndController.dispatch(event);
      const anchor = timelineScrollAnchorRef.current;
      if (anchor) {
        conversationScrollMemoryRef.current.write(anchor, nextMode);
      }
      setFollowEndMode(nextMode);
    },
    [followEndController, timelineScrollAnchorRef]
  );
  const writeTimelineScrollAnchor = useCallback(
    (anchor: TimelineScrollAnchor): void => {
      timelineScrollAnchorRef.current = anchor;
      conversationScrollMemoryRef.current.write(
        anchor,
        followEndController.getSnapshot()
      );
    },
    [followEndController, timelineScrollAnchorRef]
  );
  const userScrollDirectionRef = useRef<"away" | "toward-end" | null>(null);
  const lastTopLoadViewportRef = useRef<{
    contentHeightPx: number;
    conversationId: string;
    scrollTopPx: number;
  } | null>(null);
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
      userScrollDirectionRef.current = null;
      lastTopLoadViewportRef.current = null;
      submittedPromptScrollConversationRef.current = null;
      setIsTimelineScrolledToTop(true);
      return;
    }
    if (activeConversationId !== viewModel.rail.activeConversationId) {
      return;
    }
    let anchor = timelineScrollAnchorRef.current;
    const conversationChanged =
      !anchor || anchor.conversationId !== activeConversationId;
    if (conversationChanged) {
      if (anchor) {
        conversationScrollMemoryRef.current.write(
          anchor,
          followEndController.getSnapshot()
        );
      }
      const rememberedScroll =
        conversationScrollMemoryRef.current.read(activeConversationId);
      const restoredFollowEndMode =
        rememberedScroll?.followEndMode ?? "following";
      setFollowEndMode(
        followEndController.dispatch(
          restoredFollowEndMode === "detached"
            ? "user-scrolled-away"
            : "conversation-changed"
        )
      );
      userScrollDirectionRef.current = null;
      lastTopLoadViewportRef.current = null;
      if (showTimelineSkeleton) {
        timelineScrollAnchorRef.current = null;
        setIsTimelineScrolledToTop(true);
        return;
      }
      anchor = rememberedScroll?.anchor ?? {
        clientHeight: 0,
        conversationId: activeConversationId,
        scrollHeight: Number.POSITIVE_INFINITY,
        scrollTop: 0
      };
      timelineScrollAnchorRef.current = anchor;
      conversationScrollMemoryRef.current.write(
        anchor,
        rememberedScroll?.followEndMode ?? "following"
      );
    }
    if (!anchor) {
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

    const prependAnchor = pendingPrependScrollAnchorRef.current;
    const shouldScrollSubmittedPromptToBottom =
      submittedPromptScrollConversationRef.current === activeConversationId;
    const shouldRestorePrependAnchor =
      prependAnchor?.conversationId === activeConversationId;
    const virtualScrollControllerChanged =
      lastVirtualScrollControllerRevisionRef.current !==
      virtualScrollControllerRevision;
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
    if (!virtualScrollController) {
      return;
    }
    const followsEnd = followEndController.getSnapshot() === "following";
    if (
      shouldScrollSubmittedPromptToBottom ||
      (followsEnd && (conversationChanged || virtualScrollControllerChanged))
    ) {
      if (shouldScrollSubmittedPromptToBottom) {
        dispatchFollowEnd("prompt-submitted");
      }
      userScrollDirectionRef.current = null;
      virtualScrollController.scrollToEnd({ behavior: "auto" });
      submittedPromptScrollConversationRef.current = null;
      if (shouldScrollSubmittedPromptToBottom) {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else if (
      !followsEnd &&
      (conversationChanged ||
        virtualScrollControllerChanged ||
        (timelineSkeletonChanged && !showTimelineSkeleton))
    ) {
      virtualScrollController.scrollToOffset(anchor.scrollTop, {
        behavior: "auto"
      });
    }
    if (
      shouldRestorePrependAnchor &&
      !viewModel.detail.isLoadingOlderMessages
    ) {
      pendingPrependScrollAnchorRef.current = null;
    }

    writeTimelineScrollAnchor({
      ...anchor,
      conversationId: activeConversationId
    });
    setIsTimelineScrolledToTop(
      anchor.scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
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
    viewModel.detail.isLoadingOlderMessages,
    writeTimelineScrollAnchor
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

    const syncBottomDockSafeArea = (forceMeasurement: boolean): void => {
      const cachedSafeArea = bottomDockSafeAreaRef.current;
      if (
        !forceMeasurement &&
        cachedSafeArea?.bottomDock === bottomDock &&
        cachedSafeArea.revision === bottomDockStoreRevision
      ) {
        writeBottomDockSafeArea(timeline, cachedSafeArea);
        matchingVirtualScrollController(
          virtualScrollControllerRef,
          timelineConversationId
        )?.syncViewport({
          followEnd: followEndController.getSnapshot() === "following",
          scrollPaddingBottomAdjustmentPx: cachedSafeArea.timelineOverflowHeight
        });
        return;
      }
      const measuredSafeArea = readBottomDockSafeArea(bottomDock);
      const nextSafeArea: BottomDockSafeArea = {
        bottomDock,
        revision: bottomDockStoreRevision,
        ...measuredSafeArea
      };
      bottomDockSafeAreaRef.current = nextSafeArea;
      writeBottomDockSafeArea(timeline, nextSafeArea);
      matchingVirtualScrollController(
        virtualScrollControllerRef,
        timelineConversationId
      )?.syncViewport({
        followEnd: followEndController.getSnapshot() === "following",
        scrollPaddingBottomAdjustmentPx: nextSafeArea.timelineOverflowHeight
      });
    };

    syncBottomDockSafeArea(false);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
        bottomDock.style.removeProperty(
          "--agent-gui-bottom-dock-floating-safe-area"
        );
      };
    }

    const observer = new ResizeObserver(() => {
      syncBottomDockSafeArea(true);
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
    const activeConversationId = timelineConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }
    const virtualScrollController = matchingVirtualScrollController(
      virtualScrollControllerRef,
      activeConversationId
    );
    if (!virtualScrollController) {
      return;
    }

    const loadOlderMessagesAtTop = async (): Promise<"stop" | void> => {
      const anchor = timelineScrollAnchorRef.current;
      const previousLoadViewport = lastTopLoadViewportRef.current;
      const bottomLocked = followEndController.getSnapshot() === "following";
      const needsMoreContentToFillViewport =
        anchor !== null && anchor.scrollHeight <= anchor.clientHeight;
      if (
        anchor?.conversationId === activeConversationId &&
        activeConversationId === viewModel.rail.activeConversationId &&
        viewModel.detail.hasOlderMessages &&
        !viewModel.detail.isLoadingOlderMessages &&
        !showTimelineSkeleton &&
        (!bottomLocked || needsMoreContentToFillViewport)
      ) {
        if (
          previousLoadViewport?.conversationId === activeConversationId &&
          previousLoadViewport.contentHeightPx === anchor.scrollHeight &&
          previousLoadViewport.scrollTopPx === anchor.scrollTop
        ) {
          lastTopLoadViewportRef.current = null;
          return "stop";
        }
        lastTopLoadViewportRef.current = {
          contentHeightPx: anchor.scrollHeight,
          conversationId: activeConversationId,
          scrollTopPx: anchor.scrollTop
        };
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: anchor.scrollHeight,
          scrollTop: anchor.scrollTop
        };
        await actions.loadOlderConversationMessages();
        return;
      }
      return "stop";
    };
    virtualScrollController.setTopLoadingHandler(loadOlderMessagesAtTop);

    const captureVirtualViewport = (
      snapshot: AgentTranscriptViewportSnapshot
    ): void => {
      const isAtEnd = isAgentConversationViewportAtEnd(
        snapshot.distanceFromBottomPx
      );
      setIsTimelineScrolledToBottom(
        isAgentConversationViewportAtEnd(snapshot.contentDistanceFromBottomPx)
      );
      if (
        followEndController.getSnapshot() === "detached" &&
        userScrollDirectionRef.current === "toward-end" &&
        isAtEnd
      ) {
        dispatchFollowEnd("user-reached-end");
      }
      writeTimelineScrollAnchor({
        clientHeight: snapshot.viewportHeightPx,
        conversationId: activeConversationId,
        scrollHeight: snapshot.contentHeightPx,
        scrollTop: snapshot.scrollTopPx
      });
      if (snapshot.scrollTopPx > AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX) {
        lastTopLoadViewportRef.current = null;
      }
      setIsTimelineScrolledToTop(
        snapshot.scrollTopPx <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
    };
    const captureUserScroll = (direction: "away" | "toward-end"): void => {
      userScrollDirectionRef.current = direction;
      if (direction === "away") {
        dispatchFollowEnd("user-scrolled-away");
      }
    };

    const unsubscribeViewport = virtualScrollController.subscribeViewport(
      captureVirtualViewport
    );
    const unsubscribeUserScroll =
      virtualScrollController.subscribeUserScroll(captureUserScroll);
    return () => {
      virtualScrollController.setTopLoadingHandler(null);
      unsubscribeViewport();
      unsubscribeUserScroll();
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
    viewModel.detail.isLoadingOlderMessages,
    writeTimelineScrollAnchor
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
    if (!virtualScrollController) {
      return;
    }
    dispatchFollowEnd("scroll-to-end-requested");
    userScrollDirectionRef.current = null;
    virtualScrollController.scrollToEnd({
      behavior: userScrollBehavior()
    });
  }, [
    dispatchFollowEnd,
    isVisible,
    timelineConversationId,
    viewModel.rail.activeConversationId,
    virtualScrollControllerRef
  ]);

  return {
    followEndMode,
    isTimelineScrolledToBottom,
    isTimelineScrolledToTop,
    setVirtualScrollController,
    scrollTimelineToBottom
  };
}
