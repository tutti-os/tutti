import { useEffect, useRef, useState } from "react";
import type { WorkbenchHostDockItem } from "./dockItems.ts";
import {
  resolveDockPresenceItems,
  resolveDockPresenceSettleMs,
  type WorkbenchHostPresentDockItem
} from "./dockPresence.ts";

export function useWorkbenchHostDockPresence(
  items: readonly WorkbenchHostDockItem[],
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean
): WorkbenchHostPresentDockItem[] {
  const latestItemsByKey = useRef(new Map<string, WorkbenchHostDockItem>());
  const shouldAnimateMinimizedDockEnterRef = useRef(
    shouldAnimateMinimizedDockEnter
  );
  latestItemsByKey.current = new Map(items.map((item) => [item.key, item]));
  shouldAnimateMinimizedDockEnterRef.current = shouldAnimateMinimizedDockEnter;
  const itemKeys = items.map((item) => item.key).join("\u0000");
  const [presentItems, setPresentItems] = useState<
    WorkbenchHostPresentDockItem[]
  >(() =>
    items.map((item) => ({
      item,
      key: item.key,
      presence: "present" as const
    }))
  );
  const initialized = useRef(false);

  useEffect(() => {
    let nextSettleMs = 300;

    setPresentItems((current) => {
      const filteredItems = resolveDockPresenceItems({
        current,
        initialized: initialized.current,
        nextSourceItems: [...latestItemsByKey.current.values()],
        shouldAnimateMinimizedDockEnter:
          shouldAnimateMinimizedDockEnterRef.current
      });
      nextSettleMs = resolveDockPresenceSettleMs(filteredItems);
      return filteredItems;
    });
    initialized.current = true;

    const timeout = globalThis.setTimeout(() => {
      setPresentItems((current) =>
        current
          .filter((item) => item.presence !== "exiting")
          .map((item) =>
            item.presence === "entering"
              ? { ...item, presence: "present" as const }
              : item
          )
      );
    }, nextSettleMs);

    return () => globalThis.clearTimeout(timeout);
  }, [itemKeys]);

  const renderedPresentItems = resolveDockPresenceItems({
    current: presentItems,
    initialized: initialized.current,
    nextSourceItems: [...latestItemsByKey.current.values()],
    shouldAnimateMinimizedDockEnter
  });

  return renderedPresentItems.map((presentItem) => {
    const latestItem = latestItemsByKey.current.get(presentItem.key);
    return latestItem ? { ...presentItem, item: latestItem } : presentItem;
  });
}
