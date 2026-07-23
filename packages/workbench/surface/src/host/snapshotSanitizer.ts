import {
  normalizeWorkbenchSnapshot,
  type WorkbenchSnapshot,
  type WorkbenchSnapshotNode,
  type WorkbenchSnapshotSpaceV1
} from "@tutti-os/workbench-snapshot";
import {
  closedDockWindowFramesMetadataKey,
  readClosedDockWindowFrameEntries,
  writeClosedDockWindowFrameEntries
} from "./sessionState.ts";

export interface WorkbenchHostSnapshotNodeData {
  dockEntryId?: string | null;
  instanceId: string;
  instanceKey?: string | null;
  isProjected?: true;
  snapshotNodeState?: unknown;
  typeId: string;
}

const allowedMetadataKeys = [
  "tuttiWorkbenchInitialized",
  "workbenchHostInitialized"
] as const;

export function sanitizeWorkbenchHostSnapshot(
  snapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  const normalized = normalizeWorkbenchSnapshot(snapshot);
  return normalizeWorkbenchSnapshot({
    schemaVersion: normalized.schemaVersion,
    nodes: normalized.nodes.map(sanitizeNode),
    nodeStack: normalized.nodeStack,
    activeNodeId: normalized.activeNodeId,
    spaces: normalized.spaces?.map(sanitizeSpace),
    activeSpaceId: normalized.activeSpaceId,
    layoutBasis: normalized.layoutBasis,
    metadata: sanitizeMetadata(normalized.metadata)
  });
}

function sanitizeNode(node: WorkbenchSnapshotNode): WorkbenchSnapshotNode {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    frame: node.frame,
    displayMode: node.displayMode,
    restoreFrame: node.restoreFrame,
    isMinimized: node.isMinimized,
    data: sanitizeNodeData(node.data)
  };
}

function sanitizeNodeData(
  value: unknown
): WorkbenchHostSnapshotNodeData | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const typed = value as Partial<WorkbenchHostSnapshotNodeData>;
  if (
    typeof typed.typeId !== "string" ||
    typeof typed.instanceId !== "string"
  ) {
    return undefined;
  }

  return {
    dockEntryId:
      typeof typed.dockEntryId === "string" || typed.dockEntryId === null
        ? typed.dockEntryId
        : null,
    instanceId: typed.instanceId,
    instanceKey:
      typeof typed.instanceKey === "string" || typed.instanceKey === null
        ? typed.instanceKey
        : null,
    ...(typed.isProjected === true ? { isProjected: true } : {}),
    ...(typed.snapshotNodeState === undefined
      ? {}
      : { snapshotNodeState: typed.snapshotNodeState }),
    typeId: typed.typeId
  };
}

function sanitizeSpace(
  space: WorkbenchSnapshotSpaceV1
): WorkbenchSnapshotSpaceV1 {
  return {
    id: space.id,
    name: space.name,
    nodeIds: space.nodeIds,
    frame: space.frame
  };
}

function sanitizeMetadata(
  metadata: WorkbenchSnapshot["metadata"]
): WorkbenchSnapshot["metadata"] {
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedMetadataKeys) {
    if (metadata?.[key] === true) {
      sanitized[key] = true;
    }
  }
  if (metadata?.[closedDockWindowFramesMetadataKey] !== undefined) {
    return writeClosedDockWindowFrameEntries(
      sanitized,
      readClosedDockWindowFrameEntries(metadata).values()
    );
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
