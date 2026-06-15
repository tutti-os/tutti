export interface DeferredWorkspaceContainerDispose {
  cancel(): void;
  schedule(): void;
}

export type WorkspaceContainerDisposeHandle =
  | number
  | ReturnType<typeof setTimeout>;

export interface WorkspaceContainerDisposeScheduler {
  clear(handle: WorkspaceContainerDisposeHandle): void;
  set(callback: () => void): WorkspaceContainerDisposeHandle;
}

const defaultScheduler: WorkspaceContainerDisposeScheduler = {
  clear(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  set(callback) {
    return globalThis.setTimeout(callback, 0);
  }
};

export function createDeferredWorkspaceContainerDispose(
  dispose: () => void,
  scheduler: WorkspaceContainerDisposeScheduler = defaultScheduler
): DeferredWorkspaceContainerDispose {
  let pendingHandle: WorkspaceContainerDisposeHandle | null = null;

  return {
    cancel() {
      if (pendingHandle === null) {
        return;
      }
      scheduler.clear(pendingHandle);
      pendingHandle = null;
    },
    schedule() {
      if (pendingHandle !== null) {
        scheduler.clear(pendingHandle);
      }
      pendingHandle = scheduler.set(() => {
        pendingHandle = null;
        dispose();
      });
    }
  };
}
