import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeData
} from "./types.ts";

export interface WorkbenchHostExternalState {
  externalNodeState: unknown;
  externalWorkspaceState: unknown;
}

const noopSubscribe = () => () => {};

function useCachedExternalSnapshot<T>(input: {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
}): T {
  const cacheRef = useRef<{ hasValue: boolean; value: T | null }>({
    hasValue: false,
    value: null
  });
  const getSnapshot = useCallback(() => {
    if (!cacheRef.current.hasValue) {
      cacheRef.current = {
        hasValue: true,
        value: input.getSnapshot()
      };
    }
    return cacheRef.current.value as T;
  }, [input.getSnapshot]);
  const subscribe = useCallback(
    (listener: () => void) =>
      input.subscribe(() => {
        cacheRef.current.hasValue = false;
        listener();
      }),
    [input.subscribe]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function createWorkbenchHostExternalStateLookupInput(input: {
  node: WorkbenchNode<WorkbenchHostNodeData>;
  workspaceId: string;
}): WorkbenchHostExternalStateLookupInput {
  return {
    instanceId: input.node.data.instanceId,
    instanceKey: input.node.data.instanceKey ?? null,
    nodeId: input.node.id,
    typeId: input.node.data.typeId,
    workspaceId: input.workspaceId,
    ...(input.node.data.projectionSubject
      ? { subject: input.node.data.projectionSubject }
      : {})
  };
}

/**
 * Binds a node renderer to only the external state it consumes. The source
 * contract requires stable snapshots, so unrelated source changes do not
 * invalidate the surrounding Workbench host.
 */
export function useWorkbenchHostExternalState(input: {
  externalStateSource?: WorkbenchHostExternalStateSource;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  workspaceId: string;
}): WorkbenchHostExternalState {
  const lookupInput = useMemo(
    () =>
      createWorkbenchHostExternalStateLookupInput({
        node: input.node,
        workspaceId: input.workspaceId
      }),
    [input.node, input.workspaceId]
  );
  const workspaceInput = useMemo(
    () => ({ workspaceId: input.workspaceId }),
    [input.workspaceId]
  );
  const subscribeNodeState = useCallback(
    (listener: () => void) =>
      input.externalStateSource?.subscribeNodeState?.(lookupInput, listener) ??
      noopSubscribe(),
    [input.externalStateSource, lookupInput]
  );
  const getNodeState = useCallback(
    () =>
      input.externalStateSource?.getNodeState(lookupInput) ??
      input.node.data.snapshotNodeState ??
      null,
    [input.externalStateSource, input.node.data.snapshotNodeState, lookupInput]
  );
  const subscribeWorkspaceState = useCallback(
    (listener: () => void) =>
      input.externalStateSource?.subscribeWorkspaceState?.(
        workspaceInput,
        listener
      ) ?? noopSubscribe(),
    [input.externalStateSource, workspaceInput]
  );
  const getWorkspaceState = useCallback(
    () => input.externalStateSource?.getWorkspaceState(workspaceInput) ?? null,
    [input.externalStateSource, workspaceInput]
  );

  return {
    externalNodeState: useCachedExternalSnapshot({
      getSnapshot: getNodeState,
      subscribe: subscribeNodeState
    }),
    externalWorkspaceState: useCachedExternalSnapshot({
      getSnapshot: getWorkspaceState,
      subscribe: subscribeWorkspaceState
    })
  };
}

export function readWorkbenchHostExternalState(input: {
  externalStateSource?: WorkbenchHostExternalStateSource;
  node: WorkbenchNode<WorkbenchHostNodeData>;
  workspaceId: string;
}): WorkbenchHostExternalState {
  if (!input.externalStateSource) {
    return {
      externalNodeState: null,
      externalWorkspaceState: null
    };
  }

  const nodeStateInput = createWorkbenchHostExternalStateLookupInput(input);

  const sourceNodeState =
    input.externalStateSource.getNodeState(nodeStateInput);

  return {
    externalNodeState:
      sourceNodeState ?? input.node.data.snapshotNodeState ?? null,
    externalWorkspaceState: input.externalStateSource.getWorkspaceState({
      workspaceId: input.workspaceId
    })
  };
}
