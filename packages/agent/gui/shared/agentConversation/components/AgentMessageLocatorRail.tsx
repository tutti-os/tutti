import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type PointerEvent
} from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import {
  findMessageLocatorScrollParent,
  useAgentMessageLocatorSelection
} from "./useAgentMessageLocatorSelection";
import { useAgentMessageLocatorElementRef } from "./useAgentMessageLocatorElementRef";
import { escapeCssString } from "./agentTranscriptModel";
import {
  AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX,
  AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX,
  AgentMessageLocatorSurface,
  scrollMessageLocatorViewportToIndex
} from "./AgentMessageLocatorSurface";
import {
  findTranscriptLocatorTarget,
  findKeyboardEventTimeline,
  findKeyboardLocatorTarget,
  highlightTranscriptLocatorTarget,
  scrollKeyboardTranscriptLocatorTarget,
  scrollMountedTranscriptLocatorTarget,
  waitForTranscriptLocatorTarget,
  type AgentMessageLocatorLocateOptions,
  type AgentMessageLocatorVisibleFrame
} from "./agentMessageLocatorNavigation";
import type { AgentTranscriptLocateOperation } from "./useAgentTranscriptLocateOperation";
import type { AgentTranscriptViewportSnapshot } from "./useAgentTranscriptVirtualizer";

export { findMessageLocatorScrollParent } from "./useAgentMessageLocatorSelection";
export { scrollTranscriptRowIntoView } from "./agentMessageLocatorNavigation";
export type { AgentMessageLocatorLocateOptions } from "./agentMessageLocatorNavigation";

const AGENT_MESSAGE_LOCATOR_PANEL_FADE_MS = 160;
const AGENT_MESSAGE_LOCATOR_MAX_HEIGHT_PX = 640;
const AGENT_MESSAGE_LOCATOR_MIN_ITEMS = 2;
const AGENT_MESSAGE_LOCATOR_TEMP_DIAGNOSTIC_MARKER =
  "[TEMP:locator-infinite-scroll]";

