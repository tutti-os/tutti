import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";

export interface WorkbenchSnapshotRepositoryPort {
  hasLoaded?(scopeId: string): boolean;
  load(scopeId: string): Promise<WorkbenchSnapshot | null>;
  readCached?(scopeId: string): WorkbenchSnapshot | null;
  save(
    scopeId: string,
    snapshot: WorkbenchSnapshot
  ): Promise<WorkbenchSnapshot> | WorkbenchSnapshot;
  subscribe?(listener: () => void): () => void;
}

export type WorkbenchHostDiagnosticEvent =
  | "workbench.host.coordinator.dispose_failed"
  | "workbench.host.session.dispose_failed";

export interface WorkbenchDiagnosticsPort {
  report(input: {
    readonly error: unknown;
    readonly event: WorkbenchHostDiagnosticEvent;
  }): Promise<void> | void;
}
