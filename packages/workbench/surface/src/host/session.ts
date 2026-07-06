import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import { createWorkbenchSnapshotFromState } from "../core/snapshot.ts";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "../store/types.ts";
import {
  type ClosedDockWindowFrameEntry,
  compactRestoredWorkbenchHostNodes,
  createDefaultLaunchResult,
  createProjectedNodeID,
  createWorkbenchLaunchedHostNode,
  createWorkbenchProjectedHostNode,
  closedDockWindowFrameEntryKey,
  persistedWorkbenchState,
  projectedWorkbenchNodeStack,
  readClosedDockWindowFrameEntries,
  resolveWorkbenchLaunchedHostNodeFrame,
  restoredSnapshotNodesByID,
  shallowArrayEqual,
  stateFromSnapshotOrDefinitions,
  stringArrayEqual,
  updateProjectedNodeFromInput,
  writeClosedDockWindowFrameEntries
} from "./sessionState.ts";
import { readWorkbenchHostExternalState } from "./externalState.ts";
import { sanitizeWorkbenchHostSnapshot } from "./snapshotSanitizer.ts";
import type { WorkbenchHostNodeData } from "./types.ts";
import type {
  WorkbenchHostActivation,
  WorkbenchHostActivationTarget,
  WorkbenchHostCloseEffect,
  WorkbenchHostExternalStateSource,
  WorkbenchHostLaunchInput,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeLeaseHandle,
  WorkbenchHostNodeCloseDecision,
  WorkbenchHostNodeCloseRequest,
  WorkbenchHostNodeDefinition,
  WorkbenchHostProjectedNode,
  WorkbenchHostRuntimeHandle,
  WorkbenchHostSnapshotRepository
} from "./types.ts";

const initializedMetadataKey = "workbenchHostInitialized";
const snapshotSaveDelayMs = 400;
const launchDiagnosticTextMaxLength = 800;

export function createWorkbenchHostSession(input: {
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  externalStateSource?: WorkbenchHostExternalStateSource;
  nodes: readonly WorkbenchHostNodeDefinition[];
  onLaunchRequest?: (
    request: WorkbenchHostLaunchRequest
  ) =>
    | Promise<WorkbenchHostLaunchResult | null | void>
    | WorkbenchHostLaunchResult
    | null
    | void;
  onNodeCloseRequest?: (
    request: WorkbenchHostNodeCloseRequest
  ) =>
    | Promise<WorkbenchHostNodeCloseDecision | void>
    | WorkbenchHostNodeCloseDecision
    | void;
  projectedNodes?: readonly WorkbenchHostProjectedNode[];
  snapshotRepository: WorkbenchHostSnapshotRepository;
  workspaceId: string;
}): WorkbenchHostRuntimeHandle {
  return new WorkbenchHostSessionController(input);
}

class WorkbenchHostSessionController implements WorkbenchHostRuntimeHandle {
  readonly controller: WorkbenchController<WorkbenchHostNodeData>;
  private readonly input: {
    debugDiagnostics?: WorkbenchDebugDiagnostics;
    externalStateSource?: WorkbenchHostExternalStateSource;
    nodes: readonly WorkbenchHostNodeDefinition[];
    onLaunchRequest?: (
      request: WorkbenchHostLaunchRequest
    ) =>
      | Promise<WorkbenchHostLaunchResult | null | void>
      | WorkbenchHostLaunchResult
      | null
      | void;
    onNodeCloseRequest?: (
      request: WorkbenchHostNodeCloseRequest
    ) =>
      | Promise<WorkbenchHostNodeCloseDecision | void>
      | WorkbenchHostNodeCloseDecision
      | void;
    projectedNodes?: readonly WorkbenchHostProjectedNode[];
    snapshotRepository: WorkbenchHostSnapshotRepository;
    workspaceId: string;
  };

