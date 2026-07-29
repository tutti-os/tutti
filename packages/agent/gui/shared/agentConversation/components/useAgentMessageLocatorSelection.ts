import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import { escapeCssString } from "./agentTranscriptModel";
import type { AgentConversationFollowEndMode } from "../agentConversationFollowEndController";

const REVERSE_CONFIRMATION_FRAMES = 3;
const SCROLL_INTENT_WINDOW_MS = 1_000;

export interface AgentMessageLocatorVirtualSelectionSource {
  readonly scrollOffset: number | null;
  readonly scrollRect: { readonly height: number } | null;
  getVirtualItemForOffset(
    offset: number
  ): { readonly index: number } | undefined;
}

interface AgentMessageLocatorSelection {
  selectItem(itemKey: string): void;
  selectedKey: string | null;
}

export function useAgentMessageLocatorSelection({
  followEndMode,
  items,
  isVisible,
  locatorRef,
  virtualSelectionSource
}: {
  followEndMode?: AgentConversationFollowEndMode;
  items: readonly AgentMessageLocatorItem[];
  isVisible: boolean;
  locatorRef: RefObject<HTMLElement | null>;
  virtualSelectionSource?: AgentMessageLocatorVirtualSelectionSource;
}): AgentMessageLocatorSelection {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndexRef = useRef(-1);
  const selectionDirectionRef = useRef<-1 | 0 | 1>(0);
  const scrollIntentRef = useRef<{
    direction: -1 | 1;
    expiresAt: number;
  } | null>(null);
  const pendingReverseSelectionRef = useRef<{
    count: number;
    key: string;
  } | null>(null);
  const virtualSelectionReady =
    !virtualSelectionSource ||
    (virtualSelectionSource.scrollOffset !== null &&
      virtualSelectionSource.scrollRect !== null);

  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }
    if (!selectedKey) {
      return;
    }
    const nextIndex = items.findIndex((item) => item.key === selectedKey);
    if (nextIndex >= 0) {
      const previousIndex = selectedIndexRef.current;
      const intent = scrollIntentRef.current;
      const intendedDirection =
        intent && intent.expiresAt >= performance.now() ? intent.direction : 0;
      const indexShiftDirection = Math.sign(nextIndex - previousIndex);
      if (
        previousIndex >= 0 &&
        intendedDirection !== 0 &&
        indexShiftDirection !== 0 &&
        indexShiftDirection !== intendedDirection
      ) {
        const replacement = items[Math.min(previousIndex, items.length - 1)];
        selectedIndexRef.current = Math.min(previousIndex, items.length - 1);
        if (replacement && replacement.key !== selectedKey) {
          setSelectedKey(replacement.key);
        }
        return;
      }
      selectedIndexRef.current = nextIndex;
      return;
    }

    selectionDirectionRef.current = 0;
    pendingReverseSelectionRef.current = null;
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    const nextSelectedKey = virtualSelectionSource
      ? selectVirtualizedMessageLocatorItemAtViewportCenter(
          virtualSelectionSource,
          items,
          scrollParent?.scrollTop ?? virtualSelectionSource.scrollOffset
        )
      : null;
    const candidateIndex = items.findIndex(
      (item) => item.key === nextSelectedKey
    );
    const previousIndex = selectedIndexRef.current;
    const intent = scrollIntentRef.current;
    const intendedDirection =
      intent && intent.expiresAt >= performance.now() ? intent.direction : 0;
    const candidateDirection = Math.sign(candidateIndex - previousIndex);
    const replacementIndex =
      previousIndex >= 0 &&
      intendedDirection !== 0 &&
      candidateDirection !== 0 &&
      candidateDirection !== intendedDirection
        ? Math.min(previousIndex, items.length - 1)
        : candidateIndex;
    selectedIndexRef.current = replacementIndex;
    setSelectedKey(items[replacementIndex]?.key ?? null);
  }, [isVisible, items, locatorRef, selectedKey, virtualSelectionSource]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    if (!scrollParent) {
      return;
    }

    let animationFrame: number | null = null;
    const updateSelectedFromScroll = (): void => {
      animationFrame = null;
      const currentScrollTop = scrollParent.scrollTop;
      const nextSelectedKey = virtualSelectionSource
        ? selectVirtualizedMessageLocatorItemAtViewportCenter(
            virtualSelectionSource,
            items,
            currentScrollTop
          )
        : selectMessageLocatorItemAtViewportCenter(scrollParent, items);
      if (!nextSelectedKey) {
        return;
      }
      setSelectedKey((currentKey) => {
        if (!currentKey || currentKey === nextSelectedKey) {
          selectedIndexRef.current = items.findIndex(
            (item) => item.key === nextSelectedKey
          );
          pendingReverseSelectionRef.current = null;
          return nextSelectedKey;
        }
        const currentIndex = items.findIndex((item) => item.key === currentKey);
        const nextIndex = items.findIndex(
          (item) => item.key === nextSelectedKey
        );
        if (currentIndex < 0 || nextIndex < 0) {
          selectedIndexRef.current = nextIndex;
          selectionDirectionRef.current = 0;
          pendingReverseSelectionRef.current = null;
          return nextSelectedKey;
        }
        const nextDirection = Math.sign(nextIndex - currentIndex) as -1 | 0 | 1;
        const scrollIntent = scrollIntentRef.current;
        const intendedDirection =
          scrollIntent && scrollIntent.expiresAt >= performance.now()
            ? scrollIntent.direction
            : 0;
        const followsSemanticEnd =
          followEndMode === "following" && nextDirection === 1;
        if (
          !followsSemanticEnd &&
          intendedDirection !== 0 &&
          nextDirection !== 0 &&
          nextDirection !== intendedDirection
        ) {
          pendingReverseSelectionRef.current = null;
          return currentKey;
        }
        const selectionDirection = selectionDirectionRef.current;
        if (
          !followsSemanticEnd &&
          intendedDirection === 0 &&
          currentIndex >= 0 &&
          nextIndex >= 0 &&
          selectionDirection !== 0 &&
          nextDirection !== 0 &&
          nextDirection !== selectionDirection
        ) {
          const pending = pendingReverseSelectionRef.current;
          const count =
            pending?.key === nextSelectedKey ? pending.count + 1 : 1;
          if (count < REVERSE_CONFIRMATION_FRAMES) {
            pendingReverseSelectionRef.current = {
              count,
              key: nextSelectedKey
            };
            return currentKey;
          }
        }
        if (nextDirection === 0) {
          return currentKey;
        }
        selectionDirectionRef.current = nextDirection;
        selectedIndexRef.current = nextIndex;
        pendingReverseSelectionRef.current = null;
        return nextSelectedKey;
      });
    };
    const scheduleUpdate = (): void => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateSelectedFromScroll);
    };
    const captureWheelIntent = (event: globalThis.WheelEvent): void => {
      if (event.deltaY === 0) {
        return;
      }
      scrollIntentRef.current = {
        direction: event.deltaY < 0 ? -1 : 1,
        expiresAt: performance.now() + SCROLL_INTENT_WINDOW_MS
      };
      pendingReverseSelectionRef.current = null;
    };
    const captureKeyboardIntent = (event: KeyboardEvent): void => {
      const direction =
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "PageUp"
          ? -1
          : event.key === "ArrowDown" ||
              event.key === "End" ||
              event.key === "PageDown" ||
              event.key === " "
            ? 1
            : 0;
      if (direction === 0) {
        return;
      }
      scrollIntentRef.current = {
        direction,
        expiresAt: performance.now() + SCROLL_INTENT_WINDOW_MS
      };
      pendingReverseSelectionRef.current = null;
    };

    scheduleUpdate();
    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    scrollParent.addEventListener("wheel", captureWheelIntent, {
      passive: true
    });
    scrollParent.addEventListener("keydown", captureKeyboardIntent);
    return () => {
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      scrollParent.removeEventListener("wheel", captureWheelIntent);
      scrollParent.removeEventListener("keydown", captureKeyboardIntent);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    followEndMode,
    isVisible,
    items,
    locatorRef,
    virtualSelectionReady,
    virtualSelectionSource
  ]);

  const selectItem = (itemKey: string): void => {
    selectionDirectionRef.current = 0;
    scrollIntentRef.current = null;
    pendingReverseSelectionRef.current = null;
    setSelectedKey(itemKey);
  };

  return {
    selectItem,
    selectedKey
  };
}

