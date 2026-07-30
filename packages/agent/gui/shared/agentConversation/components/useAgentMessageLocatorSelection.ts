import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";

const LOCATOR_TARGET_SELECTOR = "[data-agent-message-locator-key]";
const LOCATOR_TURN_SELECTOR = "[data-agent-transcript-virtual-turn]";

interface AgentMessageLocatorSelection {
  activeKey: string | null;
  visibleKeys: ReadonlySet<string>;
}

export function useAgentMessageLocatorSelection({
  items,
  isVisible,
  locatorRef
}: {
  items: readonly AgentMessageLocatorItem[];
  isVisible: boolean;
  locatorRef: RefObject<HTMLElement | null>;
}): AgentMessageLocatorSelection {
  const [intersectingKeys, setIntersectingKeys] = useState<ReadonlySet<string>>(
    () => new Set(items.at(-1)?.key ? [items.at(-1)!.key] : [])
  );
  const itemKeySignature = items.map((item) => item.key).join("\u0000");
  const itemKeys = useMemo(
    () =>
      new Set(
        itemKeySignature.length === 0 ? [] : itemKeySignature.split("\u0000")
      ),
    [itemKeySignature]
  );

  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }
    const locator = locatorRef.current;
    const scrollParent = locator
      ? findMessageLocatorScrollParent(locator)
      : null;
    if (
      !scrollParent ||
      typeof IntersectionObserver !== "function" ||
      typeof MutationObserver !== "function"
    ) {
      return;
    }

    const observedTargets = new Set<HTMLElement>();
    const keyByTarget = new Map<Element, string>();
    const currentlyIntersectingKeys = new Set<string>();
    const publishIntersectingKeys = (): void => {
      if (currentlyIntersectingKeys.size === 0) return;
      setIntersectingKeys((currentKeys) => {
        if (setsEqual(currentKeys, currentlyIntersectingKeys)) {
          return currentKeys;
        }
        return new Set(currentlyIntersectingKeys);
      });
    };
    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = keyByTarget.get(entry.target);
          if (!key) {
            continue;
          }
          if (entry.isIntersecting) {
            currentlyIntersectingKeys.add(key);
          } else {
            currentlyIntersectingKeys.delete(key);
          }
        }
        publishIntersectingKeys();
      },
      {
        root: scrollParent,
        rootMargin: "-16px 0px 0px 0px"
      }
    );
    const reconcileTargets = (): void => {
      const currentTargets = new Map<HTMLElement, string>();
      const groupedTurns = new Set<HTMLElement>();
      for (const unit of scrollParent.querySelectorAll<HTMLElement>(
        LOCATOR_TARGET_SELECTOR
      )) {
        const key = unit.dataset.agentMessageLocatorKey;
        if (!key || !itemKeys.has(key)) continue;
        const turn = unit.closest<HTMLElement>(LOCATOR_TURN_SELECTOR);
        const target =
          !turn || groupedTurns.has(turn)
            ? unit
            : (groupedTurns.add(turn), turn);
        currentTargets.set(target, key);
      }
      const removedKeys = new Set<string>();
      for (const target of observedTargets) {
        if (!currentTargets.has(target)) {
          visibilityObserver.unobserve(target);
          observedTargets.delete(target);
          const key = keyByTarget.get(target);
          keyByTarget.delete(target);
          if (key) currentlyIntersectingKeys.delete(key);
          if (key) removedKeys.add(key);
        }
      }
      if (removedKeys.size > 0) publishIntersectingKeys();
      for (const [target, key] of currentTargets) {
        const previousKey = keyByTarget.get(target);
        if (previousKey && previousKey !== key) {
          currentlyIntersectingKeys.delete(previousKey);
        }
        keyByTarget.set(target, key);
        if (observedTargets.has(target)) {
          continue;
        }
        observedTargets.add(target);
        visibilityObserver.observe(target);
      }
    };

    reconcileTargets();
    const mutationObserver = new MutationObserver((records) => {
      if (records.some(mutationChangesVirtualTurns)) {
        reconcileTargets();
      }
    });
    mutationObserver.observe(scrollParent, { childList: true, subtree: true });
    return () => {
      mutationObserver.disconnect();
      visibilityObserver.disconnect();
    };
  }, [isVisible, itemKeys, locatorRef]);

  const visibleKeys = contiguousLocatorRange(items, intersectingKeys);
  const activeKey =
    items.find((item) => visibleKeys.has(item.key))?.key ??
    items.at(-1)?.key ??
    null;
  return {
    activeKey,
    visibleKeys
  };
}

function mutationChangesVirtualTurns(record: MutationRecord): boolean {
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) =>
      node instanceof Element &&
      (node.matches(LOCATOR_TURN_SELECTOR) ||
        node.querySelector(LOCATOR_TURN_SELECTOR) !== null)
  );
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

function contiguousLocatorRange(
  items: readonly AgentMessageLocatorItem[],
  intersectingKeys: ReadonlySet<string>
): ReadonlySet<string> {
  const firstIndex = items.findIndex((item) => intersectingKeys.has(item.key));
  if (firstIndex < 0) {
    return new Set();
  }
  let lastIndex = firstIndex;
  for (let index = items.length - 1; index > firstIndex; index -= 1) {
    const item = items[index];
    if (item && intersectingKeys.has(item.key)) {
      lastIndex = index;
      break;
    }
  }
  return new Set(
    items.slice(firstIndex, lastIndex + 1).map((item) => item.key)
  );
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}