  private readonly nodeDefinitions: readonly WorkbenchHostNodeDefinition[];
  private readonly nodeDefinitionByType = new Map<
    string,
    WorkbenchHostNodeDefinition
  >();
  private isHydratingInitialSnapshot = true;
  private isDisposed = false;
  private isSnapshotLoaded = false;
  private loadedSnapshot: WorkbenchSnapshot | null;
  private closedDockWindowFrameEntries = new Map<
    string,
    ClosedDockWindowFrameEntry
  >();
  private loadGeneration = 0;
  private loadPromise: Promise<void> | null = null;
  private readonly nodeLeases = new Map<string, WorkbenchHostNodeLeaseHandle>();
  private nextActivationSequence = 1;
  private hasAppliedInitialCompactRestoredFrames = false;
  private hasReceivedSurfaceSize = false;
  private observedSurfaceSize:
    | WorkbenchState<WorkbenchHostNodeData>["surfaceSize"]
    | null = null;
  private pendingProjectedNodeReconciliation = false;
  private projectedNodes: readonly WorkbenchHostProjectedNode[];
  private readyPromise: Promise<void>;
  private resolveReady: () => void = noop;
  private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private externalStateUnsubscribe: (() => void) | null = null;
  private leaseUnsubscribe: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(input: {
    debugDiagnostics?: WorkbenchDebugDiagnostics;
    externalStateSource?: WorkbenchHostExternalStateSource;
    nodes: readonly WorkbenchHostNodeDefinition[];
    onLaunchRequest?: (
      request: WorkbenchHostLaunchRequest
    ) =>
      | Promise<WorkbenchHostLaunchResult | null | void>
      | WorkbenchHostLaunchResult
      | null
      | void;
    onNodeCloseRequest?: (
      request: WorkbenchHostNodeCloseRequest
    ) =>
      | Promise<WorkbenchHostNodeCloseDecision | void>
      | WorkbenchHostNodeCloseDecision
      | void;
    projectedNodes?: readonly WorkbenchHostProjectedNode[];
    snapshotRepository: WorkbenchHostSnapshotRepository;
    workspaceId: string;
  }) {
    this.input = input;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.nodeDefinitions = input.nodes;
    for (const definition of input.nodes) {
      this.nodeDefinitionByType.set(definition.typeId, definition);
    }
    this.loadedSnapshot = this.readCachedSnapshot();
    this.closedDockWindowFrameEntries = readClosedDockWindowFrameEntries(
      this.loadedSnapshot?.metadata
    );
    this.projectedNodes = input.projectedNodes ?? [];
    this.controller = createWorkbenchController<WorkbenchHostNodeData>(
      stateFromSnapshotOrDefinitions(
        this.loadedSnapshot,
        this.nodeDefinitions,
        this.projectedNodes
      ),
      { debugDiagnostics: input.debugDiagnostics }
    );
    this.observedSurfaceSize = this.controller.getSnapshot().surfaceSize;
    this.leaseUnsubscribe = this.controller.subscribe(() => {
      this.noteSurfaceSizeChange();
      this.reconcileNodeLeases();
      this.applyInitialCompactRestoredFrames();
    });
    this.isSnapshotLoaded = this.loadedSnapshot !== null;
    if (this.isSnapshotLoaded) {
      this.applyInitialCompactRestoredFrames();
      this.subscribeToPersistence();
    }
  }

