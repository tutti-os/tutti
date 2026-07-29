import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import {
  clampWorkbenchRect,
  getWorkbenchFullscreenRect,
  getWorkbenchLayoutFrame
} from "../core/geometry.ts";
import { resolveWorkbenchCascadedRect } from "../core/placement.ts";
import {
  createWorkbenchNode,
  createWorkbenchStateFromSnapshot
} from "../core/snapshot.ts";
import type {
  WorkbenchFrame,
  WorkbenchNode,
  WorkbenchNodeSizeConstraints,
  WorkbenchState
} from "../core/types.ts";
import {
  createWorkbenchHostLaunchedNodeId,
  createWorkbenchHostProjectedNodeId
} from "./nodeIdentity.ts";
import type {
  WorkbenchHostActivation,
  WorkbenchHostLaunchFramePolicy,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchHostProjectedNode
} from "./types.ts";

const initializedMetadataKeys = [
  "tuttiWorkbenchInitialized",
  "workbenchHostInitialized"
] as const;
export const COMPACT_LAUNCH_WIDTH_THRESHOLD = 1440;
export const COMPACT_LAUNCH_FRAME_SCALE = 0.85;
export const closedDockWindowFramesMetadataKey =
  "workbenchHostClosedDockWindowFrames";
const maxClosedDockWindowFrameEntries = 128;

export interface ClosedDockWindowFrameEntry {
  dockEntryId: string;
  frame: WorkbenchFrame;
  typeId: string;
}

export function createDefaultLaunchResult(
  definition: WorkbenchHostNodeDefinition,
  input?: Pick<WorkbenchHostLaunchResult, "dockEntryId" | "launchSource">
): WorkbenchHostLaunchResult {
  return {
    defaultFrame: definition.frame,
    dockEntryId: input?.dockEntryId,
    instanceId: definition.typeId,
    framePolicy: "cascade",
    launchSource: input?.launchSource ?? null,
    sizeConstraints: definition.sizeConstraints ?? null,
    title: definition.title,
    typeId: definition.typeId
  };
}

export function createWorkbenchProjectedHostNode(input: {
  definition: WorkbenchHostNodeDefinition;
  projectedNode: WorkbenchHostProjectedNode;
  restoredNode: WorkbenchNode<WorkbenchHostNodeData> | null;
}): WorkbenchNode<WorkbenchHostNodeData> {
  return createWorkbenchNode<WorkbenchHostNodeData>({
    data: {
      activation: null,
      dockEntryId: input.projectedNode.dockEntryId ?? null,
      ...(input.restoredNode?.data.snapshotNodeState === undefined
        ? {}
        : { snapshotNodeState: input.restoredNode.data.snapshotNodeState }),
      instanceId: input.projectedNode.instanceId,
      instanceKey: input.projectedNode.instanceKey ?? null,
      isProjected: true,
      projectionSubject: input.projectedNode.subject ?? null,
      typeId: input.definition.typeId
    },
    displayMode: input.restoredNode?.displayMode,
    frame:
      input.restoredNode?.frame ??
      input.projectedNode.defaultFrame ??
      input.definition.frame,
    id: createProjectedNodeID(
      input.definition.typeId,
      input.projectedNode.instanceId
    ),
    isMinimized: input.restoredNode?.isMinimized,
    kind: input.definition.typeId,
    restoreFrame: input.restoredNode?.restoreFrame,
    sizeConstraints:
      input.projectedNode.sizeConstraints ??
      input.restoredNode?.sizeConstraints ??
      input.definition.sizeConstraints ??
      null,
    title: input.projectedNode.title
  });
}

export function createWorkbenchLaunchedHostNode(input: {
  activation: WorkbenchHostActivation | null;
  definition: WorkbenchHostNodeDefinition;
  resolvedFrame: WorkbenchNode<WorkbenchHostNodeData>["frame"];
  result: WorkbenchHostLaunchResult;
}): WorkbenchNode<WorkbenchHostNodeData> {
  const preferredFrame = input.result.defaultFrame ?? input.definition.frame;
  return createWorkbenchNode<WorkbenchHostNodeData>({
    data: {
      activation: input.activation,
      dockEntryId: input.result.dockEntryId ?? null,
      instanceId: input.result.instanceId,
      instanceKey: input.result.instanceKey ?? null,
      isProjected: false,
      launchSource: input.result.launchSource ?? null,
      projectionSubject: null,
      typeId: input.definition.typeId
    },
    displayMode: input.result.displayMode,
    frame: input.resolvedFrame,
    id: createLaunchedNodeID(input.definition.typeId, input.result.instanceId),
    kind: input.definition.typeId,
    restoreFrame:
      input.result.displayMode === "fullscreen" ? preferredFrame : null,
    sizeConstraints: resolveWorkbenchHostNodeSizeConstraints(
      input.result,
      input.definition
    ),
    title: input.result.title ?? input.definition.title
  });
}

