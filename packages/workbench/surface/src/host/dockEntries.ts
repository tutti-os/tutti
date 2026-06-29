import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostNodeData,
  WorkbenchHostNodeInstanceStrategy
} from "./types.ts";

export type WorkbenchHostDockNodeState = "closed" | "minimized" | "open";

export interface ResolvedWorkbenchHostDockEntry {
  anchorKey: string;
  dockNodeState: WorkbenchHostDockNodeState;
  entry: WorkbenchHostDockEntry;
  hasMatchingNodes: boolean;
  matchedNodes: WorkbenchNode<WorkbenchHostNodeData>[];
  sectionBreakBefore: boolean;
}

export type WorkbenchHostDockClickResolution =
  | { actionId: string; kind: "action" }
  | { kind: "blocked" }
  | { kind: "focus-node"; nodeId: string }
  | { kind: "launch" }
  | { kind: "open-popup" };

export function matchWorkbenchDockEntryNode(
  entry: WorkbenchHostDockEntry,
  node: WorkbenchNode<WorkbenchHostNodeData>
): boolean {
  if (typeof node.data.dockEntryId === "string") {
    return node.data.dockEntryId === entry.id;
  }
  return entry.matchNode?.(node) ?? false;
}

export function resolveWorkbenchDockEntryAnchorKey(
  entry: WorkbenchHostDockEntry
): string {
  return entry.anchorKey ?? entry.id;
}

export function resolveWorkbenchDockEntries(input: {
  dockEntries: readonly WorkbenchHostDockEntry[];
  minimizedNodeIds: ReadonlySet<string>;
  nodes: readonly WorkbenchNode<WorkbenchHostNodeData>[];
}): ResolvedWorkbenchHostDockEntry[] {
  const sectionOrder = new Map<string, number>();
  let nextSectionIndex = 0;
  const sortedEntries = [...input.dockEntries]
    .map((entry, index) => {
      const sectionId = entry.sectionId ?? "";
      if (!sectionOrder.has(sectionId)) {
        sectionOrder.set(sectionId, nextSectionIndex++);
      }
      return {
        entry,
        index,
        sectionId
      };
    })
    .sort((left, right) => {
      const sectionOrderDelta =
        (sectionOrder.get(left.sectionId) ?? 0) -
        (sectionOrder.get(right.sectionId) ?? 0);
      if (sectionOrderDelta !== 0) {
        return sectionOrderDelta;
      }
      const orderDelta = (left.entry.order ?? 0) - (right.entry.order ?? 0);
      if (orderDelta !== 0) {
        return orderDelta;
      }
      return left.index - right.index;
    });

  let previousSectionId: string | null = null;
  const resolvedEntries: ResolvedWorkbenchHostDockEntry[] = [];

  for (const { entry, sectionId } of sortedEntries) {
    const matchedNodes = input.nodes.filter((node) =>
      matchWorkbenchDockEntryNode(entry, node)
    );
    const hasMatchingNodes = matchedNodes.length > 0;
    const visibility = entry.visibility ?? "always";
    if (
      visibility === "never" ||
      (visibility === "when-open" && !hasMatchingNodes)
    ) {
      continue;
    }

    const hasOpenNode = matchedNodes.some(
      (node) => !input.minimizedNodeIds.has(node.id)
    );
    const hasMinimizedNode = matchedNodes.some((node) =>
      input.minimizedNodeIds.has(node.id)
    );

    resolvedEntries.push({
      anchorKey: resolveWorkbenchDockEntryAnchorKey(entry),
      dockNodeState: hasMinimizedNode
        ? "minimized"
        : hasOpenNode
          ? "open"
          : "closed",
      entry,
      hasMatchingNodes,
      matchedNodes,
      sectionBreakBefore:
        previousSectionId !== null && previousSectionId !== sectionId
    });
    previousSectionId = sectionId;
  }

  return resolvedEntries;
}

export function resolveWorkbenchDockEntryClick(input: {
  entry: WorkbenchHostDockEntry;
  instanceMode?: WorkbenchHostNodeInstanceStrategy["mode"];
  matchedNodes: readonly WorkbenchNode<WorkbenchHostNodeData>[];
}): WorkbenchHostDockClickResolution {
  if (input.entry.clickActionId) {
    if (isWorkbenchDockEntryBlocked(input.entry)) {
      return { kind: "blocked" };
    }
    return { actionId: input.entry.clickActionId, kind: "action" };
  }
  if (isWorkbenchDockEntryBlocked(input.entry)) {
    return { kind: "blocked" };
  }
  if (input.entry.clickBehavior === "launch") {
    return { kind: "launch" };
  }
  if (input.instanceMode === "multi" && input.matchedNodes.length > 0) {
    return { kind: "open-popup" };
  }
  if (input.matchedNodes.length === 1) {
    return { kind: "focus-node", nodeId: input.matchedNodes[0]!.id };
  }
  if (input.matchedNodes.length > 1) {
    return { kind: "open-popup" };
  }
  return { kind: "launch" };
}

function isWorkbenchDockEntryBlocked(entry: WorkbenchHostDockEntry): boolean {
  const stateKind = entry.state?.kind ?? "enabled";
  return (
    stateKind === "disabled" ||
    stateKind === "loading" ||
    stateKind === "unavailable" ||
    (entry.launchBehavior ?? "enabled") !== "enabled"
  );
}