  activateNode(
    target: WorkbenchHostActivationTarget,
    activation: {
      payload?: unknown;
      type: string;
    }
  ): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.activateNodeNow(target, activation);
    });
  }

  private activateNodeNow(
    target: WorkbenchHostActivationTarget,
    activation: {
      payload?: unknown;
      type: string;
    }
  ): void {
    if (!activation.type.trim()) {
      return;
    }

    const node = this.findExistingNodeByTarget(target);
    if (!node) {
      return;
    }

    const envelope: WorkbenchHostActivation = {
      sequence: this.nextActivationSequence++,
      type: activation.type,
      ...(activation.payload === undefined
        ? {}
        : { payload: activation.payload })
    };
    this.restoreAndFocusNode(node.id);
    this.controller.commands.replaceState({
      nodes: this.controller.getSnapshot().nodes.map((entry) =>
        entry.id === node.id
          ? {
              ...entry,
              data: {
                ...entry.data,
                activation: envelope
              }
            }
          : entry
      )
    });
  }

  clearNodeActivation(nodeId: string, sequence: number): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.clearNodeActivationNow(nodeId, sequence);
    });
  }

  private clearNodeActivationNow(nodeId: string, sequence: number): void {
    const snapshot = this.controller.getSnapshot();
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    if (node?.data.activation?.sequence !== sequence) {
      return;
    }

    this.controller.commands.replaceState({
      nodes: snapshot.nodes.map((entry) =>
        entry.id === nodeId
          ? {
              ...entry,
              data: {
                ...entry.data,
                activation: null
              }
            }
          : entry
      )
    });
  }

  async collectWindowCloseEffects(): Promise<
    readonly WorkbenchHostCloseEffect[]
  > {
    const snapshot = this.controller.getSnapshot();
    const effects = await Promise.all(
      snapshot.nodes.map(async (node) => {
        const definition = this.nodeDefinitionByType.get(node.data.typeId);
        if (!definition?.getWindowCloseEffect) {
          return null;
        }
        const externalState = readWorkbenchHostExternalState({
          externalStateSource: this.input.externalStateSource,
          node,
          workspaceId: this.input.workspaceId
        });
        const effect = await definition.getWindowCloseEffect({
          externalNodeState: externalState.externalNodeState,
          externalWorkspaceState: externalState.externalWorkspaceState,
          instanceId: node.data.instanceId,
          instanceKey: node.data.instanceKey ?? null,
          node,
          workspaceId: this.input.workspaceId
        });
        return effect ?? null;
      })
    );
    return effects.filter(
      (effect): effect is WorkbenchHostCloseEffect => effect !== null
    );
  }

  closeNode(nodeId: string): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.rememberClosedDockWindowFrame(nodeId);
      this.controller.commands.closeNode(nodeId);
    });
  }

  dispose(): void {
    this.isDisposed = true;
    this.loadGeneration++;
    this.loadPromise = null;
    this.markReady();
    this.leaseUnsubscribe?.();
    this.leaseUnsubscribe = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.externalStateUnsubscribe?.();
    this.externalStateUnsubscribe = null;
    if (this.saveTimer !== null) {
      globalThis.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveSnapshot();
    }
    this.disposeNodeLeases();
  }

  focusNode(nodeId: string): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.restoreAndFocusNode(nodeId);
    });
  }

  minimizeNode(nodeId: string): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.controller.commands.minimizeNode(nodeId);
    });
  }

  exitFullscreenNode(nodeId: string): void {
    this.runWhenReady(this.loadGeneration, () => {
      this.controller.commands.exitFullscreen(nodeId);
    });
  }

  getSnapshot(): ReturnType<
    WorkbenchController<WorkbenchHostNodeData>["getSnapshot"]
  > {
    return this.controller.getSnapshot();
  }

  isHydrating(): boolean {
    return this.isHydratingInitialSnapshot;
  }

  async launchNode(input: WorkbenchHostLaunchInput): Promise<string | null> {
    const generation = this.loadGeneration;
    if (!(await this.waitUntilReady(generation))) {
      return null;
    }

    const definition = this.nodeDefinitionByType.get(input.typeId);
    if (!definition) {
      return null;
    }

    const launchSource = resolveWorkbenchHostLaunchSource(input);
    const currentState = this.controller.getSnapshot();
    const request: WorkbenchHostLaunchRequest = {
      ...input,
      layoutConstraints: currentState.layoutConstraints,
      surfaceSize: currentState.surfaceSize,
      workspaceId: this.input.workspaceId
    };
    if (launchSource !== null) {
      request.launchSource = launchSource;
    }

    let result: WorkbenchHostLaunchResult | null | void;
    try {
      result = this.input.onLaunchRequest
        ? await this.input.onLaunchRequest(request)
        : createDefaultLaunchResult(definition, {
            dockEntryId: input.dockEntryId,
            launchSource
          });
    } catch (error) {
      this.logLaunchFailure(request, error);
      return null;
    }
    if (this.isDisposed || !result || generation !== this.loadGeneration) {
      return null;
    }

    return this.openLaunchResult({
      ...result,
      launchSource: result.launchSource ?? launchSource
    });
  }

  private logLaunchFailure(
    request: WorkbenchHostLaunchRequest,
    error: unknown
  ): void {
    void Promise.resolve(
      this.input.debugDiagnostics?.log?.({
        details: {
          dockEntryId: request.dockEntryId ?? null,
          error: diagnosticErrorDetails(error),
          launchSource: request.launchSource ?? null,
          payload: diagnosticValueSummary(request.payload),
          reason: request.reason,
          typeId: request.typeId
        },
        event: "host.launch.failed",
        level: "error",
        source: "workbench-host",
        workspaceId: request.workspaceId
      })
    ).catch(() => undefined);
  }

  async load(): Promise<void> {
    if (this.loadPromise && !this.isDisposed) {
      return this.loadPromise;
    }

    const generation = ++this.loadGeneration;
    if (!this.isHydratingInitialSnapshot) {
      this.resetHydrationBarrier();
    }
    this.isDisposed = false;
    this.loadPromise = this.loadInitialSnapshot(generation);
    return this.loadPromise;
  }

  private async loadInitialSnapshot(generation: number): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.externalStateUnsubscribe?.();
    this.externalStateUnsubscribe = null;
    if (this.saveTimer !== null) {
      globalThis.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      const snapshot = await this.input.snapshotRepository.load(
        this.input.workspaceId
      );
      if (this.isDisposed || generation !== this.loadGeneration) {
        return;
      }

      this.loadedSnapshot = snapshot;
      this.closedDockWindowFrameEntries = readClosedDockWindowFrameEntries(
        snapshot?.metadata
      );
      this.controller.commands.replaceState(
        stateFromSnapshotOrDefinitions(
          snapshot,
          this.nodeDefinitions,
          this.projectedNodes
        )
      );
      this.applyProjectedNodes(this.projectedNodes);
    } catch {
      if (this.isDisposed || generation !== this.loadGeneration) {
        return;
      }
      this.loadedSnapshot = null;
      this.closedDockWindowFrameEntries = new Map();
      this.controller.commands.replaceState(
        stateFromSnapshotOrDefinitions(
          null,
          this.nodeDefinitions,
          this.projectedNodes
        )
      );
      this.applyProjectedNodes(this.projectedNodes);
    }

    this.reconcileNodeLeases();
    this.isSnapshotLoaded = true;
    this.applyInitialCompactRestoredFrames();
    this.subscribeToPersistence();
    this.markReady();
  }

  requestNodeClose(nodeId: string): void {
    const generation = this.loadGeneration;
    this.runWhenReady(generation, () => {
      this.requestNodeCloseNow(nodeId, generation);
    });
  }

  private requestNodeCloseNow(nodeId: string, generation: number): void {
    const node =
      this.controller
        .getSnapshot()
        .nodes.find((entry) => entry.id === nodeId) ?? null;
    if (!node) {
      return;
    }

    const request = {
      instanceId: node.data.instanceId,
      instanceKey: node.data.instanceKey ?? null,
      isProjected: node.data.isProjected === true,
      nodeId: node.id,
      subject: node.data.projectionSubject ?? null,
      typeId: node.data.typeId,
      workspaceId: this.input.workspaceId
    };
    if (node.data.isProjected === true && !this.input.onNodeCloseRequest) {
      return;
    }
    const decision = this.input.onNodeCloseRequest?.(request);
    void Promise.resolve(decision).then((resolvedDecision) => {
      if (
        this.isDisposed ||
        resolvedDecision === "keep-open" ||
        generation !== this.loadGeneration
      ) {
        return;
      }
      this.rememberClosedDockWindowFrame(node.id);
      this.controller.commands.closeNode(node.id);
    }, noop);
  }

  setNodeRuntimeState(nodeId: string, state: unknown): void {
    const snapshot = this.controller.getSnapshot();
    if (!snapshot.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    this.controller.commands.replaceState({
      nodes: snapshot.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data:
                state === undefined
                  ? withoutRuntimeNodeState(node.data)
                  : {
                      ...node.data,
                      runtimeNodeState: state
                    }
            }
          : node
      )
    });
  }

  setNodeSizeConstraints(
    nodeId: string,
    sizeConstraints: WorkbenchNode["sizeConstraints"]
  ): void {
    this.controller.commands.setNodeSizeConstraints(
      nodeId,
      sizeConstraints ?? null
    );
  }

  setNodeTitle(nodeId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    const snapshot = this.controller.getSnapshot();
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    if (!node || node.title === nextTitle) {
      return;
    }

    this.controller.commands.replaceState({
      nodes: snapshot.nodes.map((entry) =>
        entry.id === nodeId
          ? {
              ...entry,
              title: nextTitle
            }
          : entry
      )
    });
  }

  setSnapshotNodeState(nodeId: string, state: unknown): void {
    const snapshot = this.controller.getSnapshot();
    if (!snapshot.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    this.controller.commands.replaceState({
      nodes: snapshot.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data:
                state === undefined
                  ? withoutSnapshotNodeState(node.data)
                  : {
                      ...node.data,
                      snapshotNodeState: state
                    }
            }
          : node
      )
    });
  }

  reconcileProjectedNodes(
    projectedNodes: readonly WorkbenchHostProjectedNode[]
  ): void {
    this.projectedNodes = projectedNodes;
    if (this.isHydratingInitialSnapshot) {
      this.queueProjectedNodeReconciliation();
      return;
    }

    this.applyProjectedNodes(projectedNodes);
  }

  private applyProjectedNodes(
    projectedNodes: readonly WorkbenchHostProjectedNode[]
  ): void {
    const projectedNodesByID = new Map(
      projectedNodes.map((node) => [
        createProjectedNodeID(node.typeId, node.instanceId),
        node
      ])
    );
    const currentState = this.controller.getSnapshot();
    const snapshotNodesByID = restoredSnapshotNodesByID(
      this.loadedSnapshot,
      this.nodeDefinitions
    );

    const nextNodes = currentState.nodes
      .filter(
        (node) => !node.data.isProjected || projectedNodesByID.has(node.id)
      )
      .map((node) => {
        const projectedNode = projectedNodesByID.get(node.id);
        return projectedNode
          ? updateProjectedNodeFromInput(
              node,
              projectedNode,
              this.nodeDefinitionByType.get(projectedNode.typeId)
            )
          : node;
      });
    const nextNodeIDs = new Set(nextNodes.map((node) => node.id));

    for (const projectedNode of projectedNodes) {
      const nodeID = createProjectedNodeID(
        projectedNode.typeId,
        projectedNode.instanceId
      );
      if (nextNodeIDs.has(nodeID)) {
        continue;
      }

      const definition = this.nodeDefinitionByType.get(projectedNode.typeId);
      if (!definition) {
        continue;
      }

      const nextNode = createWorkbenchProjectedHostNode({
        definition,
        projectedNode,
        restoredNode: snapshotNodesByID.get(nodeID) ?? null
      });
      nextNodes.push(nextNode);
      nextNodeIDs.add(nextNode.id);
    }

    const nodeStack = projectedWorkbenchNodeStack({
      currentNodeStack: currentState.nodeStack,
      nextNodes,
      snapshot: this.loadedSnapshot
    });
    if (
      shallowArrayEqual(currentState.nodes, nextNodes) &&
      stringArrayEqual(currentState.nodeStack, nodeStack)
    ) {
      return;
    }

    this.controller.commands.replaceState({
      nodeStack,
      nodes: nextNodes
    });
  }

  private openLaunchResult(result: WorkbenchHostLaunchResult): string | null {
    const definition = this.nodeDefinitionByType.get(result.typeId);
    if (!definition) {
      return null;
    }
    const launchResult = this.applyClosedDockWindowFrame(result);

    const exactExisting = this.findExistingNodeByTarget({
      instanceId: launchResult.instanceId,
      typeId: launchResult.typeId
    });
    const dockEntryExisting = exactExisting
      ? null
      : this.findExistingNodeByDockEntry(launchResult);
    const existing = exactExisting ?? dockEntryExisting;
    if (existing) {
      this.controller.commands.setNodeSizeConstraints(
        existing.id,
        launchResult.sizeConstraints ?? definition.sizeConstraints ?? null
      );
      if (
        exactExisting &&
        !launchResult.preserveExistingNodeFrame &&
        launchResult.framePolicy === "cascade-same-type-centered"
      ) {
        const currentState = this.controller.getSnapshot();
        const resolvedFrame = resolveWorkbenchLaunchedHostNodeFrame({
          currentState: {
            ...currentState,
            nodes: currentState.nodes.filter((node) => node.id !== existing.id),
            nodeStack: currentState.nodeStack.filter(
              (nodeId) => nodeId !== existing.id
            )
          },
          definition,
          result: launchResult
        });
        this.controller.commands.resizeNode(existing.id, resolvedFrame);
      }
      this.restoreAndFocusNode(existing.id);
      if (launchResult.activation) {
        this.activateNodeNow({ nodeId: existing.id }, launchResult.activation);
      }
      return existing.id;
    }

    const resolvedFrame = resolveWorkbenchLaunchedHostNodeFrame({
      currentState: this.controller.getSnapshot(),
      definition,
      result: launchResult
    });
    const nextNode = createWorkbenchLaunchedHostNode({
      activation: this.createActivationEnvelope(launchResult.activation),
      definition,
      resolvedFrame,
      result: launchResult
    });
    this.controller.commands.openNode(nextNode);
    this.controller.commands.focusNode(nextNode.id);
    return nextNode.id;
  }

  private createActivationEnvelope(
    activation: WorkbenchHostLaunchResult["activation"]
  ): WorkbenchHostActivation | null {
    if (!activation?.type.trim()) {
      return null;
    }

    return {
      sequence: this.nextActivationSequence++,
      type: activation.type,
      ...(activation.payload === undefined
        ? {}
        : { payload: activation.payload })
    };
  }

  private findExistingNodeByTarget(
    target: WorkbenchHostActivationTarget
  ): WorkbenchNode<WorkbenchHostNodeData> | null {
    const snapshot = this.controller.getSnapshot();
    if ("nodeId" in target) {
      return snapshot.nodes.find((node) => node.id === target.nodeId) ?? null;
    }

    const definition = this.nodeDefinitionByType.get(target.typeId);
    if (!definition) {
      return null;
    }
    const nodes = snapshot.nodes.filter(
      (node) => node.data.typeId === definition.typeId
    );
    if (target.instanceId) {
      return (
        nodes.find((node) => node.data.instanceId === target.instanceId) ?? null
      );
    }

    if (definition.instance?.mode === "multi") {
      return null;
    }

    return nodes[0] ?? null;
  }

  private findExistingNodeByDockEntry(
    result: WorkbenchHostLaunchResult
  ): WorkbenchNode<WorkbenchHostNodeData> | null {
    const dockEntryId = result.dockEntryId?.trim();
    if (!result.reuseDockEntryNode || !dockEntryId) {
      return null;
    }

    const snapshot = this.controller.getSnapshot();
    const nodesByID = new Map(snapshot.nodes.map((node) => [node.id, node]));
    for (let index = snapshot.nodeStack.length - 1; index >= 0; index -= 1) {
      const node = nodesByID.get(snapshot.nodeStack[index] ?? "");
      if (
        node?.data.typeId === result.typeId &&
        node.data.dockEntryId === dockEntryId
      ) {
        return node;
      }
    }

    return (
      snapshot.nodes.find(
        (node) =>
          node.data.typeId === result.typeId &&
          node.data.dockEntryId === dockEntryId
      ) ?? null
    );
  }

  private readCachedSnapshot(): WorkbenchSnapshot | null {
    if (!this.input.snapshotRepository.hasLoaded?.(this.input.workspaceId)) {
      return null;
    }

    return (
      this.input.snapshotRepository.readCached?.(this.input.workspaceId) ?? null
    );
  }

  private markReady(): void {
    if (!this.isHydratingInitialSnapshot) {
      return;
    }

    this.isHydratingInitialSnapshot = false;
    this.resolveReady();
  }

  private resetHydrationBarrier(): void {
    this.isHydratingInitialSnapshot = true;
    this.hasAppliedInitialCompactRestoredFrames = false;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private noteSurfaceSizeChange(): void {
    const currentSurfaceSize = this.controller.getSnapshot().surfaceSize;
    if (
      this.observedSurfaceSize &&
      (this.observedSurfaceSize.width !== currentSurfaceSize.width ||
        this.observedSurfaceSize.height !== currentSurfaceSize.height)
    ) {
      this.hasReceivedSurfaceSize = true;
    }
    this.observedSurfaceSize = currentSurfaceSize;
  }

  private applyInitialCompactRestoredFrames(): void {
    if (
      this.hasAppliedInitialCompactRestoredFrames ||
      !this.isSnapshotLoaded ||
      !this.hasReceivedSurfaceSize
    ) {
      return;
    }

    const snapshot = this.controller.getSnapshot();
    const compactedNodes = compactRestoredWorkbenchHostNodes({
      constraints: snapshot.layoutConstraints,
      nodeDefinitionByType: this.nodeDefinitionByType,
      nodes: snapshot.nodes,
      surfaceSize: snapshot.surfaceSize
    });
    this.hasAppliedInitialCompactRestoredFrames = true;
    if (shallowArrayEqual(snapshot.nodes, compactedNodes)) {
      return;
    }
    this.controller.commands.replaceNodes(compactedNodes);
  }

  private queueProjectedNodeReconciliation(): void {
    if (this.pendingProjectedNodeReconciliation) {
      return;
    }

    const generation = this.loadGeneration;
    this.pendingProjectedNodeReconciliation = true;
    void this.readyPromise.then(() => {
      this.pendingProjectedNodeReconciliation = false;
      if (this.isDisposed || generation !== this.loadGeneration) {
        return;
      }
      this.applyProjectedNodes(this.projectedNodes);
    });
  }

  private runWhenReady(generation: number, action: () => void): void {
    if (!this.isHydratingInitialSnapshot) {
      if (!this.isDisposed && generation === this.loadGeneration) {
        action();
      }
      return;
    }

    void this.readyPromise.then(() => {
      if (this.isDisposed || generation !== this.loadGeneration) {
        return;
      }
      action();
    });
  }

  private async waitUntilReady(generation: number): Promise<boolean> {
    if (!this.isHydratingInitialSnapshot) {
      return !this.isDisposed && generation === this.loadGeneration;
    }

    await this.readyPromise;
    return !this.isDisposed && generation === this.loadGeneration;
  }

  private restoreAndFocusNode(nodeId: string): void {
    const existing = this.controller
      .getSnapshot()
      .nodes.find((node) => node.id === nodeId);
    if (!existing) {
      return;
    }
    if (existing.isMinimized) {
      this.controller.commands.restoreNode(existing.id);
    }
    this.controller.commands.focusNode(existing.id);
  }

  private saveSnapshot(): void {
    if (!this.isSnapshotLoaded) {
      return;
    }

    const snapshot = sanitizeWorkbenchHostSnapshot(
      createWorkbenchSnapshotFromState(
        this.applyExternalSnapshotNodeState(
          persistedWorkbenchState(
            this.controller.getSnapshot(),
            this.nodeDefinitionByType
          )
        ),
        {
          activeSpaceId: this.loadedSnapshot?.activeSpaceId,
          metadata: writeClosedDockWindowFrameEntries(
            {
              ...(this.loadedSnapshot?.metadata ?? {}),
              [initializedMetadataKey]: true
            },
            this.closedDockWindowFrameEntries.values()
          ),
          spaces: this.loadedSnapshot?.spaces
        }
      )
    );
    if (workbenchSnapshotSaveKey(snapshot) === this.loadedSnapshotSaveKey()) {
      return;
    }
    void Promise.resolve(
      this.input.snapshotRepository.save(this.input.workspaceId, snapshot)
    ).then((savedSnapshot) => {
      this.loadedSnapshot = savedSnapshot;
    }, noop);
  }

  private rememberClosedDockWindowFrame(nodeId: string): void {
    const node = this.controller
      .getSnapshot()
      .nodes.find((entry) => entry.id === nodeId);
    const dockEntryId = node?.data.dockEntryId?.trim();
    if (!node || !dockEntryId) {
      return;
    }

    const entry: ClosedDockWindowFrameEntry = {
      dockEntryId,
      frame:
        node.displayMode === "fullscreen" && node.restoreFrame
          ? node.restoreFrame
          : node.frame,
      typeId: node.data.typeId
    };
    this.closedDockWindowFrameEntries.set(
      closedDockWindowFrameEntryKey(entry),
      entry
    );
  }

  private applyClosedDockWindowFrame(
    result: WorkbenchHostLaunchResult
  ): WorkbenchHostLaunchResult {
    const dockEntryId = result.dockEntryId?.trim();
    if (!dockEntryId || result.reuseDockEntryNode === false) {
      return result;
    }

    const entry = this.closedDockWindowFrameEntries.get(
      closedDockWindowFrameEntryKey({
        dockEntryId,
        typeId: result.typeId
      })
    );
    if (!entry) {
      return result;
    }

    return {
      ...result,
      defaultFrame: entry.frame,
      framePolicy: "absolute"
    };
  }

  private loadedSnapshotSaveKey(): string | null {
    if (!this.loadedSnapshot) {
      return null;
    }
    return workbenchSnapshotSaveKey(
      sanitizeWorkbenchHostSnapshot(this.loadedSnapshot)
    );
  }

  private schedulePersistedSnapshotWrite(): void {
    if (!this.isSnapshotLoaded || this.isDisposed) {
      return;
    }

    if (this.saveTimer !== null) {
      globalThis.clearTimeout(this.saveTimer);
    }
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = null;
      this.saveSnapshot();
    }, snapshotSaveDelayMs);
  }

  private subscribeToPersistence(): void {
    if (this.unsubscribe !== null) {
      return;
    }

    this.unsubscribe = this.controller.subscribe(() => {
      this.schedulePersistedSnapshotWrite();
    });
    if (this.externalStateUnsubscribe === null) {
      const source = this.input.externalStateSource;
      const canReadSnapshotNodeState =
        typeof source?.getSnapshotNodeState === "function";
      if (!canReadSnapshotNodeState) {
        return;
      }
      this.externalStateUnsubscribe =
        source?.subscribe?.(() => {
          this.schedulePersistedSnapshotWrite();
        }) ?? null;
    }
  }

  private disposeNodeLeases(): void {
    for (const lease of this.nodeLeases.values()) {
      lease.release();
    }
    this.nodeLeases.clear();
  }

  private applyExternalSnapshotNodeState(
    state: Pick<WorkbenchState<WorkbenchHostNodeData>, "nodeStack" | "nodes">
  ): Pick<WorkbenchState<WorkbenchHostNodeData>, "nodeStack" | "nodes"> {
    const source = this.input.externalStateSource;
    const getSnapshotNodeState = source?.getSnapshotNodeState?.bind(source);
    if (!getSnapshotNodeState) {
      return state;
    }

    return {
      ...state,
      nodes: state.nodes.map((node) => {
        const lookupInput = {
          instanceId: node.data.instanceId,
          instanceKey: node.data.instanceKey ?? null,
          nodeId: node.id,
          typeId: node.data.typeId,
          workspaceId: this.input.workspaceId,
          ...(node.data.projectionSubject
            ? { subject: node.data.projectionSubject }
            : {})
        };
        const snapshotNodeState = getSnapshotNodeState(lookupInput);
        const nextSnapshotNodeState =
          snapshotNodeState ?? node.data.snapshotNodeState;
        if (nextSnapshotNodeState === undefined) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            snapshotNodeState: nextSnapshotNodeState
          }
        };
      })
    };
  }

  private reconcileNodeLeases(): void {
    const activeNodes = this.controller.getSnapshot().nodes;
    const nextNodeIDs = new Set(activeNodes.map((node) => node.id));

    for (const [nodeID, lease] of this.nodeLeases) {
      if (nextNodeIDs.has(nodeID)) {
        continue;
      }
      lease.release();
      this.nodeLeases.delete(nodeID);
    }

    for (const node of activeNodes) {
      if (this.nodeLeases.has(node.id)) {
        continue;
      }
      const definition = this.nodeDefinitionByType.get(node.data.typeId);
      const lease = definition?.createLease?.({
        node,
        workspaceId: this.input.workspaceId
      });
      if (lease) {
        this.nodeLeases.set(node.id, lease);
      }
    }
  }
}