export function AgentMessageLocatorRail({
  agentSessionId,
  diagnosticRuntime,
  items,
  isConversationHistoryComplete = true,
  isVisible = true,
  label,
  locateOperation,
  onLocate,
  viewportSource
}: {
  agentSessionId?: string;
  diagnosticRuntime?: Pick<AgentActivityRuntime, "reportDiagnostic">;
  items: readonly AgentMessageLocatorItem[];
  isConversationHistoryComplete?: boolean;
  isVisible?: boolean;
  label?: string;
  locateOperation: AgentTranscriptLocateOperation;
  onLocate: (
    item: AgentMessageLocatorItem,
    options?: AgentMessageLocatorLocateOptions
  ) => void | Promise<HTMLElement | null>;
  viewportSource: {
    subscribeViewport(
      listener: (snapshot: AgentTranscriptViewportSnapshot) => void
    ): () => void;
  };
}): JSX.Element | null {
  const locatorRef = useRef<HTMLElement | null>(null);
  const locatorViewportRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const diagnosticItemsRef = useRef<readonly AgentMessageLocatorItem[] | null>(
    null
  );
  const locatorAlignmentInputsRef = useRef<{
    isIdleMounted: boolean;
    isVisible: boolean;
    items: readonly AgentMessageLocatorItem[];
    scrubTargetKey: string | null;
    visibleActiveKey: string | null;
    visibleFrame: AgentMessageLocatorVisibleFrame | null;
  } | null>(null);
  const closePanelTimeoutRef = useRef<number | null>(null);
  const scrubPointerIdRef = useRef<number | null>(null);
  const scrubItemKeyRef = useRef<string | null>(null);
  const scrubCaptureTargetRef = useRef<HTMLElement | null>(null);
  const scrubMovedRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isIdleMounted, setIsIdleMounted] = useState(false);
  const [shouldRenderPanel, setShouldRenderPanel] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrubTargetKey, setScrubTargetKey] = useState<string | null>(null);
  const { activeKey: visibleActiveKey, visibleKeys } =
    useAgentMessageLocatorSelection({
      items,
      isVisible:
        isVisible &&
        isIdleMounted &&
        isConversationHistoryComplete &&
        items.length >= AGENT_MESSAGE_LOCATOR_MIN_ITEMS,
      locatorRef
    });
  const previousAgentResponseByKeyRef = useRef<ReadonlyMap<
    string,
    boolean
  > | null>(null);
  const [unreadAgentResponseKeys, setUnreadAgentResponseKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const [visibleFrame, setVisibleFrame] =
    useState<AgentMessageLocatorVisibleFrame | null>(null);
  const reportLocatorDiagnostic = useCallback(
    (event: string, details: Record<string, unknown>): void => {
      const reportDiagnostic = diagnosticRuntime?.reportDiagnostic;
      if (!reportDiagnostic) return;
      const result = reportDiagnostic.call(diagnosticRuntime, {
        details: {
          agentSessionId: agentSessionId ?? null,
          ...details
        },
        event: `${AGENT_MESSAGE_LOCATOR_TEMP_DIAGNOSTIC_MARKER} ${event}`,
        level: "info",
        source: "agent-gui"
      });
      void Promise.resolve(result).then(undefined, () => {});
    },
    [agentSessionId, diagnosticRuntime]
  );
  const itemByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item])),
    [items]
  );
  const cancelLocateOperation = useCallback((): void => {
    locateOperation.cancel();
  }, [locateOperation]);
  const markItemRead = useCallback((itemKey: string): void => {
    setUnreadAgentResponseKeys((currentUnreadKeys) => {
      if (!currentUnreadKeys.has(itemKey)) {
        return currentUnreadKeys;
      }
      const nextUnreadKeys = new Set(currentUnreadKeys);
      nextUnreadKeys.delete(itemKey);
      return nextUnreadKeys;
    });
  }, []);
  const handleLocateItem = useCallback(
    (
      item: AgentMessageLocatorItem,
      options: AgentMessageLocatorLocateOptions = {
        align: "top",
        behavior: "smooth"
      }
    ): void => {
      const signal = locateOperation.begin();
      setActiveKey(item.key);
      markItemRead(item.key);
      const locator = locatorRef.current;
      const scrollParent = locator
        ? findMessageLocatorScrollParent(locator)
        : null;
      if (!scrollParent || signal.aborted) {
        return;
      }
      const mountedTarget = findTranscriptLocatorTarget(scrollParent, item.key);
      if (mountedTarget) {
        scrollMountedTranscriptLocatorTarget(mountedTarget, options.behavior);
        highlightTranscriptLocatorTarget(mountedTarget.scrollElement);
        return;
      }
      const locateOptions = {
        align: options.align,
        behavior: "auto" as const,
        signal
      };
      void Promise.resolve(onLocate(item, locateOptions))
        .then(() => {
          if (signal.aborted) return;
          const revealedTarget = findTranscriptLocatorTarget(
            scrollParent,
            item.key
          );
          if (revealedTarget) {
            highlightTranscriptLocatorTarget(revealedTarget.scrollElement);
          }
        })
        .catch(() => {});
    },
    [locateOperation, markItemRead, onLocate]
  );
  useEffect(() => {
    let cancelIdleMount: (() => void) | undefined;
    if (
      isConversationHistoryComplete &&
      items.length >= AGENT_MESSAGE_LOCATOR_MIN_ITEMS &&
      !isIdleMounted &&
      typeof window.requestIdleCallback === "function" &&
      typeof window.cancelIdleCallback === "function"
    ) {
      // presentation-work: defer mounting the completed-history locator until the browser is idle
      const idleCallbackId = window.requestIdleCallback(
        () => setIsIdleMounted(true),
        { timeout: 2_000 }
      );
      cancelIdleMount = () => window.cancelIdleCallback(idleCallbackId);
    } else if (
      isConversationHistoryComplete &&
      items.length >= AGENT_MESSAGE_LOCATOR_MIN_ITEMS &&
      !isIdleMounted
    ) {
      setIsIdleMounted(true);
    }
    let panelTimeout: number | undefined;
    if (isPanelOpen) {
      setShouldRenderPanel(true);
    } else {
      // timing: keep the panel mounted through its close-fade transition
      panelTimeout = window.setTimeout(
        () => setShouldRenderPanel(false),
        AGENT_MESSAGE_LOCATOR_PANEL_FADE_MS
      );
    }
    return () => {
      cancelIdleMount?.();
      if (panelTimeout !== undefined) window.clearTimeout(panelTimeout);
    };
  }, [isConversationHistoryComplete, isIdleMounted, isPanelOpen, items.length]);
  const setLocatorElement = useAgentMessageLocatorElementRef({
    cancelLocateOperation,
    closePanelTimeoutRef,
    locatorRef
  });
  useEffect(() => {
    if (diagnosticItemsRef.current !== items) {
      diagnosticItemsRef.current = items;
      reportLocatorDiagnostic("items_changed", {
        duplicateKeyCount: duplicateLocatorFieldCount(
          items.map((item) => item.key)
        ),
        duplicateRowKeyCount: duplicateLocatorFieldCount(
          items.map((item) => item.rowKey)
        ),
        itemCount: items.length,
        items: items.slice(0, 100).map((item, index) => ({
          index,
          rowIndex: item.rowIndex,
          summaryHash: locatorDiagnosticHash(item.summary),
          turnGroupIndex: item.turnGroupIndex
        })),
        sampleTruncated: items.length > 100
      });
    }
    const previousAgentResponseByKey = previousAgentResponseByKeyRef.current;
    const currentKeys = new Set(items.map((item) => item.key));

    setUnreadAgentResponseKeys((currentUnreadKeys) => {
      let nextUnreadKeys: Set<string> | null = null;
      const ensureNextUnreadKeys = (): Set<string> => {
        if (!nextUnreadKeys) {
          nextUnreadKeys = new Set(currentUnreadKeys);
        }
        return nextUnreadKeys;
      };

      for (const key of currentUnreadKeys) {
        if (!currentKeys.has(key)) {
          ensureNextUnreadKeys().delete(key);
        }
      }

      if (previousAgentResponseByKey) {
        for (const item of items) {
          const hadAgentResponse =
            previousAgentResponseByKey.get(item.key) ?? false;
          if (
            previousAgentResponseByKey.has(item.key) &&
            item.hasAgentResponse &&
            !hadAgentResponse &&
            !visibleKeys.has(item.key)
          ) {
            ensureNextUnreadKeys().add(item.key);
          }
        }
      }

      for (const key of visibleKeys) {
        if ((nextUnreadKeys ?? currentUnreadKeys).has(key)) {
          ensureNextUnreadKeys().delete(key);
        }
      }

      return nextUnreadKeys ?? currentUnreadKeys;
    });

    previousAgentResponseByKeyRef.current = new Map(
      items.map((item) => [item.key, item.hasAgentResponse])
    );
  }, [items, reportLocatorDiagnostic, visibleKeys]);
  useEffect(() => {
    if (
      !isVisible ||
      !isIdleMounted ||
      !isConversationHistoryComplete ||
      items.length < AGENT_MESSAGE_LOCATOR_MIN_ITEMS
    ) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.defaultPrevented ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }
      const locator = locatorRef.current;
      const scrollParent = locator
        ? findMessageLocatorScrollParent(locator)
        : null;
      if (!scrollParent) {
        return;
      }
      const eventScrollParent = findKeyboardEventTimeline(event);
      if (eventScrollParent !== scrollParent) {
        return;
      }
      const item = findKeyboardLocatorTarget(
        items,
        scrollParent,
        event.key === "ArrowDown" ? "next" : "previous"
      );
      if (!item) {
        return;
      }
      event.preventDefault();
      const signal = locateOperation.begin();
      setActiveKey(item.key);
      markItemRead(item.key);
      const mountedTarget = findTranscriptLocatorTarget(scrollParent, item.key);
      if (mountedTarget) {
        scrollKeyboardTranscriptLocatorTarget(
          scrollParent,
          mountedTarget,
          signal
        );
        return;
      }
      void Promise.resolve(
        onLocate(item, {
          align: "top",
          behavior: "smooth",
          signal
        })
      )
        .then(async () => {
          if (signal.aborted) return;
          const revealedTarget = await waitForTranscriptLocatorTarget(
            scrollParent,
            item.key,
            signal
          );
          if (revealedTarget && !signal.aborted) {
            scrollKeyboardTranscriptLocatorTarget(
              scrollParent,
              revealedTarget,
              signal
            );
          }
        })
        .catch(() => {});
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isConversationHistoryComplete,
    isIdleMounted,
    isVisible,
    items,
    locateOperation,
    markItemRead,
    onLocate
  ]);
  useLayoutEffect(() => {
    if (!isVisible || !isIdleMounted) {
      setVisibleFrame(null);
      return;
    }
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    if (!locator || !scrollParent) {
      return;
    }
    const unsubscribeViewport = viewportSource.subscribeViewport((snapshot) => {
      const nextFrame = {
        heightPx: Math.max(
          0,
          snapshot.viewportHeightPx -
            snapshot.scrollPaddingTopPx -
            snapshot.scrollPaddingBottomPx
        ),
        topOffsetPx: snapshot.scrollPaddingTopPx
      };
      setVisibleFrame((current) =>
        current?.heightPx === nextFrame.heightPx &&
        current.topOffsetPx === nextFrame.topOffsetPx
          ? current
          : nextFrame
      );
    });

    return unsubscribeViewport;
  }, [isIdleMounted, isVisible, viewportSource]);
  useLayoutEffect(() => {
    const previousAlignmentInputs = locatorAlignmentInputsRef.current;
    const alignmentInputs = {
      isIdleMounted,
      isVisible,
      items,
      scrubTargetKey,
      visibleActiveKey,
      visibleFrame
    };
    locatorAlignmentInputsRef.current = alignmentInputs;
    const shouldAlignLocator =
      previousAlignmentInputs === null ||
      previousAlignmentInputs.isIdleMounted !== isIdleMounted ||
      previousAlignmentInputs.isVisible !== isVisible ||
      previousAlignmentInputs.items !== items ||
      previousAlignmentInputs.scrubTargetKey !== scrubTargetKey ||
      previousAlignmentInputs.visibleActiveKey !== visibleActiveKey ||
      previousAlignmentInputs.visibleFrame !== visibleFrame;
    if (
      shouldAlignLocator &&
      isVisible &&
      isIdleMounted &&
      scrubPointerIdRef.current === null
    ) {
      const selectedIndex = visibleActiveKey
        ? items.findIndex((item) => item.key === visibleActiveKey)
        : -1;
      const viewport = locatorViewportRef.current;
      if (selectedIndex >= 0 && viewport) {
        const railHeight =
          (items.length - 1) * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
          AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
        const viewportHeight = Math.min(
          railHeight,
          visibleFrame?.heightPx ?? railHeight
        );
        const scrollTopBefore = viewport.scrollTop;
        scrollMessageLocatorViewportToIndex(
          viewport,
          selectedIndex,
          viewportHeight
        );
        if (viewport.scrollTop !== scrollTopBefore) {
          reportLocatorDiagnostic("selection_autoscroll", {
            scrollHeight: viewport.scrollHeight,
            scrollTopAfter: viewport.scrollTop,
            scrollTopBefore,
            selectedIndex,
            viewportHeight,
            visibleActiveKey
          });
        }
      }
    }
    const panel = panelRef.current;
    const activeOrSelectedKey = activeKey ?? visibleActiveKey;
    if (!isPanelOpen || !panel || !activeOrSelectedKey) return;
    const activeItem = panel.querySelector<HTMLElement>(
      `[data-agent-message-locator-panel-key="${escapeCssString(
        activeOrSelectedKey
      )}"]`
    );
    if (!activeItem) return;
    const itemTop = activeItem.offsetTop;
    const itemBottom = itemTop + activeItem.offsetHeight;
    if (itemTop < panel.scrollTop) {
      panel.scrollTop = itemTop;
    } else if (itemBottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = Math.max(0, itemBottom - panel.clientHeight);
    }
  }, [
    activeKey,
    isIdleMounted,
    isPanelOpen,
    isVisible,
    items,
    reportLocatorDiagnostic,
    visibleActiveKey,
    visibleFrame,
    scrubTargetKey
  ]);

  if (
    !isIdleMounted ||
    !isConversationHistoryComplete ||
    items.length < AGENT_MESSAGE_LOCATOR_MIN_ITEMS
  ) {
    return null;
  }
  const railHeight =
    (items.length - 1) * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const viewportHeight =
    visibleFrame === null
      ? railHeight
      : Math.min(
          railHeight,
          visibleFrame.heightPx,
          AGENT_MESSAGE_LOCATOR_MAX_HEIGHT_PX,
          window.innerHeight * 0.7
        );
  const railActiveKey = scrubTargetKey ?? visibleActiveKey;
  const panelActiveKey = activeKey ?? visibleActiveKey;
  const itemFromTarget = (target: EventTarget | null) => {
    const button =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-agent-message-locator-item-key]")
        : null;
    const key = button?.dataset.agentMessageLocatorItemKey;
    const item = key ? (itemByKey.get(key) ?? null) : null;
    return item && button ? { button, item } : null;
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    const target = itemFromTarget(event.target);
    if (!target) return;
    scrubPointerIdRef.current = event.pointerId;
    scrubItemKeyRef.current = target.item.key;
    scrubCaptureTargetRef.current = target.button;
    scrubMovedRef.current = false;
    setActiveKey(target.item.key);
    setScrubTargetKey(target.item.key);
    target.button.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (scrubPointerIdRef.current === null) {
      const target = itemFromTarget(event.target);
      if (target) setActiveKey(target.item.key);
      return;
    }
    if (
      scrubPointerIdRef.current !== event.pointerId ||
      event.buttons % 2 === 0
    ) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const hitTarget =
      document.elementFromPoint?.(
        rect.left + rect.width / 2,
        Math.max(rect.top, Math.min(event.clientY, rect.bottom - 1))
      ) ?? event.target;
    const target = itemFromTarget(hitTarget);
    if (!target || scrubItemKeyRef.current === target.item.key) return;
    scrubItemKeyRef.current = target.item.key;
    scrubMovedRef.current = true;
    setActiveKey(target.item.key);
    setScrubTargetKey(target.item.key);
    handleLocateItem(target.item, { align: "top", behavior: "auto" });
  };
  const stopPointerScrub = (event: PointerEvent<HTMLDivElement>): void => {
    if (scrubPointerIdRef.current !== event.pointerId) {
      return;
    }
    const captureTarget = scrubCaptureTargetRef.current;
    if (captureTarget?.hasPointerCapture?.(event.pointerId)) {
      captureTarget.releasePointerCapture?.(event.pointerId);
    }
    suppressNextClickRef.current = scrubMovedRef.current;
    scrubPointerIdRef.current = null;
    scrubItemKeyRef.current = null;
    scrubCaptureTargetRef.current = null;
    scrubMovedRef.current = false;
    setScrubTargetKey(null);
  };
  const openPanel = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
      closePanelTimeoutRef.current = null;
    }
    setIsPanelOpen(true);
  };
  const closePanelSoon = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
    }
    // timing: delay closing so pointer can move from trigger into panel content
    closePanelTimeoutRef.current = window.setTimeout(() => {
      closePanelTimeoutRef.current = null;
      setIsPanelOpen(false);
      setActiveKey(null);
    }, 120);
  };
  const closePanelNow = (): void => {
    if (closePanelTimeoutRef.current !== null) {
      window.clearTimeout(closePanelTimeoutRef.current);
      closePanelTimeoutRef.current = null;
    }
    setIsPanelOpen(false);
    setActiveKey(null);
  };
  const handleBlurCapture = (event: FocusEvent<HTMLElement>): void => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    closePanelNow();
  };

  return (
    <AgentMessageLocatorSurface
      activeKey={railActiveKey}
      closePanelSoon={closePanelSoon}
      handleBlurCapture={handleBlurCapture}
      handleLocateItem={handleLocateItem}
      handlePointerDown={handlePointerDown}
      handlePointerMove={handlePointerMove}
      isPanelOpen={isPanelOpen}
      items={items}
      label={label}
      locatorRef={setLocatorElement}
      locatorViewportRef={createMessageLocatorWheelElementRef(
        locatorViewportRef,
        "rail",
        reportLocatorDiagnostic
      )}
      openPanel={openPanel}
      panelActiveKey={panelActiveKey}
      panelRef={createMessageLocatorWheelElementRef(
        panelRef,
        "panel",
        reportLocatorDiagnostic
      )}
      panelSelectedKey={visibleActiveKey}
      setActiveKey={setActiveKey}
      shouldRenderPanel={shouldRenderPanel}
      scrubTargetKey={scrubTargetKey}
      stopPointerScrub={stopPointerScrub}
      suppressNextClickRef={suppressNextClickRef}
      unreadAgentResponseKeys={unreadAgentResponseKeys}
      viewportHeight={viewportHeight}
      visibleFrame={visibleFrame}
      visibleKeys={visibleKeys}
    />
  );
}

