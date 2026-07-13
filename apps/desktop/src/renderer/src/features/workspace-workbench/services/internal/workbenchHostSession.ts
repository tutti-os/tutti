import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type { WorkbenchDiagnosticsPort } from "./workbenchHostPorts.ts";

export interface WorkbenchScope {
  readonly id: string;
  readonly kind: "room" | "workspace";
}

export interface WorkbenchAuthenticatedPrincipalSnapshot {
  readonly id: string;
}

export interface WorkbenchSnapshotPartition {
  readonly principal?: WorkbenchAuthenticatedPrincipalSnapshot;
  readonly scope: WorkbenchScope;
}

export interface WorkbenchHostSessionResolution<THostInput, TState> {
  readonly hostInput: THostInput;
  readonly state: TState;
}

export interface WorkbenchHostSessionOptions<TUpdate, THostInput, TState> {
  readonly diagnostics?: WorkbenchDiagnosticsPort;
  readonly partition: WorkbenchSnapshotPartition;
  readonly resolve: (
    update: TUpdate,
    current: WorkbenchHostSessionResolution<THostInput, TState> | null
  ) => WorkbenchHostSessionResolution<THostInput, TState>;
}

export class WorkbenchHostSession<TUpdate, THostInput, TState> {
  readonly partition: WorkbenchSnapshotPartition;
  private current: WorkbenchHostSessionResolution<THostInput, TState> | null =
    null;
  private disposed = false;
  private readonly disposalCallbacks: Array<() => void> = [];
  private readonly diagnostics?: WorkbenchDiagnosticsPort;
  private readonly listeners = new Set<() => void>();
  private readonly resolve: WorkbenchHostSessionOptions<
    TUpdate,
    THostInput,
    TState
  >["resolve"];
  private surfaceHandle: WorkbenchHostHandle | null = null;
  private surfaceOwner: object | null = null;

  constructor(
    options: WorkbenchHostSessionOptions<TUpdate, THostInput, TState>
  ) {
    this.partition = freezeWorkbenchSnapshotPartition(options.partition);
    this.diagnostics = options.diagnostics;
    this.resolve = options.resolve;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  attachSurface(handle: WorkbenchHostHandle | null, owner: object): void {
    this.assertActive();
    if (handle === null) {
      if (this.surfaceOwner === owner) {
        this.surfaceHandle = null;
        this.surfaceOwner = null;
      }
      return;
    }
    this.surfaceHandle = handle;
    this.surfaceOwner = owner;
  }

  getAttachedSurface(): WorkbenchHostHandle | null {
    return this.surfaceHandle;
  }

  getHostInput(): THostInput {
    this.assertActive();
    if (!this.current) {
      throw new Error("Workbench host session has not received an update.");
    }
    return this.current.hostInput;
  }

  registerDisposable(dispose: () => void): () => void {
    this.assertActive();
    let registered = true;
    this.disposalCallbacks.push(dispose);
    return () => {
      if (!registered || this.disposed) {
        return;
      }
      registered = false;
      const index = this.disposalCallbacks.indexOf(dispose);
      if (index >= 0) {
        this.disposalCallbacks.splice(index, 1);
      }
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) {
      return noop;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(update: TUpdate): THostInput {
    this.assertActive();
    const hadCurrent = this.current !== null;
    const previousHostInput = this.current?.hostInput;
    const next = this.resolve(update, this.current);
    this.current = next;
    if (!hadCurrent || previousHostInput !== next.hostInput) {
      for (const listener of Array.from(this.listeners)) {
        listener();
      }
    }
    return next.hostInput;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.surfaceHandle = null;
    this.surfaceOwner = null;
    this.listeners.clear();
    const disposalCallbacks = this.disposalCallbacks.splice(0);
    this.disposalCallbacks.length = 0;
    this.current = null;
    for (let index = disposalCallbacks.length - 1; index >= 0; index -= 1) {
      try {
        disposalCallbacks[index]?.();
      } catch (error) {
        this.reportDisposalError(error);
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Workbench host session is disposed.");
    }
  }

  private reportDisposalError(error: unknown): void {
    try {
      const result = this.diagnostics?.report({
        error,
        event: "workbench.host.session.dispose_failed"
      });
      void result?.catch(() => undefined);
    } catch {
      // Disposal must continue even when diagnostics fail.
    }
  }
}

export function areWorkbenchSnapshotPartitionsEqual(
  left: WorkbenchSnapshotPartition,
  right: WorkbenchSnapshotPartition
): boolean {
  return (
    left.scope.kind === right.scope.kind &&
    left.scope.id === right.scope.id &&
    left.principal?.id === right.principal?.id
  );
}

export function createWorkbenchScopeKey(scope: WorkbenchScope): string {
  return `${scope.kind.length}:${scope.kind}${scope.id.length}:${scope.id}`;
}

function freezeWorkbenchSnapshotPartition(
  partition: WorkbenchSnapshotPartition
): WorkbenchSnapshotPartition {
  return Object.freeze({
    ...(partition.principal
      ? { principal: Object.freeze({ id: partition.principal.id }) }
      : {}),
    scope: Object.freeze({
      id: partition.scope.id,
      kind: partition.scope.kind
    })
  });
}

function noop(): void {}
