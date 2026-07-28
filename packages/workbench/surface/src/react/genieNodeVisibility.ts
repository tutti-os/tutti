export interface WorkbenchGenieNodeVisibility {
  getHiddenNodeIDsSnapshot(): ReadonlySet<string>;
  getSnapshot(nodeID: string): boolean;
  subscribeAll(listener: () => void): () => void;
  subscribe(nodeID: string, listener: () => void): () => void;
}

export interface WorkbenchGenieNodeVisibilityStore extends WorkbenchGenieNodeVisibility {
  dispose(): void;
  hide(nodeID: string): WorkbenchGenieNodeVisibilityToken;
  show(nodeID: string, token?: WorkbenchGenieNodeVisibilityToken): boolean;
  setHidden(nodeID: string, hidden: boolean): void;
}

export type WorkbenchGenieNodeVisibilityToken = symbol;

export function createWorkbenchGenieNodeVisibilityStore(): WorkbenchGenieNodeVisibilityStore {
  let hiddenNodeIDs: ReadonlySet<string> = new Set();
  const hiddenTokenByNodeID = new Map<
    string,
    WorkbenchGenieNodeVisibilityToken
  >();
  const listenersByNodeID = new Map<string, Set<() => void>>();
  const allListeners = new Set<() => void>();

  const setHidden = (nodeID: string, hidden: boolean): void => {
    if (hiddenNodeIDs.has(nodeID) === hidden) {
      return;
    }
    const nextHiddenNodeIDs = new Set(hiddenNodeIDs);
    if (hidden) {
      nextHiddenNodeIDs.add(nodeID);
    } else {
      nextHiddenNodeIDs.delete(nodeID);
    }
    hiddenNodeIDs = nextHiddenNodeIDs;
    for (const listener of listenersByNodeID.get(nodeID) ?? []) {
      listener();
    }
    for (const listener of allListeners) {
      listener();
    }
  };
  const hide = (nodeID: string): WorkbenchGenieNodeVisibilityToken => {
    const token = Symbol(nodeID);
    hiddenTokenByNodeID.set(nodeID, token);
    setHidden(nodeID, true);
    return token;
  };
  const show = (
    nodeID: string,
    token?: WorkbenchGenieNodeVisibilityToken
  ): boolean => {
    if (token && hiddenTokenByNodeID.get(nodeID) !== token) {
      return false;
    }
    hiddenTokenByNodeID.delete(nodeID);
    setHidden(nodeID, false);
    return true;
  };

  return {
    dispose() {
      hiddenNodeIDs = new Set();
      hiddenTokenByNodeID.clear();
      listenersByNodeID.clear();
      allListeners.clear();
    },
    getHiddenNodeIDsSnapshot() {
      return hiddenNodeIDs;
    },
    getSnapshot(nodeID) {
      return hiddenNodeIDs.has(nodeID);
    },
    hide,
    setHidden(nodeID, hidden) {
      if (hidden) {
        hide(nodeID);
      } else {
        show(nodeID);
      }
    },
    subscribeAll(listener) {
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
      };
    },
    show,
    subscribe(nodeID, listener) {
      const listeners = listenersByNodeID.get(nodeID) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByNodeID.set(nodeID, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByNodeID.delete(nodeID);
        }
      };
    }
  };
}
