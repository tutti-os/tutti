import { workbenchSnapshotLimits } from "./limits.ts";
import {
  workbenchSnapshotSchemaVersion,
  type WorkbenchFrameV1,
  type WorkbenchSnapshotLayoutBasisV1,
  type WorkbenchSnapshotNodeV1,
  type WorkbenchSnapshotSpaceV1,
  type WorkbenchSnapshotV1
} from "./types.ts";
import { assertValidWorkbenchSnapshot } from "./validate.ts";

export function normalizeWorkbenchSnapshot(
  value: WorkbenchSnapshotV1
): WorkbenchSnapshotV1 {
  assertValidWorkbenchSnapshot(value);

  const nodes = value.nodes.map(normalizeNode).sort(compareByID);
  const nodeIDs = new Set(nodes.map((node) => node.id));
  const nodeStack = uniqueStrings(value.nodeStack ?? []).filter((id) =>
    nodeIDs.has(id)
  );

  for (const node of nodes) {
    if (!nodeStack.includes(node.id)) {
      nodeStack.push(node.id);
    }
  }

  const activeNodeId =
    value.activeNodeId && nodeIDs.has(value.activeNodeId)
      ? value.activeNodeId
      : (nodeStack.at(-1) ?? null);

  const spaces = value.spaces?.map(normalizeSpace).sort(compareByID);
  const spaceIDs = new Set(spaces?.map((space) => space.id) ?? []);
  const activeSpaceId =
    value.activeSpaceId && spaceIDs.has(value.activeSpaceId)
      ? value.activeSpaceId
      : (spaces?.[0]?.id ?? null);

  return stripUndefined({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes,
    nodeStack,
    activeNodeId,
    spaces,
    activeSpaceId,
    layoutBasis: value.layoutBasis
      ? normalizeLayoutBasis(value.layoutBasis)
      : undefined,
    metadata: value.metadata
  });
}

function normalizeNode(node: WorkbenchSnapshotNodeV1): WorkbenchSnapshotNodeV1 {
  return stripUndefined({
    id: node.id.trim(),
    kind: node.kind.trim(),
    title: node.title,
    frame: normalizeFrame(node.frame),
    displayMode: node.displayMode ?? "floating",
    restoreFrame: node.restoreFrame ? normalizeFrame(node.restoreFrame) : null,
    isMinimized: node.isMinimized ?? false,
    minimizedAtUnixMs: normalizeMinimizedAtUnixMs(node),
    data: node.data,
    adapterState: node.adapterState
  });
}

function normalizeMinimizedAtUnixMs(
  node: WorkbenchSnapshotNodeV1
): number | null | undefined {
  if (node.isMinimized !== true) {
    return undefined;
  }
  return node.minimizedAtUnixMs ?? undefined;
}

function normalizeSpace(
  space: WorkbenchSnapshotSpaceV1
): WorkbenchSnapshotSpaceV1 {
  return stripUndefined({
    id: space.id.trim(),
    name: space.name,
    nodeIds: uniqueStrings(space.nodeIds),
    frame: space.frame ? normalizeFrame(space.frame) : null,
    data: space.data
  });
}

function normalizeFrame(frame: WorkbenchFrameV1): WorkbenchFrameV1 {
  return {
    x: normalizeNumber(frame.x),
    y: normalizeNumber(frame.y),
    width: Math.max(
      workbenchSnapshotLimits.minFrameWidth,
      normalizeNumber(frame.width)
    ),
    height: Math.max(
      workbenchSnapshotLimits.minFrameHeight,
      normalizeNumber(frame.height)
    )
  };
}

function normalizeLayoutBasis(
  layoutBasis: WorkbenchSnapshotLayoutBasisV1
): WorkbenchSnapshotLayoutBasisV1 {
  return {
    surfaceSize: {
      width: normalizeNumber(layoutBasis.surfaceSize.width),
      height: normalizeNumber(layoutBasis.surfaceSize.height)
    },
    layoutConstraints: {
      minWidth: normalizeNumber(layoutBasis.layoutConstraints.minWidth),
      minHeight: normalizeNumber(layoutBasis.layoutConstraints.minHeight),
      surfacePadding: normalizeNumber(
        layoutBasis.layoutConstraints.surfacePadding
      ),
      safeArea: {
        top: normalizeNumber(layoutBasis.layoutConstraints.safeArea.top),
        right: normalizeNumber(layoutBasis.layoutConstraints.safeArea.right),
        bottom: normalizeNumber(layoutBasis.layoutConstraints.safeArea.bottom),
        left: normalizeNumber(layoutBasis.layoutConstraints.safeArea.left)
      }
    }
  };
}

function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : Number(value.toFixed(3));
}

function compareByID<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}
