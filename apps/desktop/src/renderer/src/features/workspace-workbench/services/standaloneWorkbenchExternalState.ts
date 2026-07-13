export interface StandaloneWorkbenchExternalStateSubscriber {
  subscribe?(listener: () => void): () => void;
}

export interface StandaloneWorkbenchExternalStateRevisionStore {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

/**
 * Adapts a workbench external-state source to a cached primitive snapshot.
 *
 * External-state sources are allowed to materialize a fresh object from
 * `getNodeState()` on every read. Passing that object directly to
 * `useSyncExternalStore` violates React's cached-snapshot contract and can
 * recurse until React reports a maximum update depth. A monotonically
 * increasing revision gives React a stable subscription snapshot while
 * callers read the latest node/workspace state during the resulting render.
 */
export function createStandaloneWorkbenchExternalStateRevisionStore(
  source: StandaloneWorkbenchExternalStateSubscriber | undefined
): StandaloneWorkbenchExternalStateRevisionStore {
  let revision = 0;

  return {
    getSnapshot() {
      return revision;
    },
    subscribe(listener) {
      return (
        source?.subscribe?.(() => {
          revision += 1;
          listener();
        }) ?? noop
      );
    }
  };
}

function noop(): void {}