export function resolveWorkbenchLaunchedHostNodeFrame(input: {
  currentState: Pick<
    WorkbenchState<WorkbenchHostNodeData>,
    "layoutConstraints" | "nodeStack" | "nodes" | "surfaceSize"
  >;
  definition: WorkbenchHostNodeDefinition;
  result: WorkbenchHostLaunchResult;
}): WorkbenchNode<WorkbenchHostNodeData>["frame"] {
  const preferredFrame = input.result.defaultFrame ?? input.definition.frame;
  const sizeConstraints = resolveWorkbenchHostNodeSizeConstraints(
    input.result,
    input.definition
  );

  if (input.result.displayMode === "fullscreen") {
    return getWorkbenchFullscreenRect(
      input.currentState.surfaceSize,
      input.currentState.layoutConstraints,
      sizeConstraints
    );
  }

  const framePolicy = resolveLaunchFramePolicy(input.result);

  if (framePolicy === "absolute") {
    return preferredFrame;
  }

  const responsivePreferredFrame = resolveCompactWorkbenchPreferredFrame({
    constraints: input.currentState.layoutConstraints,
    preferredFrame,
    sizeConstraints,
    surfaceSize: input.currentState.surfaceSize
  });

  if (framePolicy === "cascade-same-type-centered") {
    const existingSameTypeNodes = input.currentState.nodes.filter(
      (node) => node.data.typeId === input.result.typeId
    );
    const existingSameTypeNodeIds = new Set(
      existingSameTypeNodes.map((node) => node.id)
    );

    return resolveWorkbenchCascadedRect({
      cascadeOffset: input.result.cascadeOffset,
      currentNodeStack: input.currentState.nodeStack.filter((nodeId) =>
        existingSameTypeNodeIds.has(nodeId)
      ),
      existingNodes: existingSameTypeNodes,
      preferredFrame: resolveWorkbenchCenteredPreferredFrame({
        constraints: input.currentState.layoutConstraints,
        preferredFrame: responsivePreferredFrame,
        sizeConstraints,
        surfaceSize: input.currentState.surfaceSize
      }),
      sizeConstraints,
      surfaceSize: input.currentState.surfaceSize,
      constraints: input.currentState.layoutConstraints
    });
  }

  return resolveWorkbenchCascadedRect({
    cascadeOffset: input.result.cascadeOffset,
    currentNodeStack: input.currentState.nodeStack,
    existingNodes: input.currentState.nodes,
    preferredFrame: responsivePreferredFrame,
    sizeConstraints,
    surfaceSize: input.currentState.surfaceSize,
    constraints: input.currentState.layoutConstraints
  });
}

export function closedDockWindowFrameEntryKey(input: {
  dockEntryId: string;
  typeId: string;
}): string {
  return JSON.stringify([input.typeId, input.dockEntryId]);
}

export function readClosedDockWindowFrameEntries(
  metadata: WorkbenchSnapshot["metadata"]
): Map<string, ClosedDockWindowFrameEntry> {
  const value = metadata?.[closedDockWindowFramesMetadataKey];
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.entries)
  ) {
    return new Map();
  }

  const entries = new Map<string, ClosedDockWindowFrameEntry>();
  for (const entry of value.entries.slice(0, maxClosedDockWindowFrameEntries)) {
    const normalized = normalizeClosedDockWindowFrameEntry(entry);
    if (!normalized) {
      continue;
    }
    entries.set(closedDockWindowFrameEntryKey(normalized), normalized);
  }
  return entries;
}

export function writeClosedDockWindowFrameEntries(
  metadata: WorkbenchSnapshot["metadata"],
  entries: Iterable<ClosedDockWindowFrameEntry>
): WorkbenchSnapshot["metadata"] {
  const normalizedEntries = Array.from(entries)
    .map(normalizeClosedDockWindowFrameEntry)
    .filter((entry): entry is ClosedDockWindowFrameEntry => entry !== null)
    .slice(-maxClosedDockWindowFrameEntries);
  const nextMetadata = { ...(metadata ?? {}) };
  if (normalizedEntries.length === 0) {
    delete nextMetadata[closedDockWindowFramesMetadataKey];
  } else {
    nextMetadata[closedDockWindowFramesMetadataKey] = {
      version: 1,
      entries: normalizedEntries
    };
  }
  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
}

