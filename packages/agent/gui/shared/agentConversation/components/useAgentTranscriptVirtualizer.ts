import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { requestUiAnimationFrame } from "./agentTranscriptPresentationScheduler";
import { useElementResizeObserver } from "@tutti-os/ui-react-hooks";
import {
  buildAgentTranscriptVirtualLayout,
  agentTranscriptVirtualLayoutsEqual,
  agentTranscriptVirtualViewportRenderStateChanged as viewportRenderChanged,
  compensateAgentTranscriptDistanceForAnchor,
  findAgentTranscriptCompensationAnchor,
  findAgentTranscriptTurnIndexAtOffset,
  findAgentTranscriptVirtualRange,
  projectAgentTranscriptVirtualRange,
  updateAgentTranscriptVirtualViewportState,
  AGENT_TRANSCRIPT_INITIAL_VIEWPORT_HEIGHT_PX,
  type AgentTranscriptVirtualViewportState
} from "./agentTranscriptVirtualizerLayout";
import {
  agentTranscriptPhysicalDistanceForIndex,
  agentTranscriptPhysicalDistanceForOffset
} from "./agentTranscriptVirtualizerScrollTargets";
import {
  readAgentTranscriptVirtualMeasurements,
  writeAgentTranscriptVirtualMeasurements
} from "./agentTranscriptVirtualMeasurementStore";
import {
  prepareAgentTranscriptMeasurement,
  type AgentTranscriptPreparedMeasurement
} from "./agentTranscriptMeasurementPreparation";
import { useAgentTranscriptLayoutPreservation } from "./useAgentTranscriptLayoutPreservation";
import { useAgentTranscriptMeasurements } from "./useAgentTranscriptMeasurements";
import { useAgentTranscriptResponseSpacer } from "./useAgentTranscriptResponseSpacer";
import { useAgentTranscriptVirtualLocate } from "./useAgentTranscriptVirtualLocate";
import { buildAgentTranscriptVirtualItems } from "./agentTranscriptVirtualItems";
import type {
  AgentTranscriptRowVirtualizer,
  AgentTranscriptVirtualizer,
  AgentTranscriptVirtualizerInput,
  AgentTranscriptVirtualItem
} from "./agentTranscriptVirtualizerTypes";

export type {
  AgentTranscriptRowVirtualizer,
  AgentTranscriptViewportSnapshot,
  AgentTranscriptVirtualItem,
  AgentTranscriptVirtualScrollController
} from "./agentTranscriptVirtualizerTypes";
import {
  agentTranscriptDistanceFromBottom,
  agentTranscriptDistanceFromTop,
  agentTranscriptLogicalScrollTop,
  agentTranscriptNativeScrollTopForDistance,
  cancelAgentTranscriptScroll,
  connectAgentTranscriptScrollInput,
  hasActiveAgentTranscriptScroll,
  readAgentTranscriptScrollPadding,
  setAgentTranscriptScrollTop,
  AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX
} from "./agentTranscriptScrollController";
import { useAgentTranscriptViewportSubscriptions } from "./useAgentTranscriptViewportSubscriptions";
const AGENT_TRANSCRIPT_END_THRESHOLD_PX = 24;

