import type {
  WorkbenchSnapshotLayoutBasisV1,
  WorkbenchSnapshotNode,
  WorkbenchSnapshotSpaceV1
} from "@tutti-os/workbench-snapshot";
import {
  clampWorkbenchRect,
  getWorkbenchFullscreenRect,
  getWorkbenchLayoutFrame,
  rectsEqual
} from "../core/geometry.ts";
import { restoreWorkbenchFrameToLayout } from "../core/snapshotLayout.ts";
import type {
  WorkbenchFrame,
  WorkbenchNode,
  WorkbenchState
} from "../core/types.ts";
import {
  closedDockWindowFrameEntryKey,
  COMPACT_LAUNCH_FRAME_SCALE,
  COMPACT_LAUNCH_WIDTH_THRESHOLD,
  type ClosedDockWindowFrameEntry
} from "./sessionState.ts";
import type {
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";

export function restoreWorkbenchHostNodesToSurface(input: {
  constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
  layoutBasis?: WorkbenchSnapshotLayoutBasisV1 | null;
  nodeDefinitionByType: Map<string, WorkbenchHostNodeDefinition>;
  nodes: readonly WorkbenchNode<WorkbenchHostNodeData>[];
  persistedNodes?: readonly WorkbenchSnapshotNode[];
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
}): WorkbenchNode<WorkbenchHostNodeData>[] {
  const persistedNodeById = new Map(
    input.persistedNodes?.map((node) => [node.id, node])
  );
  return input.nodes.map((node) => {
    const persistedNode = persistedNodeById.get(node.id);
    const sourceNode = persistedNode
      ? {
          ...node,
          frame: persistedNode.frame,
          restoreFrame: persistedNode.restoreFrame ?? null
        }
      : node;
    return restoreNodeToSurface(sourceNode, input);
  });
}

export function restoreWorkbenchHostSpacesToSurface(input: {
  constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
  layoutBasis?: WorkbenchSnapshotLayoutBasisV1 | null;
  spaces?: readonly WorkbenchSnapshotSpaceV1[];
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
}): WorkbenchSnapshotSpaceV1[] | undefined {
  return input.spaces?.map((space) => {
    if (!space.frame) {
      return space;
    }
    const frame = restoreWorkbenchFrameToLayout({
      frame: space.frame,
      sourceLayoutBasis: input.layoutBasis,
      targetLayoutConstraints: input.constraints,
      targetSurfaceSize: input.surfaceSize
    });
    return rectsEqual(space.frame, frame) ? space : { ...space, frame };
  });
}

export function restoreClosedDockWindowFrameEntriesToSurface(input: {
  constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
  entries: Iterable<ClosedDockWindowFrameEntry>;
  layoutBasis?: WorkbenchSnapshotLayoutBasisV1 | null;
  nodeDefinitionByType: Map<string, WorkbenchHostNodeDefinition>;
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
}): Map<string, ClosedDockWindowFrameEntry> {
  const restoredEntries = new Map<string, ClosedDockWindowFrameEntry>();
  for (const entry of input.entries) {
    const definition = input.nodeDefinitionByType.get(entry.typeId);
    const restoredEntry = {
      ...entry,
      frame: restoreWorkbenchFrameToLayout({
        frame: entry.frame,
        sourceLayoutBasis: input.layoutBasis,
        targetLayoutConstraints: input.constraints,
        targetSurfaceSize: input.surfaceSize,
        sizeConstraints: definition?.sizeConstraints
      })
    };
    restoredEntries.set(
      closedDockWindowFrameEntryKey(restoredEntry),
      restoredEntry
    );
  }
  return restoredEntries;
}

function restoreNodeToSurface(
  node: WorkbenchNode<WorkbenchHostNodeData>,
  input: {
    constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
    layoutBasis?: WorkbenchSnapshotLayoutBasisV1 | null;
    nodeDefinitionByType: Map<string, WorkbenchHostNodeDefinition>;
    surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
  }
): WorkbenchNode<WorkbenchHostNodeData> {
  const sizeConstraints =
    node.sizeConstraints ??
    input.nodeDefinitionByType.get(node.data.typeId)?.sizeConstraints ??
    null;
  const restoreFrame = node.restoreFrame
    ? restoreWorkbenchFrameToLayout({
        frame: node.restoreFrame,
        sourceLayoutBasis: input.layoutBasis,
        targetLayoutConstraints: input.constraints,
        targetSurfaceSize: input.surfaceSize,
        sizeConstraints
      })
    : null;

  if (node.displayMode === "fullscreen") {
    const frame = getWorkbenchFullscreenRect(
      input.surfaceSize,
      input.constraints,
      sizeConstraints
    );
    return rectsEqual(node.frame, frame) &&
      nullableRectsEqual(node.restoreFrame, restoreFrame)
      ? node
      : { ...node, frame, restoreFrame };
  }

  if (input.layoutBasis) {
    const frame = restoreWorkbenchFrameToLayout({
      frame: node.frame,
      sourceLayoutBasis: input.layoutBasis,
      targetLayoutConstraints: input.constraints,
      targetSurfaceSize: input.surfaceSize,
      sizeConstraints
    });
    return rectsEqual(node.frame, frame) &&
      nullableRectsEqual(node.restoreFrame, restoreFrame)
      ? node
      : { ...node, frame, restoreFrame };
  }

  if (input.surfaceSize.width >= COMPACT_LAUNCH_WIDTH_THRESHOLD) {
    const frame = clampWorkbenchRect(
      node.frame,
      input.surfaceSize,
      input.constraints,
      sizeConstraints
    );
    return rectsEqual(node.frame, frame) &&
      nullableRectsEqual(node.restoreFrame, restoreFrame)
      ? node
      : { ...node, frame, restoreFrame };
  }

  const defaultFrame =
    input.nodeDefinitionByType.get(node.data.typeId)?.frame ?? node.frame;
  const compactWidth = Math.round(
    defaultFrame.width * COMPACT_LAUNCH_FRAME_SCALE
  );
  const compactHeight = Math.round(
    defaultFrame.height * COMPACT_LAUNCH_FRAME_SCALE
  );
  const width = Math.min(node.frame.width, compactWidth);
  const height = Math.min(node.frame.height, compactHeight);
  const sizeChanged =
    width !== node.frame.width || height !== node.frame.height;
  const layoutFrame = getWorkbenchLayoutFrame(
    input.surfaceSize,
    input.constraints
  );
  const frame = clampWorkbenchRect(
    sizeChanged
      ? {
          height,
          width,
          x: Math.round(layoutFrame.x + (layoutFrame.width - width) / 2),
          y: Math.round(layoutFrame.y + (layoutFrame.height - height) / 2)
        }
      : node.frame,
    input.surfaceSize,
    input.constraints,
    sizeConstraints
  );
  return rectsEqual(node.frame, frame) &&
    nullableRectsEqual(node.restoreFrame, restoreFrame)
    ? node
    : { ...node, frame, restoreFrame };
}

function nullableRectsEqual(
  left: WorkbenchFrame | null,
  right: WorkbenchFrame | null
): boolean {
  return (
    left === right ||
    (left !== null && right !== null && rectsEqual(left, right))
  );
}
