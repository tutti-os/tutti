import { useEffect, useRef, useState } from "react";
import type { WorkbenchMinimizedDockSlot } from "./minimizedDockSlots.ts";

export const minimizedDockStackPromotionDurationMs = 520;

export function detectMinimizedDockStackPromotion(
  previous: readonly WorkbenchMinimizedDockSlot[],
  next: readonly WorkbenchMinimizedDockSlot[]
): string | null {
  const previousVisibleNodeIds = new Set(
    previous
      .filter(
        (slot): slot is Extract<WorkbenchMinimizedDockSlot, { kind: "node" }> =>
          slot.kind === "node"
      )
      .map((slot) => slot.node.id)
  );
  const previousStackNodeIds =
    previous
      .find((slot) => slot.kind === "stack")
      ?.nodes.map((node) => node.id) ?? [];

  for (const slot of next) {
    if (slot.kind !== "node") {
      continue;
    }
    if (
      !previousVisibleNodeIds.has(slot.node.id) &&
      previousStackNodeIds.includes(slot.node.id)
    ) {
      return slot.node.id;
    }
  }

  return null;
}

export function useMinimizedDockStackPromotion(
  slots: readonly WorkbenchMinimizedDockSlot[]
) {
  const previousSlotsRef = useRef(slots);
  const promotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promotedNodeId, setPromotedNodeId] = useState<string | null>(null);
  const [stackDispatching, setStackDispatching] = useState(false);

  useEffect(() => {
    const promotedNodeId = detectMinimizedDockStackPromotion(
      previousSlotsRef.current,
      slots
    );
    previousSlotsRef.current = slots;

    if (!promotedNodeId) {
      return undefined;
    }

    setPromotedNodeId(promotedNodeId);
    setStackDispatching(true);
    if (promotionTimerRef.current !== null) {
      clearTimeout(promotionTimerRef.current);
    }
    promotionTimerRef.current = setTimeout(() => {
      promotionTimerRef.current = null;
      setPromotedNodeId(null);
      setStackDispatching(false);
    }, minimizedDockStackPromotionDurationMs);

    return () => {
      if (promotionTimerRef.current !== null) {
        clearTimeout(promotionTimerRef.current);
        promotionTimerRef.current = null;
      }
    };
  }, [slots]);

  return { promotedNodeId, stackDispatching };
}