function normalizeClosedDockWindowFrameEntry(
  value: unknown
): ClosedDockWindowFrameEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const typeId = normalizeNonEmptyString(value.typeId);
  const dockEntryId = normalizeNonEmptyString(value.dockEntryId);
  const frame = normalizeWorkbenchFrame(value.frame);
  if (!typeId || !dockEntryId || !frame) {
    return null;
  }

  return {
    dockEntryId,
    frame,
    typeId
  };
}

function normalizeWorkbenchFrame(value: unknown): WorkbenchFrame | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = normalizeFiniteNumber(value.x);
  const y = normalizeFiniteNumber(value.y);
  const width = normalizeFiniteNumber(value.width);
  const height = normalizeFiniteNumber(value.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  if (width < 160 || height < 120) {
    return null;
  }

  return { height, width, x, y };
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLaunchFramePolicy(
  result: WorkbenchHostLaunchResult
): WorkbenchHostLaunchFramePolicy {
  return result.framePolicy;
}

function resolveWorkbenchCenteredPreferredFrame(input: {
  constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
  preferredFrame: WorkbenchFrame;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
}): WorkbenchFrame {
  const layoutFrame = getWorkbenchLayoutFrame(
    input.surfaceSize,
    input.constraints
  );

  return clampWorkbenchRect(
    {
      height: input.preferredFrame.height,
      width: input.preferredFrame.width,
      x: Math.round(
        layoutFrame.x + (layoutFrame.width - input.preferredFrame.width) / 2
      ),
      y: Math.round(
        layoutFrame.y + (layoutFrame.height - input.preferredFrame.height) / 2
      )
    },
    input.surfaceSize,
    input.constraints,
    input.sizeConstraints
  );
}

export function resolveCompactWorkbenchPreferredFrame(input: {
  constraints: WorkbenchState<WorkbenchHostNodeData>["layoutConstraints"];
  preferredFrame: WorkbenchFrame;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"];
}): WorkbenchFrame {
  if (!shouldUseCompactWorkbenchFrame(input.surfaceSize)) {
    return input.preferredFrame;
  }

  const layoutFrame = getWorkbenchLayoutFrame(
    input.surfaceSize,
    input.constraints
  );
  const width = Math.round(
    input.preferredFrame.width * COMPACT_LAUNCH_FRAME_SCALE
  );
  const height = Math.round(
    input.preferredFrame.height * COMPACT_LAUNCH_FRAME_SCALE
  );

  return clampWorkbenchRect(
    {
      height,
      width,
      x: Math.round(layoutFrame.x + (layoutFrame.width - width) / 2),
      y: Math.round(layoutFrame.y + (layoutFrame.height - height) / 2)
    },
    input.surfaceSize,
    input.constraints,
    input.sizeConstraints
  );
}

function shouldUseCompactWorkbenchFrame(
  surfaceSize: WorkbenchState<WorkbenchHostNodeData>["surfaceSize"]
): boolean {
  return surfaceSize.width < COMPACT_LAUNCH_WIDTH_THRESHOLD;
}

export function createProjectedNodeID(
  typeId: string,
  instanceId: string
): string {
  return createWorkbenchHostProjectedNodeId({ instanceId, typeId });
}

export function persistedWorkbenchState(
  state: Pick<
    WorkbenchState<WorkbenchHostNodeData>,
    "layoutConstraints" | "nodeStack" | "nodes" | "surfaceSize"
  >,
  nodeDefinitionByType: Map<string, WorkbenchHostNodeDefinition>
): Pick<
  WorkbenchState<WorkbenchHostNodeData>,
  "layoutConstraints" | "nodeStack" | "nodes" | "surfaceSize"
> {
  return {
    layoutConstraints: state.layoutConstraints,
    nodeStack: state.nodeStack,
    nodes: state.nodes
      .filter((node) => {
        return (
          nodeDefinitionByType.get(node.data.typeId)?.window?.persists !== false
        );
      })
      .map((node) => ({
        ...node,
        data: {
          dockEntryId: node.data.dockEntryId ?? null,
          ...(node.data.snapshotNodeState === undefined
            ? {}
            : { snapshotNodeState: node.data.snapshotNodeState }),
          instanceId: node.data.instanceId,
          instanceKey: node.data.instanceKey ?? null,
          ...(node.data.isProjected === true ? { isProjected: true } : {}),
          typeId: node.data.typeId
        }
      })),
    surfaceSize: state.surfaceSize
  };
}

export function stateFromSnapshotOrDefinitions(
  snapshot: WorkbenchSnapshot | null,
  nodeDefinitions: readonly WorkbenchHostNodeDefinition[],
  projectedNodes: readonly WorkbenchHostProjectedNode[] = []
): Partial<WorkbenchState<WorkbenchHostNodeData>> {
  if (!snapshot) {
    return mergeProjectedNodesIntoState(
      createDefaultWorkbenchState(nodeDefinitions),
      {
        nodeDefinitions,
        projectedNodes,
        snapshot
      }
    );
  }

  const snapshotState = createWorkbenchStateFromSnapshot<unknown>(snapshot);
  const nodes = snapshotState.nodes
    .map((node) => {
      const definition = resolveDefinitionForRestoredNode(
        node,
        nodeDefinitions
      );
      if (!definition) {
        return null;
      }
      if (readWorkbenchHostNodeData(node.data)?.isProjected === true) {
        return null;
      }
      return createRestoredNode(definition, node);
    })
    .filter(
      (node): node is WorkbenchNode<WorkbenchHostNodeData> => node !== null
    )
    .filter((node) => {
      const definition = nodeDefinitions.find(
        (candidate) => candidate.typeId === node.data.typeId
      );
      return (
        definition?.window?.persists !== false &&
        definition?.window?.restoreOnLoad !== false
      );
    });

  if (nodes.length === 0 && !isSnapshotInitialized(snapshot)) {
    return mergeProjectedNodesIntoState(
      createDefaultWorkbenchState(nodeDefinitions),
      {
        nodeDefinitions,
        projectedNodes,
        snapshot
      }
    );
  }

  const nodeIDs = new Set(nodes.map((node) => node.id));
  const nodeStack = snapshotState.nodeStack.filter((nodeID) =>
    nodeIDs.has(nodeID)
  );
  for (const node of nodes) {
    if (!nodeStack.includes(node.id)) {
      nodeStack.push(node.id);
    }
  }

  return mergeProjectedNodesIntoState(
    {
      nodeStack,
      nodes
    },
    {
      nodeDefinitions,
      projectedNodes,
      snapshot
    }
  );
}

export function restoredSnapshotNodesByID(
  snapshot: WorkbenchSnapshot | null,
  nodeDefinitions: readonly WorkbenchHostNodeDefinition[]
): Map<string, WorkbenchNode<WorkbenchHostNodeData>> {
  if (!snapshot) {
    return new Map();
  }

  const nodes = createWorkbenchStateFromSnapshot<unknown>(snapshot)
    .nodes.map((node) => {
      const definition = resolveDefinitionForRestoredNode(
        node,
        nodeDefinitions
      );
      if (!definition) {
        return null;
      }
      return createRestoredNode(definition, node);
    })
    .filter(
      (node): node is WorkbenchNode<WorkbenchHostNodeData> => node !== null
    );

  return new Map(nodes.map((node) => [node.id, node]));
}

export function updateProjectedNodeFromInput(
  node: WorkbenchNode<WorkbenchHostNodeData>,
  projectedNode: WorkbenchHostProjectedNode,
  definition?: WorkbenchHostNodeDefinition
): WorkbenchNode<WorkbenchHostNodeData> {
  const nextInstanceKey = projectedNode.instanceKey ?? null;
  const nextSubject = projectedNode.subject ?? null;
  const nextDockEntryId = projectedNode.dockEntryId ?? null;
  const nextSizeConstraints =
    projectedNode.sizeConstraints ?? definition?.sizeConstraints ?? null;
  if (
    node.title === projectedNode.title &&
    node.data.dockEntryId === nextDockEntryId &&
    node.data.instanceId === projectedNode.instanceId &&
    node.data.instanceKey === nextInstanceKey &&
    node.data.isProjected === true &&
    projectedSubjectsEqual(node.data.projectionSubject ?? null, nextSubject) &&
    node.sizeConstraints?.minWidth === nextSizeConstraints?.minWidth &&
    node.sizeConstraints?.minHeight === nextSizeConstraints?.minHeight &&
    node.data.typeId === projectedNode.typeId
  ) {
    return node;
  }

  return {
    ...node,
    data: {
      dockEntryId: nextDockEntryId,
      ...(node.data.snapshotNodeState === undefined
        ? {}
        : { snapshotNodeState: node.data.snapshotNodeState }),
      instanceId: projectedNode.instanceId,
      instanceKey: nextInstanceKey,
      activation: node.data.activation ?? null,
      isProjected: true,
      projectionSubject: nextSubject,
      ...(node.data.runtimeNodeState === undefined
        ? {}
        : { runtimeNodeState: node.data.runtimeNodeState }),
      typeId: projectedNode.typeId
    },
    sizeConstraints: nextSizeConstraints,
    title: projectedNode.title
  };
}

export function projectedWorkbenchNodeStack(input: {
  currentNodeStack: readonly string[];
  nextNodes: readonly WorkbenchNode<WorkbenchHostNodeData>[];
  snapshot: WorkbenchSnapshot | null;
}): string[] {
  const nodeIDs = new Set(input.nextNodes.map((node) => node.id));
  const nodeStack = input.currentNodeStack.filter((nodeID) =>
    nodeIDs.has(nodeID)
  );
  const snapshotState = input.snapshot
    ? createWorkbenchStateFromSnapshot<unknown>(input.snapshot)
    : null;
  for (const nodeID of snapshotState?.nodeStack ?? []) {
    if (nodeIDs.has(nodeID) && !nodeStack.includes(nodeID)) {
      nodeStack.push(nodeID);
    }
  }
  for (const node of input.nextNodes) {
    if (!nodeStack.includes(node.id)) {
      nodeStack.push(node.id);
    }
  }
  return nodeStack;
}

export function shallowArrayEqual<T>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

export function stringArrayEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function createWorkbenchHostNode(input: {
  definition: WorkbenchHostNodeDefinition;
  descriptor: {
    frame?: WorkbenchNode<WorkbenchHostNodeData>["frame"];
    instanceId?: string;
    instanceKey?: string | null;
    title?: string;
  };
}): WorkbenchNode<WorkbenchHostNodeData> {
  const strategy = input.definition.instance;
  const instanceId =
    input.descriptor.instanceId ??
    (strategy?.mode === "multi"
      ? `${input.definition.typeId}-instance`
      : input.definition.typeId);
  const nodeId =
    strategy?.mode === "multi"
      ? `${input.definition.typeId}:${instanceId}`
      : input.definition.typeId;

  return createWorkbenchNode<WorkbenchHostNodeData>({
    data: {
      activation: null,
      dockEntryId: null,
      instanceId,
      instanceKey: input.descriptor.instanceKey ?? null,
      isProjected: false,
      projectionSubject: null,
      typeId: input.definition.typeId
    },
    frame: input.descriptor.frame ?? input.definition.frame,
    id: nodeId,
    kind: input.definition.typeId,
    sizeConstraints: input.definition.sizeConstraints ?? null,
    title: input.descriptor.title ?? input.definition.title
  });
}

function createLaunchedNodeID(typeId: string, instanceId: string): string {
  return createWorkbenchHostLaunchedNodeId({ instanceId, typeId });
}

function createDefaultWorkbenchState(
  nodeDefinitions: readonly WorkbenchHostNodeDefinition[]
): Partial<WorkbenchState<WorkbenchHostNodeData>> {
  const nodes = nodeDefinitions
    .filter((definition) => definition.window?.defaultOpen !== false)
    .filter((definition) => definition.instance?.mode !== "multi")
    .map((definition) =>
      createWorkbenchHostNode({
        definition,
        descriptor: {
          frame: definition.frame,
          instanceId: definition.typeId,
          title: definition.title
        }
      })
    );
  return {
    nodeStack: nodes.map((node) => node.id),
    nodes
  };
}

function createRestoredNode(
  definition: WorkbenchHostNodeDefinition,
  node: WorkbenchNode<unknown>
): WorkbenchNode<WorkbenchHostNodeData> {
  const restoredData = readWorkbenchHostNodeData(node.data);
  return {
    ...node,
    data: {
      dockEntryId: restoredData?.dockEntryId ?? null,
      ...(restoredData?.snapshotNodeState === undefined
        ? {}
        : { snapshotNodeState: restoredData.snapshotNodeState }),
      instanceId:
        restoredData?.instanceId ??
        (definition.instance?.mode === "multi"
          ? deriveInstanceIdFromNodeID(definition.typeId, node.id)
          : definition.typeId),
      instanceKey: restoredData?.instanceKey ?? null,
      activation: null,
      isProjected: false,
      projectionSubject: null,
      typeId: definition.typeId
    },
    kind: definition.typeId,
    sizeConstraints: definition.sizeConstraints ?? null,
    title: definition.instance?.mode === "multi" ? node.title : definition.title
  };
}

export function resolveWorkbenchHostNodeSizeConstraints(
  result: Pick<WorkbenchHostLaunchResult, "sizeConstraints">,
  definition: Pick<WorkbenchHostNodeDefinition, "sizeConstraints">
): WorkbenchNodeSizeConstraints | null {
  return result.sizeConstraints ?? definition.sizeConstraints ?? null;
}

function deriveInstanceIdFromNodeID(typeId: string, nodeId: string): string {
  const prefix = `${typeId}:`;
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : nodeId;
}

function isSnapshotInitialized(snapshot: WorkbenchSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  for (const key of initializedMetadataKeys) {
    if (snapshot.metadata?.[key] === true) {
      return true;
    }
  }
  return false;
}

function readWorkbenchHostNodeData(
  value: unknown
): WorkbenchHostNodeData | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const typed = value as Partial<WorkbenchHostNodeData>;
  if (
    typeof typed.typeId !== "string" ||
    typeof typed.instanceId !== "string"
  ) {
    return null;
  }

  return {
    dockEntryId:
      typeof typed.dockEntryId === "string" || typed.dockEntryId === null
        ? typed.dockEntryId
        : null,
    ...(typed.snapshotNodeState === undefined
      ? {}
      : { snapshotNodeState: typed.snapshotNodeState }),
    instanceId: typed.instanceId,
    instanceKey:
      typeof typed.instanceKey === "string" || typed.instanceKey === null
        ? typed.instanceKey
        : null,
    activation: null,
    isProjected: typed.isProjected === true,
    launchSource: null,
    projectionSubject: null,
    typeId: typed.typeId
  };
}

