export type WorkspaceWindowLifecycleEvent =
  | { kind: "opened"; occurredAt: number }
  | { kind: "focused"; occurredAt: number }
  | { kind: "blurred"; occurredAt: number }
  | {
      kind: "visibility_changed";
      occurredAt: number;
      visibility: DocumentVisibilityState;
    };

export interface WorkspaceWindowLifecycleSnapshot {
  focused: boolean;
  visibility: DocumentVisibilityState;
}

export interface WorkspaceWindowLifecycle {
  getSnapshot(): WorkspaceWindowLifecycleSnapshot;
  subscribe(
    listener: (event: WorkspaceWindowLifecycleEvent) => void
  ): () => void;
}

export interface WorkspaceWindowLifecycleController extends WorkspaceWindowLifecycle {
  dispose(): void;
  start(): void;
}

export interface WorkspaceWindowLifecycleRuntime {
  addDocumentListener(
    type: "visibilitychange",
    listener: () => void
  ): () => void;
  addWindowListener(type: "blur" | "focus", listener: () => void): () => void;
  hasFocus(): boolean;
  now(): number;
  visibilityState(): DocumentVisibilityState;
}

export function createWorkspaceWindowLifecycle(
  runtime: WorkspaceWindowLifecycleRuntime = createBrowserRuntime()
): WorkspaceWindowLifecycleController {
  const listeners = new Set<(event: WorkspaceWindowLifecycleEvent) => void>();
  const runtimeDisposables: Array<() => void> = [];
  let disposed = false;
  let started = false;
  let snapshot: WorkspaceWindowLifecycleSnapshot = {
    focused: runtime.hasFocus(),
    visibility: runtime.visibilityState()
  };

  const emit = (event: WorkspaceWindowLifecycleEvent): void => {
    if (disposed) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const disposeRuntimeListener of runtimeDisposables.splice(0)) {
        disposeRuntimeListener();
      }
      listeners.clear();
    },
    getSnapshot() {
      return snapshot;
    },
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      snapshot = {
        focused: runtime.hasFocus(),
        visibility: runtime.visibilityState()
      };
      runtimeDisposables.push(
        runtime.addWindowListener("focus", () => {
          snapshot = { ...snapshot, focused: true };
          emit({ kind: "focused", occurredAt: runtime.now() });
        }),
        runtime.addWindowListener("blur", () => {
          snapshot = { ...snapshot, focused: false };
          emit({ kind: "blurred", occurredAt: runtime.now() });
        }),
        runtime.addDocumentListener("visibilitychange", () => {
          const visibility = runtime.visibilityState();
          snapshot = { ...snapshot, visibility };
          emit({
            kind: "visibility_changed",
            occurredAt: runtime.now(),
            visibility
          });
        })
      );
      emit({ kind: "opened", occurredAt: runtime.now() });
    },
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function createBrowserRuntime(): WorkspaceWindowLifecycleRuntime {
  return {
    addDocumentListener(type, listener) {
      document.addEventListener(type, listener);
      return () => {
        document.removeEventListener(type, listener);
      };
    },
    addWindowListener(type, listener) {
      window.addEventListener(type, listener);
      return () => {
        window.removeEventListener(type, listener);
      };
    },
    hasFocus: () => document.hasFocus(),
    now: () => Date.now(),
    visibilityState: () => document.visibilityState
  };
}
