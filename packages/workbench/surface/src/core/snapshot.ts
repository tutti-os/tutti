import {
  normalizeWorkbenchSnapshot,
  workbenchSnapshotSchemaVersion,
  type WorkbenchSnapshot,
  type WorkbenchSnapshotLayoutBasisV1,
  type WorkbenchSnapshotNode
} from "@tutti-os/workbench-snapshot";
import type { WorkbenchNode, WorkbenchState } from "./types.ts";

export interface CreateWorkbenchNodeInput<TData = unknown> {
  data: TData;
  displayMode?: WorkbenchNode<TData>["displayMode"];
  frame: WorkbenchNode<TData>["frame"];
  id: string;
  isMinimized?: boolean;
  kind: string;
  minimizedAtUnixMs?: WorkbenchNode<TData>["minimizedAtUnixMs"];
  restoreFrame?: WorkbenchNode<TData>["restoreFrame"];
  sizeConstraints?: WorkbenchNode<TData>["sizeConstraints"];
  title: string;
}

export interface CreateWorkbenchSnapshotFromStateOptions {
  activeSpaceId?: WorkbenchSnapshot["activeSpaceId"];
  metadata?: WorkbenchSnapshot["metadata"];
  spaces?: WorkbenchSnapshot["spaces"];
}

export function createWorkbenchNode<TData = unknown>(
  input: CreateWorkbenchNodeInput<TData>
): WorkbenchNode<TData> {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    frame: input.frame,
    displayMode: input.displayMode ?? "floating",
    restoreFrame: input.restoreFrame ?? null,
    isMinimized: input.isMinimized ?? false,
    minimizedAtUnixMs:
      input.isMinimized === true ? (input.minimizedAtUnixMs ?? null) : null,
    sizeConstraints: input.sizeConstraints ?? null,
    data: input.data
  };
}

export function createWorkbenchNodeFromSnapshot<TData = unknown>(
  snapshotNode: WorkbenchSnapshotNode
): WorkbenchNode<TData> {
  return createWorkbenchNode<TData>({
    id: snapshotNode.id,
    kind: snapshotNode.kind,
    title: snapshotNode.title,
    frame: snapshotNode.frame,
    displayMode: snapshotNode.displayMode,
    restoreFrame: snapshotNode.restoreFrame ?? null,
    isMinimized: snapshotNode.isMinimized,
    minimizedAtUnixMs: snapshotNode.minimizedAtUnixMs ?? null,
    data: snapshotNode.data as TData
  });
}

export function createWorkbenchStateFromSnapshot<TData = unknown>(
  snapshot: WorkbenchSnapshot
): Pick<WorkbenchState<TData>, "nodeStack" | "nodes"> {
  const normalized = normalizeWorkbenchSnapshot(snapshot);
  const nodes = normalized.nodes.map((node) =>
    createWorkbenchNodeFromSnapshot<TData>(node)
  );

  return {
    nodes,
    nodeStack: normalized.nodeStack ?? nodes.map((node) => node.id)
  };
}

export function createWorkbenchSnapshotFromState<TData = unknown>(
  state: Pick<WorkbenchState<TData>, "nodeStack" | "nodes"> &
    Partial<Pick<WorkbenchState<TData>, "layoutConstraints" | "surfaceSize">>,
  options: CreateWorkbenchSnapshotFromStateOptions = {}
): WorkbenchSnapshot {
  return normalizeWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: state.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      frame: node.frame,
      displayMode: node.displayMode,
      restoreFrame: node.restoreFrame,
      isMinimized: node.isMinimized,
      minimizedAtUnixMs: node.minimizedAtUnixMs,
      data: node.data
    })),
    nodeStack: state.nodeStack,
    activeNodeId: state.nodeStack.at(-1) ?? null,
    spaces: options.spaces,
    activeSpaceId: options.activeSpaceId,
    layoutBasis: createWorkbenchSnapshotLayoutBasis(state),
    metadata: options.metadata
  });
}

export function createWorkbenchSnapshotLayoutBasis(
  state: Partial<Pick<WorkbenchState, "layoutConstraints" | "surfaceSize">>
): WorkbenchSnapshotLayoutBasisV1 | undefined {
  if (
    !state.surfaceSize ||
    !state.layoutConstraints ||
    !isPositiveFinite(state.surfaceSize.width) ||
    !isPositiveFinite(state.surfaceSize.height)
  ) {
    return undefined;
  }

  return {
    surfaceSize: { ...state.surfaceSize },
    layoutConstraints: {
      ...state.layoutConstraints,
      safeArea: { ...state.layoutConstraints.safeArea }
    }
  };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