function resolveDefinitionForRestoredNode(
  node: WorkbenchNode<unknown>,
  nodeDefinitions: readonly WorkbenchHostNodeDefinition[]
): WorkbenchHostNodeDefinition | null {
  const data = readWorkbenchHostNodeData(node.data);
  if (data) {
    return (
      nodeDefinitions.find((definition) => definition.typeId === data.typeId) ??
      null
    );
  }

  return (
    nodeDefinitions.find((definition) => {
      if (definition.instance?.mode === "multi") {
        return node.id.startsWith(`${definition.typeId}:`);
      }
      return node.id === definition.typeId;
    }) ?? null
  );
}

function mergeProjectedNodesIntoState(
  state: Partial<WorkbenchState<WorkbenchHostNodeData>>,
  input: {
    nodeDefinitions: readonly WorkbenchHostNodeDefinition[];
    projectedNodes: readonly WorkbenchHostProjectedNode[];
    snapshot: WorkbenchSnapshot | null;
  }
): Partial<WorkbenchState<WorkbenchHostNodeData>> {
  if (input.projectedNodes.length === 0) {
    return state;
  }

  const nodeDefinitionByType = new Map(
    input.nodeDefinitions.map((definition) => [definition.typeId, definition])
  );
  const nodes = state.nodes ? [...state.nodes] : [];
  const nodeIDs = new Set(nodes.map((node) => node.id));
  const restoredNodesByID = restoredSnapshotNodesByID(
    input.snapshot,
    input.nodeDefinitions
  );

  for (const projectedNode of input.projectedNodes) {
    const definition = nodeDefinitionByType.get(projectedNode.typeId);
    if (!definition) {
      continue;
    }
    const nodeID = createProjectedNodeID(
      projectedNode.typeId,
      projectedNode.instanceId
    );
    if (nodeIDs.has(nodeID)) {
      continue;
    }

    const nextNode = createWorkbenchProjectedHostNode({
      definition,
      projectedNode,
      restoredNode: restoredNodesByID.get(nodeID) ?? null
    });
    nodes.push(nextNode);
    nodeIDs.add(nextNode.id);
  }

  return {
    ...state,
    nodeStack: projectedWorkbenchNodeStack({
      currentNodeStack: state.nodeStack ?? [],
      nextNodes: nodes,
      snapshot: input.snapshot
    }),
    nodes
  };
}

function projectedSubjectsEqual(
  left: WorkbenchHostNodeData["projectionSubject"],
  right: WorkbenchHostNodeData["projectionSubject"]
): boolean {
  return left?.id === right?.id && left?.type === right?.type;
}
