export type WorkbenchHostDiagnosticEvent =
  | "workbench.host.coordinator.dispose_failed"
  | "workbench.host.session.dispose_failed";

export interface WorkbenchDiagnosticsPort {
  report(input: {
    readonly error: unknown;
    readonly event: WorkbenchHostDiagnosticEvent;
  }): Promise<void> | void;
}
