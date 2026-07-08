import type { AgentGUIProviderTarget } from "../../../types";

const AGENT_GUI_PROVIDER_RAIL_ORDER_STORAGE_PREFIX =
  "agent-gui:provider-rail-order:";

export function agentGUIProviderRailOrderStorageKey(
  workspaceId: string | null | undefined
): string {
  const normalizedWorkspaceId = workspaceId?.trim() || "default";
  return `${AGENT_GUI_PROVIDER_RAIL_ORDER_STORAGE_PREFIX}${normalizedWorkspaceId}`;
}

export function parseAgentGUIProviderRailOrder(
  rawValue: string | null | undefined
): readonly string[] {
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sanitizeAgentGUIProviderRailOrder(parsed);
  } catch {
    return [];
  }
}

export function serializeAgentGUIProviderRailOrder(
  order: readonly string[]
): string {
  return JSON.stringify(sanitizeAgentGUIProviderRailOrder(order));
}

export function sanitizeAgentGUIProviderRailOrder(
  order: readonly unknown[]
): readonly string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of order) {
    if (typeof value !== "string") {
      continue;
    }
    const targetId = value.trim();
    if (!targetId || seen.has(targetId)) {
      continue;
    }
    seen.add(targetId);
    sanitized.push(targetId);
  }
  return sanitized;
}

export function applyAgentGUIProviderRailOrder<
  T extends Pick<AgentGUIProviderTarget, "targetId">
>(targets: readonly T[], order: readonly string[]): readonly T[] {
  const knownOrder = sanitizeAgentGUIProviderRailOrder(order);
  if (knownOrder.length === 0 || targets.length <= 1) {
    return targets;
  }
  const indexByTargetId = new Map<string, number>();
  knownOrder.forEach((targetId, index) => {
    indexByTargetId.set(targetId, index);
  });
  return [...targets].sort((left, right) => {
    const leftIndex = indexByTargetId.get(left.targetId);
    const rightIndex = indexByTargetId.get(right.targetId);
    if (leftIndex === undefined && rightIndex === undefined) {
      return 0;
    }
    if (leftIndex === undefined) {
      return 1;
    }
    if (rightIndex === undefined) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

export function reorderAgentGUIProviderRailOrder(input: {
  currentTargetIds: readonly string[];
  draggedTargetId: string;
  dropPosition: "before" | "after";
  overTargetId: string;
}): readonly string[] {
  const currentTargetIds = sanitizeAgentGUIProviderRailOrder(
    input.currentTargetIds
  );
  const draggedTargetId = input.draggedTargetId.trim();
  const overTargetId = input.overTargetId.trim();
  if (
    !draggedTargetId ||
    !overTargetId ||
    draggedTargetId === overTargetId ||
    !currentTargetIds.includes(draggedTargetId) ||
    !currentTargetIds.includes(overTargetId)
  ) {
    return currentTargetIds;
  }

  const withoutDragged = currentTargetIds.filter(
    (targetId) => targetId !== draggedTargetId
  );
  const overIndex = withoutDragged.indexOf(overTargetId);
  if (overIndex < 0) {
    return currentTargetIds;
  }
  const insertIndex =
    input.dropPosition === "after" ? overIndex + 1 : overIndex;
  return [
    ...withoutDragged.slice(0, insertIndex),
    draggedTargetId,
    ...withoutDragged.slice(insertIndex)
  ];
}
