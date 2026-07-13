import {
  areWorkbenchSnapshotPartitionsEqual,
  createWorkbenchScopeKey,
  WorkbenchHostSession,
  type WorkbenchSnapshotPartition
} from "./workbenchHostSession.ts";
import type { WorkbenchDiagnosticsPort } from "./workbenchHostPorts.ts";

declare const workbenchHostSessionConfigurationBrand: unique symbol;

export interface WorkbenchHostSessionConfiguration<
  TUpdate,
  THostInput,
  TState
> {
  readonly [workbenchHostSessionConfigurationBrand]: {
    readonly hostInput: THostInput;
    readonly state: TState;
    readonly update: TUpdate;
  };
  readonly createSession: (
    partition: WorkbenchSnapshotPartition
  ) => WorkbenchHostSession<TUpdate, THostInput, TState>;
}

export interface WorkbenchHostSessionOpenInput<TUpdate, THostInput, TState> {
  readonly configuration: WorkbenchHostSessionConfiguration<
    TUpdate,
    THostInput,
    TState
  >;
  readonly partition: WorkbenchSnapshotPartition;
}

export interface WorkbenchHostSessionLease<TUpdate, THostInput, TState> {
  readonly release: () => void;
  readonly session: WorkbenchHostSession<TUpdate, THostInput, TState>;
}

interface WorkbenchHostCoordinatorEntry {
  readonly configuration: object;
  leaseCount: number;
  readonly session: WorkbenchHostSession<unknown, unknown, unknown>;
}

export interface WorkbenchHostCoordinatorOptions {
  readonly diagnostics?: WorkbenchDiagnosticsPort;
}

export function createWorkbenchHostSessionConfiguration<
  TUpdate,
  THostInput,
  TState
>(input: {
  readonly createSession: (
    partition: WorkbenchSnapshotPartition
  ) => WorkbenchHostSession<TUpdate, THostInput, TState>;
}): WorkbenchHostSessionConfiguration<TUpdate, THostInput, TState> {
  return input as WorkbenchHostSessionConfiguration<
    TUpdate,
    THostInput,
    TState
  >;
}

export class WorkbenchHostCoordinator {
  readonly _serviceBrand = undefined;
  private disposed = false;
  private readonly options: WorkbenchHostCoordinatorOptions;
  private readonly sessionsByScope = new Map<
    string,
    WorkbenchHostCoordinatorEntry
  >();

  constructor(options: WorkbenchHostCoordinatorOptions = {}) {
    this.options = options;
  }

  open<TUpdate, THostInput, TState>(
    input: WorkbenchHostSessionOpenInput<TUpdate, THostInput, TState>
  ): WorkbenchHostSessionLease<TUpdate, THostInput, TState> {
    this.assertActive();
    const scopeKey = createWorkbenchScopeKey(input.partition.scope);
    let entry = this.sessionsByScope.get(scopeKey);
    if (
      entry &&
      !areWorkbenchSnapshotPartitionsEqual(
        entry.session.partition,
        input.partition
      )
    ) {
      this.sessionsByScope.delete(scopeKey);
      this.disposeSession(entry.session);
      entry = undefined;
    }

    if (entry && entry.configuration !== input.configuration) {
      throw new Error(
        "Workbench host session partition is already owned by another configuration."
      );
    }

    if (!entry || entry.session.isDisposed) {
      const session = input.configuration.createSession(input.partition);
      if (
        !areWorkbenchSnapshotPartitionsEqual(session.partition, input.partition)
      ) {
        this.disposeSession(session);
        throw new Error(
          "Workbench host session partition does not match the open request."
        );
      }
      entry = {
        configuration: input.configuration,
        leaseCount: 0,
        session: session as WorkbenchHostSession<unknown, unknown, unknown>
      };
      this.sessionsByScope.set(scopeKey, entry);
    }

    entry.leaseCount += 1;
    const leasedEntry = entry;
    const session = entry.session as WorkbenchHostSession<
      TUpdate,
      THostInput,
      TState
    >;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.release(scopeKey, leasedEntry);
      },
      session
    };
  }

  get<TUpdate, THostInput, TState>(
    configuration: WorkbenchHostSessionConfiguration<
      TUpdate,
      THostInput,
      TState
    >,
    partition: WorkbenchSnapshotPartition
  ): WorkbenchHostSession<TUpdate, THostInput, TState> | null {
    if (this.disposed) {
      return null;
    }
    const scopeKey = createWorkbenchScopeKey(partition.scope);
    const entry = this.sessionsByScope.get(scopeKey);
    if (!entry) {
      return null;
    }
    if (entry.configuration !== configuration) {
      return null;
    }
    if (entry.session.isDisposed) {
      this.sessionsByScope.delete(scopeKey);
      return null;
    }
    if (
      !areWorkbenchSnapshotPartitionsEqual(entry.session.partition, partition)
    ) {
      return null;
    }
    return entry.session as WorkbenchHostSession<TUpdate, THostInput, TState>;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const entries = Array.from(this.sessionsByScope.values());
    this.sessionsByScope.clear();
    for (const entry of entries) {
      this.disposeSession(entry.session);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Workbench host coordinator is disposed.");
    }
  }

  private release(
    scopeKey: string,
    leasedEntry: WorkbenchHostCoordinatorEntry
  ): void {
    const currentEntry = this.sessionsByScope.get(scopeKey);
    if (currentEntry !== leasedEntry) {
      return;
    }
    leasedEntry.leaseCount -= 1;
    if (leasedEntry.leaseCount > 0) {
      return;
    }
    this.sessionsByScope.delete(scopeKey);
    this.disposeSession(leasedEntry.session);
  }

  private disposeSession<TUpdate, THostInput, TState>(
    session: WorkbenchHostSession<TUpdate, THostInput, TState>
  ): void {
    try {
      session.dispose();
    } catch (error) {
      this.reportDisposalError(error);
    }
  }

  private reportDisposalError(error: unknown): void {
    try {
      const result = this.options.diagnostics?.report({
        error,
        event: "workbench.host.coordinator.dispose_failed"
      });
      void result?.catch(() => undefined);
    } catch {
      // Disposal must continue even when diagnostics fail.
    }
  }
}