export function useAgentTranscriptVirtualizer({
  agentSessionId,
  entries,
  followEndMode = "following",
  isLatestTurnInProgress = false,
  latestTurnKey = null,
  virtualScrollControllerRef
}: AgentTranscriptVirtualizerInput): AgentTranscriptVirtualizer {
  const retainedMeasurements = useMemo(
    () => readAgentTranscriptVirtualMeasurements(agentSessionId),
    [agentSessionId]
  );
  const preserveBeforeMeasurementCommitRef = useRef<() => void>(() => {});
  const prepareMeasurementCommitRef = useRef<
    (nextHeightsByKey: Readonly<Record<string, number>>) => void
  >(() => {});
  const {
    disconnect: disconnectMeasurements,
    measureElement,
    measuredElementsRef,
    measuredHeightsByKey,
    measuredHeightsRef,
    syncMountedElements
  } = useAgentTranscriptMeasurements(
    retainedMeasurements?.turnHeightsByKey ?? {},
    () => preserveBeforeMeasurementCommitRef.current(),
    (nextHeightsByKey) => prepareMeasurementCommitRef.current(nextHeightsByKey)
  );
  const layout = useMemo(
    () => buildAgentTranscriptVirtualLayout(entries, measuredHeightsByKey),
    [entries, measuredHeightsByKey]
  );
  const [virtualViewportState, setVirtualViewportState] =
    useState<AgentTranscriptVirtualViewportState>(() => {
      const renderedRange = findAgentTranscriptVirtualRange({
        distanceFromBottomPx: 0,
        layout,
        viewportHeightPx: AGENT_TRANSCRIPT_INITIAL_VIEWPORT_HEIGHT_PX
      });
      return {
        distanceFromBottomPx: 0,
        renderedRange,
        turnKeys: layout.turnKeys,
        viewportHeightPx: AGENT_TRANSCRIPT_INITIAL_VIEWPORT_HEIGHT_PX
      };
    });
  const [locatingTurnKey, setLocatingTurnKey] = useState<string | null>(null);
  const virtualizerHostRef = useRef<HTMLDivElement | null>(null);
  const resizeObservation = useElementResizeObserver();
  const layoutRef = useRef(layout);
  const nextLayoutRef = useRef(layout);
  const layoutRevisionRef = useRef(0);
  const virtualViewportRef = useRef(virtualViewportState);
  const scrollTopRef = useRef(0);
  const physicalDistanceFromBottomRef = useRef(0);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const disconnectScrollElementRef = useRef<(() => void) | null>(null);
  const scrollMarginRef = useRef(0);
  const committedScrollMarginRef = useRef(0);
  const scrollPaddingBottomRef = useRef(0);
  const scrollPaddingBottomBaseRef = useRef(0);
  const scrollPaddingBottomAdjustmentRef = useRef(0);
  const scrollPaddingTopRef = useRef(0);
  const {
    activationKey: responseSpacerActivationKey,
    dismissHeight: dismissResponseSpacer,
    growHeight: growResponseSpacerHeight,
    heightPx: responseSpacerHeightPx,
    heightRef: responseSpacerHeightRef,
    updateForViewportRef: updateResponseSpacerForViewportRef
  } = useAgentTranscriptResponseSpacer({
    agentSessionId,
    bottomInsetPx: () =>
      scrollPaddingBottomBaseRef.current +
      scrollPaddingBottomAdjustmentRef.current,
    followEndMode,
    isLatestTurnInProgress,
    latestTurnKey
  });
  const topLoadingHandlerRef = useRef<(() => Promise<"stop" | void>) | null>(
    null
  );
  const topLoadingInFlightRef = useRef(false);
  const followsEndRef = useRef(followEndMode === "following");
  const responseSpacerActivationKeyRef = useRef<string | null>(
    responseSpacerActivationKey
  );
  const committedResponseSpacerHeightRef = useRef(responseSpacerHeightPx);
  const activeLocateRef = useRef<object | null>(null);
  const pendingMeasuredLayoutRef =
    useRef<AgentTranscriptPreparedMeasurement | null>(null);
  const getDistanceFromBottomPx = useCallback(
    () => physicalDistanceFromBottomRef.current,
    []
  );
  const layoutPreservation = useAgentTranscriptLayoutPreservation({
    getDistanceFromBottomPx,
    scrollElementRef,
    scrollPaddingBottomRef
  });
  preserveBeforeMeasurementCommitRef.current =
    layoutPreservation.preserveForNextLayout;
  if (nextLayoutRef.current !== layout) {
    nextLayoutRef.current = layout;
    layoutRevisionRef.current += 1;
  }
  if (responseSpacerHeightRef.current !== responseSpacerHeightPx) {
    responseSpacerHeightRef.current = responseSpacerHeightPx;
    layoutRevisionRef.current += 1;
  }
  followsEndRef.current = followEndMode === "following";
  if (
    responseSpacerActivationKey !== null &&
    responseSpacerActivationKeyRef.current !== responseSpacerActivationKey
  ) {
    responseSpacerActivationKeyRef.current = responseSpacerActivationKey;
    layoutRevisionRef.current += 1;
  }
  const commitVirtualViewport = useCallback(
    (
      nextDistanceFromBottomPx: number,
      nextViewportHeightPx: number,
      nextLayout = layoutRef.current
    ) => {
      const previousState = virtualViewportRef.current;
      const nextState = updateAgentTranscriptVirtualViewportState({
        current: previousState,
        distanceFromBottomPx: nextDistanceFromBottomPx,
        layout: nextLayout,
        viewportHeightPx: nextViewportHeightPx
      });
      const shouldRender = viewportRenderChanged(previousState, nextState);
      virtualViewportRef.current = nextState;
      if (shouldRender) setVirtualViewportState(nextState);
    },
    []
  );
  prepareMeasurementCommitRef.current = (nextHeightsByKey) => {
    const previousLayout = layoutRef.current;
    const preservedDistance = layoutPreservation.consumeDistance();
    const currentPhysicalDistance =
      preservedDistance ?? physicalDistanceFromBottomRef.current;
    const currentLogicalDistance = Math.max(
      0,
      currentPhysicalDistance - responseSpacerHeightRef.current
    );
    const prepared = prepareAgentTranscriptMeasurement({
      currentLogicalDistanceFromBottomPx: currentLogicalDistance,
      currentPhysicalDistanceFromBottomPx: currentPhysicalDistance,
      entries,
      measuredHeightsByKey: measuredHeightsRef.current,
      nextHeightsByKey,
      preserveMeasuredTurnViewport: !isLatestTurnInProgress,
      previousLayout,
      responseSpacerHeightPx: responseSpacerHeightRef.current
    });
    if (!prepared) return;
    pendingMeasuredLayoutRef.current = prepared;
    commitVirtualViewport(
      prepared.logicalDistanceFromBottomPx,
      virtualViewportRef.current.viewportHeightPx,
      prepared.layout
    );
  };
  const {
    notifyUserScrollListeners,
    notifyViewportListeners,
    subscribeUserScroll,
    subscribeViewport
  } = useAgentTranscriptViewportSubscriptions({
    layoutRef,
    physicalDistanceFromBottomRef,
    responseSpacerHeightRef,
    scrollMarginRef,
    scrollPaddingBottomRef,
    scrollPaddingTopRef,
    scrollTopRef,
    virtualViewportRef
  });
  const loadOlderWhileAtTop = useCallback(async (): Promise<void> => {
    if (topLoadingInFlightRef.current) return;
    topLoadingInFlightRef.current = true;
    try {
      for (;;) {
        const element = scrollElementRef.current;
        const handler = topLoadingHandlerRef.current;
        if (
          !element ||
          !handler ||
          agentTranscriptDistanceFromTop(element) >
            AGENT_TRANSCRIPT_TOP_LOADING_THRESHOLD_PX
        ) {
          return;
        }
        if ((await handler()) === "stop") return;
        await new Promise<void>((resolve) => {
          requestUiAnimationFrame(() => resolve());
        });
      }
    } finally {
      topLoadingInFlightRef.current = false;
    }
  }, []);
  const commitFromScrollElement = useCallback(
    (
      element: HTMLElement,
      viewportHeightPx = virtualViewportRef.current.viewportHeightPx,
      committedLayout = layoutRef.current
    ): number => {
      const actualScrollTop = element.scrollTop;
      const actualDistance = agentTranscriptDistanceFromBottom(
        actualScrollTop,
        scrollPaddingBottomRef.current
      );
      physicalDistanceFromBottomRef.current = actualDistance;
      scrollTopRef.current = agentTranscriptLogicalScrollTop(
        actualScrollTop,
        viewportHeightPx,
        scrollMarginRef.current,
        committedLayout.totalHeightPx,
        scrollPaddingBottomRef.current + responseSpacerHeightRef.current
      );
      const logicalDistance = Math.max(
        0,
        actualDistance - responseSpacerHeightRef.current
      );
      commitVirtualViewport(logicalDistance, viewportHeightPx, committedLayout);
      notifyViewportListeners();
      return actualDistance;
    },
    [commitVirtualViewport, notifyViewportListeners]
  );
  const applyPhysicalDistance = useCallback(
    (nextDistanceFromBottomPx: number, behavior: ScrollBehavior = "auto") => {
      const element = scrollElementRef.current;
      if (!element) return;
      const nextDistance = Math.max(0, nextDistanceFromBottomPx);
      const nativeScrollTop = agentTranscriptNativeScrollTopForDistance(
        nextDistance,
        scrollPaddingBottomRef.current
      );
      setAgentTranscriptScrollTop(element, nativeScrollTop, behavior, () =>
        commitFromScrollElement(element)
      );
    },
    [commitFromScrollElement]
  );
  const scrollToEnd = useCallback(
    (options?: { behavior?: ScrollBehavior }) => {
      const scrollInstantly =
        isLatestTurnInProgress || responseSpacerHeightRef.current > 0;
      dismissResponseSpacer();
      applyPhysicalDistance(0, scrollInstantly ? "auto" : options?.behavior);
    },
    [applyPhysicalDistance, dismissResponseSpacer, isLatestTurnInProgress]
  );
  const scrollToOffset = useCallback(
    (offset: number, options?: { behavior?: ScrollBehavior }) => {
      applyPhysicalDistance(
        agentTranscriptPhysicalDistanceForOffset({
          layout: layoutRef.current,
          offset,
          responseSpacerHeightPx: responseSpacerHeightRef.current,
          scrollMarginPx: scrollMarginRef.current,
          scrollPaddingBottomPx: scrollPaddingBottomRef.current,
          viewportHeightPx: virtualViewportRef.current.viewportHeightPx
        }),
        options?.behavior
      );
    },
    [applyPhysicalDistance]
  );
  const connectScrollElement = useCallback(
    (nextScrollElement: HTMLElement | null): void => {
      if (scrollElementRef.current === nextScrollElement) return;
      disconnectScrollElementRef.current?.();
      disconnectScrollElementRef.current = null;
      scrollElementRef.current = nextScrollElement;
      if (!nextScrollElement) return;
      const previousOverflowAnchor = nextScrollElement.style.overflowAnchor;
      nextScrollElement.style.overflowAnchor = "none";
      const refreshScrollPadding = (): void => {
        const padding = readAgentTranscriptScrollPadding(nextScrollElement);
        scrollPaddingBottomBaseRef.current = padding.bottom;
        scrollPaddingBottomRef.current =
          padding.bottom + scrollPaddingBottomAdjustmentRef.current;
        scrollPaddingTopRef.current = padding.top;
      };
      const updateFromScroll = (): {
        nextDistanceFromBottomPx: number;
        previousDistanceFromBottomPx: number;
      } | null => {
        const nextViewportHeightPx =
          virtualViewportRef.current.viewportHeightPx;
        if (nextViewportHeightPx <= 0) return null;
        const previousDistanceFromBottomPx =
          physicalDistanceFromBottomRef.current;
        if (layoutPreservation.restoreAfterScrollHeightChange() !== null) {
          // The browser may clamp the compensated target. Always commit the
          // actual DOM position below.
        }
        const nextDistanceFromBottomPx =
          commitFromScrollElement(nextScrollElement);
        return {
          nextDistanceFromBottomPx,
          previousDistanceFromBottomPx
        };
      };
      const disconnectInput = connectAgentTranscriptScrollInput({
        element: nextScrollElement,
        getViewportHeightPx: () => virtualViewportRef.current.viewportHeightPx,
        onCancelLayoutPreservation: layoutPreservation.cancel,
        onDirection: notifyUserScrollListeners,
        onScroll: updateFromScroll,
        onUserScrollToTop: () => {
          void loadOlderWhileAtTop();
        },
        onWheelDelta: layoutPreservation.addWheelDelta
      });
      const disconnectResize = resizeObservation.observe(
        nextScrollElement,
        (entry) => {
          const nextViewportHeightPx =
            entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (nextViewportHeightPx <= 0) return;
          updateResponseSpacerForViewportRef.current(nextViewportHeightPx);
          if (hasActiveAgentTranscriptScroll(nextScrollElement)) {
            commitFromScrollElement(nextScrollElement, nextViewportHeightPx);
            return;
          }
          const nextDistance = followsEndRef.current
            ? 0
            : physicalDistanceFromBottomRef.current;
          setAgentTranscriptScrollTop(
            nextScrollElement,
            agentTranscriptNativeScrollTopForDistance(
              nextDistance,
              scrollPaddingBottomRef.current
            ),
            "auto",
            () =>
              commitFromScrollElement(nextScrollElement, nextViewportHeightPx)
          );
        }
      );
      refreshScrollPadding();
      const initialViewportHeightPx = nextScrollElement.clientHeight;
      if (initialViewportHeightPx > 0) {
        updateResponseSpacerForViewportRef.current(initialViewportHeightPx);
        setAgentTranscriptScrollTop(
          nextScrollElement,
          agentTranscriptNativeScrollTopForDistance(
            0,
            scrollPaddingBottomRef.current
          ),
          "auto",
          () =>
            commitFromScrollElement(nextScrollElement, initialViewportHeightPx)
        );
      }
      disconnectScrollElementRef.current = () => {
        scrollPaddingBottomRef.current = 0;
        scrollPaddingBottomBaseRef.current = 0;
        scrollPaddingTopRef.current = 0;
        nextScrollElement.style.overflowAnchor = previousOverflowAnchor;
        disconnectInput();
        disconnectResize();
      };
    },
    [
      notifyUserScrollListeners,
      commitFromScrollElement,
      layoutPreservation.addWheelDelta,
      layoutPreservation.cancel,
      layoutPreservation.restoreAfterScrollHeightChange,
      loadOlderWhileAtTop,
      resizeObservation
    ]
  );
  const syncLayout = useCallback(
    (scrollMarginPx?: number): void => {
      updateResponseSpacerForViewportRef.current(
        virtualViewportRef.current.viewportHeightPx
      );
      if (scrollMarginPx !== undefined) {
        scrollMarginRef.current = scrollMarginPx;
      }
      const element = scrollElementRef.current;
      const previousLayout = layoutRef.current;
      const nextLayout = nextLayoutRef.current;
      const layoutChanged = !agentTranscriptVirtualLayoutsEqual(
        previousLayout,
        nextLayout
      );
      const pendingMeasuredLayout = pendingMeasuredLayoutRef.current;
      const hasPreparedMeasurementCommit =
        pendingMeasuredLayout !== null &&
        agentTranscriptVirtualLayoutsEqual(
          pendingMeasuredLayout.layout,
          nextLayout
        );
      if (hasPreparedMeasurementCommit) {
        pendingMeasuredLayoutRef.current = null;
      }
      if (
        !layoutChanged &&
        committedScrollMarginRef.current === scrollMarginRef.current &&
        committedResponseSpacerHeightRef.current ===
          responseSpacerHeightRef.current
      ) {
        layoutRef.current = nextLayout;
        return;
      }
      if (layoutChanged && !hasPreparedMeasurementCommit) {
        const preservedDistance = layoutPreservation.consumeDistance();
        if (preservedDistance !== null) {
          commitVirtualViewport(
            Math.max(0, preservedDistance - responseSpacerHeightRef.current),
            virtualViewportRef.current.viewportHeightPx,
            previousLayout
          );
        }
      }
      let nextLogicalDistance =
        hasPreparedMeasurementCommit && pendingMeasuredLayout
          ? pendingMeasuredLayout.logicalDistanceFromBottomPx
          : virtualViewportRef.current.distanceFromBottomPx;
      let nextPhysicalDistance: number | null =
        hasPreparedMeasurementCommit && pendingMeasuredLayout
          ? pendingMeasuredLayout.physicalScrollDistanceFromBottomPx
          : null;
      const anchorKey = hasPreparedMeasurementCommit
        ? null
        : findAgentTranscriptCompensationAnchor({
            distanceFromBottomPx: nextLogicalDistance,
            fallbackRange: virtualViewportRef.current.renderedRange,
            layout: previousLayout,
            measuredHeightsByKey: measuredHeightsRef.current,
            viewportHeightPx: virtualViewportRef.current.viewportHeightPx
          });
      if (
        !hasPreparedMeasurementCommit &&
        followsEndRef.current &&
        responseSpacerHeightRef.current <= 0 &&
        activeLocateRef.current === null
      ) {
        nextLogicalDistance = 0;
        nextPhysicalDistance = 0;
      } else if (!hasPreparedMeasurementCommit && anchorKey) {
        nextLogicalDistance =
          compensateAgentTranscriptDistanceForAnchor({
            anchorKey,
            distanceFromBottomPx: nextLogicalDistance,
            nextLayout,
            previousLayout
          }) ?? nextLogicalDistance;
        nextPhysicalDistance =
          nextLogicalDistance + responseSpacerHeightRef.current;
      }
      if (
        hasPreparedMeasurementCommit &&
        pendingMeasuredLayout &&
        pendingMeasuredLayout.latestTurnHeightDeltaPx !== 0 &&
        followsEndRef.current
      ) {
        const targetPhysicalDistance =
          physicalDistanceFromBottomRef.current +
          pendingMeasuredLayout.latestTurnHeightDeltaPx;
        if (
          responseSpacerHeightRef.current > 24 &&
          targetPhysicalDistance < 0
        ) {
          growResponseSpacerHeight(-targetPhysicalDistance);
        }
        nextPhysicalDistance = Math.max(0, targetPhysicalDistance);
      }
      if (
        pendingMeasuredLayout?.physicalScrollDistanceFromBottomPx !== null &&
        pendingMeasuredLayout?.physicalScrollDistanceFromBottomPx !== undefined
      ) {
        nextPhysicalDistance =
          pendingMeasuredLayout.physicalScrollDistanceFromBottomPx;
      }
      layoutRef.current = nextLayout;
      committedScrollMarginRef.current = scrollMarginRef.current;
      committedResponseSpacerHeightRef.current =
        responseSpacerHeightRef.current;
      if (
        element &&
        activeLocateRef.current === null &&
        !hasActiveAgentTranscriptScroll(element) &&
        nextPhysicalDistance !== null
      ) {
        const nextNativeScrollTop = agentTranscriptNativeScrollTopForDistance(
          nextPhysicalDistance,
          scrollPaddingBottomRef.current
        );
        setAgentTranscriptScrollTop(
          element,
          nextNativeScrollTop,
          "auto",
          () => {
            commitFromScrollElement(
              element,
              virtualViewportRef.current.viewportHeightPx,
              nextLayout
            );
          }
        );
        return;
      }
      if (element) {
        commitFromScrollElement(
          element,
          virtualViewportRef.current.viewportHeightPx,
          nextLayout
        );
        return;
      }
      commitVirtualViewport(
        nextLogicalDistance,
        virtualViewportRef.current.viewportHeightPx,
        nextLayout
      );
      notifyViewportListeners();
    },
    [
      commitFromScrollElement,
      commitVirtualViewport,
      layoutPreservation.consumeDistance,
      notifyViewportListeners
    ]
  );
  const getVirtualItems = useCallback(
    (): readonly AgentTranscriptVirtualItem[] =>
      buildAgentTranscriptVirtualItems({
        layout: layoutRef.current,
        measuredHeightsByKey: measuredHeightsRef.current,
        range: virtualViewportRef.current.renderedRange
      }),
    []
  );
  const scrollToIndex = useCallback(
    (
      index: number,
      options: { align: "center" | "top"; behavior?: ScrollBehavior }
    ) => {
      const nextDistance = agentTranscriptPhysicalDistanceForIndex({
        align: options.align,
        layout: layoutRef.current,
        responseSpacerHeightPx: responseSpacerHeightRef.current,
        turnIndex: index,
        viewportHeightPx: virtualViewportRef.current.viewportHeightPx
      });
      if (nextDistance !== null)
        applyPhysicalDistance(nextDistance, options.behavior);
    },
    [applyPhysicalDistance]
  );
  const { cancelLocate, scrollToKey } = useAgentTranscriptVirtualLocate({
    activeLocateRef,
    applyDistance: applyPhysicalDistance,
    layoutRef,
    measuredElementsRef,
    scrollElementRef,
    scrollPaddingBottomRef,
    scrollPaddingTopRef,
    scrollToIndex,
    setLocatingTurnKey,
    viewportStateRef: virtualViewportRef,
    virtualizerHostRef
  });
  const rowVirtualizer = useMemo<AgentTranscriptRowVirtualizer>(
    () => ({
      get scrollOffset() {
        return scrollElementRef.current ? scrollTopRef.current : null;
      },
      get scrollRect() {
        const height = scrollElementRef.current?.clientHeight;
        return height === undefined ? null : { height };
      },
      getVirtualItemForOffset: (offset) => {
        const index = findAgentTranscriptTurnIndexAtOffset(
          layoutRef.current,
          offset - scrollMarginRef.current
        );
        return index === null ? undefined : { index };
      },
      getVirtualItems,
      measureElement,
      syncMeasurements: syncMountedElements,
      subscribeViewport,
      connectScrollElement,
      scrollToIndex,
      scrollToKey,
      syncLayout
    }),
    [
      connectScrollElement,
      getVirtualItems,
      measureElement,
      scrollToIndex,
      scrollToKey,
      subscribeViewport,
      syncMountedElements,
      syncLayout
    ]
  );
  const virtualItems = useMemo<readonly AgentTranscriptVirtualItem[]>(() => {
    const renderedRange = projectAgentTranscriptVirtualRange({
      current: virtualViewportState,
      layout,
      locatingTurnKey
    });
    return buildAgentTranscriptVirtualItems({
      layout,
      measuredHeightsByKey,
      range: renderedRange
    });
  }, [layout, locatingTurnKey, measuredHeightsByKey, virtualViewportState]);
  const renderedRange = projectAgentTranscriptVirtualRange({
    current: virtualViewportState,
    layout,
    locatingTurnKey
  });
  useImperativeHandle(
    virtualScrollControllerRef,
    () => ({
      agentSessionId,
      enabled: true,
      cancelScroll: () => {
        const element = scrollElementRef.current;
        if (element) cancelAgentTranscriptScroll(element);
      },
      isAtEnd: (threshold = AGENT_TRANSCRIPT_END_THRESHOLD_PX) =>
        physicalDistanceFromBottomRef.current <= threshold,
      scrollToOffset,
      scrollToEnd,
      setTopLoadingHandler: (handler) => {
        topLoadingHandlerRef.current = handler;
      },
      subscribeUserScroll,
      subscribeViewport,
      syncViewport: ({ followEnd, scrollPaddingBottomAdjustmentPx = 0 }) => {
        const element = scrollElementRef.current;
        if (!element) return;
        scrollPaddingBottomAdjustmentRef.current = Math.max(
          0,
          scrollPaddingBottomAdjustmentPx
        );
        scrollPaddingBottomRef.current =
          scrollPaddingBottomBaseRef.current +
          scrollPaddingBottomAdjustmentRef.current;
        updateResponseSpacerForViewportRef.current(
          virtualViewportRef.current.viewportHeightPx
        );
        if (hasActiveAgentTranscriptScroll(element)) {
          commitFromScrollElement(element);
          return;
        }
        if (followEnd) {
          applyPhysicalDistance(0);
          return;
        }
        applyPhysicalDistance(physicalDistanceFromBottomRef.current);
      }
    }),
    [
      agentSessionId,
      applyPhysicalDistance,
      commitFromScrollElement,
      scrollToOffset,
      scrollToEnd,
      subscribeUserScroll,
      subscribeViewport
    ]
  );
  const setVirtualizerHostElement = useCallback(
    (node: HTMLDivElement | null): void => {
      virtualizerHostRef.current = node;
      if (node) return;
      queueMicrotask(() => {
        if (virtualizerHostRef.current !== null) return;
        cancelLocate();
        topLoadingHandlerRef.current = null;
        layoutPreservation.cancel();
        connectScrollElement(null);
        disconnectMeasurements();
        resizeObservation.disconnect();
        const currentLayout = layoutRef.current;
        const retainedHeights: Record<string, number> = {};
        for (const key of currentLayout.turnKeys) {
          const height = measuredHeightsRef.current[key];
          if (height !== undefined) retainedHeights[key] = height;
        }
        writeAgentTranscriptVirtualMeasurements(agentSessionId, {
          turnHeightsByKey: retainedHeights
        });
      });
    },
    []
  );
  return {
    layoutRevision: layoutRevisionRef.current,
    responseSpacerHeightPx,
    rowVirtualizer,
    setVirtualizerHostElement,
    totalHeightPx: layout.totalHeightPx,
    virtualItems,
    virtualizerHostRef,
    windowOffsetPx:
      layout.topOffsetsPx[renderedRange.startIndex] ?? layout.totalHeightPx
  };
}