export function findMessageLocatorScrollParent(
  locator: HTMLElement
): HTMLElement | null {
  const timeline = locator.closest<HTMLElement>(
    '[data-testid="agent-gui-timeline"]'
  );
  if (timeline) {
    return timeline;
  }

  let current = locator.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function selectMessageLocatorItemAtViewportCenter(
  scrollParent: HTMLElement,
  items: readonly AgentMessageLocatorItem[]
): string | null {
  const viewportRect = scrollParent.getBoundingClientRect();
  const viewportCenterY = viewportRect.top + viewportRect.height / 2;
  let nearest: { key: string; distance: number } | null = null;

  for (const item of items) {
    const row = scrollParent.querySelector<HTMLElement>(
      `[data-agent-transcript-row="${escapeCssString(item.rowKey)}"]`
    );
    if (!row) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    const rowCenterY = rowRect.top + rowRect.height / 2;
    const distance = Math.abs(rowCenterY - viewportCenterY);
    if (!nearest || distance < nearest.distance) {
      nearest = { key: item.key, distance };
    }
  }

  return nearest?.key ?? null;
}

function selectVirtualizedMessageLocatorItemAtViewportCenter(
  source: AgentMessageLocatorVirtualSelectionSource,
  items: readonly AgentMessageLocatorItem[],
  observedScrollOffset = source.scrollOffset
): string | null {
  const viewportHeight = source.scrollRect?.height;
  if (observedScrollOffset === null || viewportHeight === undefined) {
    return null;
  }
  const virtualTurn = source.getVirtualItemForOffset(
    observedScrollOffset + viewportHeight / 2
  );
  if (!virtualTurn) {
    return null;
  }

  let start = 0;
  let end = items.length - 1;
  let matchedIndex = -1;
  while (start <= end) {
    const middle = Math.floor((start + end) / 2);
    const item = items[middle];
    if (!item) {
      break;
    }
    if (item.turnGroupIndex <= virtualTurn.index) {
      matchedIndex = middle;
      start = middle + 1;
    } else {
      end = middle - 1;
    }
  }
  return items[matchedIndex < 0 ? 0 : matchedIndex]?.key ?? null;
}
