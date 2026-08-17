import type { ResolvedWorkbenchHostDockEntry } from "./dockEntries.ts";
import type {
  WorkbenchMinimizedDockNode,
  WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostNodeDefinition,
  WorkbenchHostNodeInstanceStrategy
} from "./types.ts";

export const minimizedDockSlotLayoutAnimationMs = 720;

const dockItemsGapPx = 10.8;
const dockItemsHorizontalPaddingPx = 12.6;
const dockSeparatorOuterWidthPx = 8.1;
const dockSlotWidthPx = 43.2;

export type WorkbenchHostDockItem =
  | {
      key: string;
      kind: "entry";
      resolvedEntry: ResolvedWorkbenchHostDockEntry;
    }
  | {
      key: string;
      kind: "minimized";
      slot: WorkbenchMinimizedDockSlot;
    }
  | {
      key: string;
      kind: "separator";
    };

export function createWorkbenchHostDockItems({
  minimizedDockSlots,
  resolvedEntries
}: {
  minimizedDockSlots: readonly WorkbenchMinimizedDockSlot[];
  resolvedEntries: readonly ResolvedWorkbenchHostDockEntry[];
}): WorkbenchHostDockItem[] {
  const items: WorkbenchHostDockItem[] = [];

  for (const resolvedEntry of resolvedEntries) {
    if (resolvedEntry.sectionBreakBefore) {
      items.push({
        key: `separator:before:${resolvedEntry.entry.id}`,
        kind: "separator"
      });
    }
    items.push({
      key: `entry:${resolvedEntry.entry.id}`,
      kind: "entry",
      resolvedEntry
    });
    if (resolvedEntry.entry.separatorAfter) {
      items.push({
        key: `separator:after:${resolvedEntry.entry.id}`,
        kind: "separator"
      });
    }
  }

  if (minimizedDockSlots.length > 0 && resolvedEntries.length > 0) {
    items.push({
      key: "separator:minimized",
      kind: "separator"
    });
  }

  for (const slot of minimizedDockSlots) {
    items.push({
      key: `minimized:${slot.anchorKey}`,
      kind: "minimized",
      slot
    });
  }

  return items;
}

export function minimizedDockSlotNodes(
  slot: WorkbenchMinimizedDockSlot
): readonly WorkbenchMinimizedDockNode[] {
  return slot.kind === "stack" ? slot.nodes : [slot.node];
}

export function resolveDockEntryInstanceMode(
  entry: WorkbenchHostDockEntry,
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>
): WorkbenchHostNodeInstanceStrategy["mode"] | undefined {
  return (
    entry.instanceMode ?? nodeDefinitions.get(entry.typeId)?.instance?.mode
  );
}

export function resolveWorkbenchHostDockItemsWidth(
  items: readonly WorkbenchHostDockItem[]
): number {
  if (items.length === 0) {
    return dockItemsHorizontalPaddingPx;
  }

  const itemWidth = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === "separator" ? dockSeparatorOuterWidthPx : dockSlotWidthPx),
    0
  );
  const gapWidth = Math.max(0, items.length - 1) * dockItemsGapPx;
  return itemWidth + gapWidth + dockItemsHorizontalPaddingPx;
}