function createMessageLocatorWheelElementRef(
  targetRef: { current: HTMLDivElement | null },
  surface: "panel" | "rail",
  reportDiagnostic: (event: string, details: Record<string, unknown>) => void
): (element: HTMLDivElement | null) => (() => void) | undefined {
  return (element) => {
    targetRef.current = element;
    if (!element) return;
    const handleWheel = (event: globalThis.WheelEvent): void => {
      containMessageLocatorWheel(event, element, surface, reportDiagnostic);
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      if (targetRef.current === element) {
        targetRef.current = null;
      }
    };
  };
}

function containMessageLocatorWheel(
  event: globalThis.WheelEvent,
  target: HTMLDivElement,
  surface: "panel" | "rail",
  reportDiagnostic: (event: string, details: Record<string, unknown>) => void
): void {
  event.stopPropagation();
  if (event.deltaY === 0) {
    return;
  }
  event.preventDefault();
  const scrollTopBefore = target.scrollTop;
  const maximumScrollTop = Math.max(
    0,
    target.scrollHeight - target.clientHeight
  );
  target.scrollTop = Math.min(
    maximumScrollTop,
    Math.max(0, target.scrollTop + event.deltaY)
  );
  reportDiagnostic("wheel", {
    clientHeight: target.clientHeight,
    deltaMode: event.deltaMode,
    deltaY: event.deltaY,
    maximumScrollTop,
    scrollHeight: target.scrollHeight,
    scrollTopAfter: target.scrollTop,
    scrollTopBefore,
    surface
  });
}

function duplicateLocatorFieldCount(values: readonly string[]): number {
  return values.length - new Set(values).size;
}

function locatorDiagnosticHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