function withoutRuntimeNodeState(
  data: WorkbenchHostNodeData
): WorkbenchHostNodeData {
  const next = { ...data };
  delete next.runtimeNodeState;
  return next;
}

function withoutSnapshotNodeState(
  data: WorkbenchHostNodeData
): WorkbenchHostNodeData {
  const next = { ...data };
  delete next.snapshotNodeState;
  return next;
}

function workbenchSnapshotSaveKey(snapshot: WorkbenchSnapshot): string {
  return JSON.stringify(snapshot);
}

function resolveWorkbenchHostLaunchSource(
  input: WorkbenchHostLaunchInput
): string | null {
  if (input.launchSource?.trim()) {
    return input.launchSource.trim();
  }
  switch (input.reason) {
    case "dock":
      return "dock";
    case "launchpad":
      return "launchpad";
    case "shortcut":
      return "keyboard";
    case "command":
      return "command";
    case "host":
      return null;
  }
}

function diagnosticErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: limitLaunchDiagnosticText(error.message),
      name: error.name,
      stack: limitLaunchDiagnosticText(error.stack)
    };
  }
  return {
    message: diagnosticValueSummary(error),
    name: typeof error
  };
}

function diagnosticValueSummary(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return limitLaunchDiagnosticText(value) ?? "";
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return limitLaunchDiagnosticText(JSON.stringify(value)) ?? null;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function limitLaunchDiagnosticText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > launchDiagnosticTextMaxLength
    ? `${trimmed.slice(0, launchDiagnosticTextMaxLength)}...`
    : trimmed;
}

function noop(): void {}
