export type WorkbenchNodePresentationTransition =
  | "frame"
  | "onboarding-entry"
  | "scale-restore";

export interface WorkbenchNodePresentationTransitionStore {
  clearNode(nodeID: string): void;
  dispose(): void;
  getSnapshot(): ReadonlySet<string>;
  setActive(
    nodeID: string,
    transition: WorkbenchNodePresentationTransition,
    active: boolean
  ): void;
  subscribe(listener: () => void): () => void;
}

export function createWorkbenchNodePresentationTransitionStore(): WorkbenchNodePresentationTransitionStore {
  let activeNodeIDs: ReadonlySet<string> = new Set();
  const activeTransitionsByNodeID = new Map<
    string,
    Set<WorkbenchNodePresentationTransition>
  >();
  const listeners = new Set<() => void>();

  const publish = (nodeID: string, active: boolean): void => {
    if (activeNodeIDs.has(nodeID) === active) {
      return;
    }
    const nextActiveNodeIDs = new Set(activeNodeIDs);
    if (active) {
      nextActiveNodeIDs.add(nodeID);
    } else {
      nextActiveNodeIDs.delete(nodeID);
    }
    activeNodeIDs = nextActiveNodeIDs;
    for (const listener of listeners) {
      listener();
    }
  };

  const clearNode = (nodeID: string): void => {
    if (!activeTransitionsByNodeID.delete(nodeID)) {
      return;
    }
    publish(nodeID, false);
  };

  return {
    clearNode,
    dispose() {
      activeNodeIDs = new Set();
      activeTransitionsByNodeID.clear();
      listeners.clear();
    },
    getSnapshot() {
      return activeNodeIDs;
    },
    setActive(nodeID, transition, active) {
      const activeTransitions =
        activeTransitionsByNodeID.get(nodeID) ??
        new Set<WorkbenchNodePresentationTransition>();
      if (active) {
        if (activeTransitions.has(transition)) {
          return;
        }
        activeTransitions.add(transition);
        activeTransitionsByNodeID.set(nodeID, activeTransitions);
        publish(nodeID, true);
        return;
      }
      if (!activeTransitions.delete(transition)) {
        return;
      }
      if (activeTransitions.size > 0) {
        return;
      }
      activeTransitionsByNodeID.delete(nodeID);
      publish(nodeID, false);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
