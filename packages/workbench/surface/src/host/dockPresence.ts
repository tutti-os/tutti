import {
  minimizedDockSlotLayoutAnimationMs,
  type WorkbenchHostDockItem
} from "./dockItems.ts";

export type WorkbenchHostDockPresence = "entering" | "exiting" | "present";

export interface WorkbenchHostPresentDockItem {
  item: WorkbenchHostDockItem;
  key: string;
  presence: WorkbenchHostDockPresence;
}

const dockPresenceAnimationMs = 300;

export function resolveMinimizedDockItemNodeId(
  item: WorkbenchHostDockItem
): string | null {
  if (item.kind !== "minimized" || item.slot.kind !== "node") {
    return null;
  }
  return item.slot.node.id;
}

export function resolveNextDockItemPresence(
  item: WorkbenchHostDockItem,
  initialized: boolean,
  previousPresence: WorkbenchHostDockPresence | undefined,
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean
): WorkbenchHostDockPresence {
  if (!initialized) {
    return "present";
  }

  if (item.key === "separator:minimized") {
    return "present";
  }

  if (item.kind === "minimized") {
    const nodeId = resolveMinimizedDockItemNodeId(item);
    if (nodeId && shouldAnimateMinimizedDockEnter(nodeId)) {
      if (previousPresence === "exiting") {
        return "entering";
      }
      return previousPresence ?? "entering";
    }
    return "present";
  }

  if (previousPresence === "exiting") {
    return "entering";
  }

  return previousPresence ?? "entering";
}

export function resolveDockPresenceItems(input: {
  current: readonly WorkbenchHostPresentDockItem[];
  initialized: boolean;
  nextSourceItems: readonly WorkbenchHostDockItem[];
  shouldAnimateMinimizedDockEnter: (nodeId: string) => boolean;
}): WorkbenchHostPresentDockItem[] {
  const currentByKey = new Map(input.current.map((item) => [item.key, item]));
  const currentIndexByKey = new Map(
    input.current.map((item, index) => [item.key, index])
  );
  const nextByKey = new Map(
    input.nextSourceItems.map((item) => [item.key, item])
  );
  const nextKeys = new Set(input.nextSourceItems.map((item) => item.key));
  const currentVisibleItemCount = input.current.filter(
    (item) => item.presence !== "exiting"
  ).length;
  const shouldRetainExitingItems =
    input.nextSourceItems.length < currentVisibleItemCount;
  const emittedKeys = new Set<string>();
  const nextItems: WorkbenchHostPresentDockItem[] = [];
  let currentIndex = 0;

  const emitExitingUntil = (nextCurrentIndex: number) => {
    while (currentIndex < nextCurrentIndex) {
      const currentItem = input.current[currentIndex];
      currentIndex += 1;
      if (
        shouldRetainExitingItems &&
        currentItem &&
        !nextKeys.has(currentItem.key) &&
        !emittedKeys.has(currentItem.key)
      ) {
        emittedKeys.add(currentItem.key);
        nextItems.push({
          ...currentItem,
          presence: "exiting"
        });
      }
    }
  };

  for (const item of input.nextSourceItems) {
    const previousIndex = currentIndexByKey.get(item.key);
    if (previousIndex !== undefined) {
      emitExitingUntil(previousIndex);
      currentIndex = Math.max(currentIndex, previousIndex + 1);
    }
    emittedKeys.add(item.key);
    nextItems.push({
      item,
      key: item.key,
      presence: resolveNextDockItemPresence(
        item,
        input.initialized,
        currentByKey.get(item.key)?.presence,
        input.shouldAnimateMinimizedDockEnter
      )
    });
  }

  for (const currentItem of input.current) {
    if (shouldRetainExitingItems && !nextKeys.has(currentItem.key)) {
      if (emittedKeys.has(currentItem.key)) {
        continue;
      }
      emittedKeys.add(currentItem.key);
      nextItems.push({
        ...currentItem,
        presence: "exiting"
      });
    }
  }

  return nextItems.filter(
    (item) => nextByKey.has(item.key) || item.presence === "exiting"
  );
}

export function resolveDockPresenceSettleMs(
  items: readonly WorkbenchHostPresentDockItem[]
): number {
  if (
    items.some(
      (item) =>
        item.item.kind === "minimized" &&
        (item.presence === "entering" || item.presence === "exiting")
    )
  ) {
    return minimizedDockSlotLayoutAnimationMs;
  }
  return dockPresenceAnimationMs;
}
