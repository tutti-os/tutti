export {
  createWorkbenchHostSessionConfiguration,
  WorkbenchHostCoordinator,
  type WorkbenchHostCoordinatorOptions,
  type WorkbenchHostSessionConfiguration,
  type WorkbenchHostSessionLease,
  type WorkbenchHostSessionOpenInput
} from "./coordinator/workbenchHostCoordinator.ts";
export {
  resolveWorkbenchCapabilityRegistry,
  type WorkbenchCapabilityFactoryDescriptor,
  type WorkbenchCapabilityRegistryInput,
  type WorkbenchCapabilityRegistryResult
} from "./capabilities/workbenchCapabilityRegistry.ts";
export type {
  WorkbenchDiagnosticsPort,
  WorkbenchHostDiagnosticEvent
} from "./diagnostics/workbenchDiagnosticsPort.ts";
export {
  areWorkbenchSnapshotPartitionsEqual,
  WorkbenchHostSession,
  type WorkbenchAuthenticatedPrincipalSnapshot,
  type WorkbenchHostSessionOptions,
  type WorkbenchHostSessionResolution,
  type WorkbenchScope,
  type WorkbenchSnapshotPartition
} from "./session/workbenchHostSession.ts";
