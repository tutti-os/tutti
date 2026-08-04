export type ConnectorInstallationState =
  | "not_installed"
  | "installing"
  | "installed"
  | "updating"
  | "uninstalling"
  | "failed";

export type ConnectorAuthorizationState =
  | "not_required"
  | "disconnected"
  | "pending"
  | "connected"
  | "expired"
  | "failed";

export type ConnectorCompatibilityState =
  | "supported"
  | "unsupported_product"
  | "unsupported_platform"
  | "unsupported_version"
  | "unsupported_implementation";

export type ConnectorCatalogState = "ready" | "refreshing" | "stale" | "failed";

export type ConnectorOperationKind =
  | "refresh_catalog"
  | "install"
  | "uninstall"
  | "start_authorization"
  | "set_workspace_enabled"
  | "disconnect_authorization";

export type ConnectorOperationState =
  | "accepted"
  | "running"
  | "completed"
  | "failed";

export interface ConnectorManifestImplementation {
  kind: string;
}

export interface ConnectorManifestArtifact {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface ConnectorCompatibilityRequirements {
  products?: string[];
  platforms?: string[];
  minimumHostVersion?: string;
}

export interface ConnectorManifest {
  schemaVersion: "1";
  key: string;
  version: string;
  displayName: string;
  description?: string;
  permissions: string[];
  artifact: ConnectorManifestArtifact;
  implementation: ConnectorManifestImplementation;
  authorizationKind: string;
  compatibility?: ConnectorCompatibilityRequirements;
}

export interface ConnectorInstallation {
  state: ConnectorInstallationState;
  installedVersion?: string;
  failureCode?: string;
}

export interface ConnectorAuthorization {
  state: ConnectorAuthorizationState;
  failureCode?: string;
}

export interface ConnectorCompatibility {
  state: ConnectorCompatibilityState;
  reason?: string;
}

export interface ConnectorWorkspaceBinding {
  workspaceId: string;
  enabled: boolean;
}

export interface Connector {
  key: string;
  manifest: ConnectorManifest;
  installation: ConnectorInstallation;
  authorization: ConnectorAuthorization;
  compatibility: ConnectorCompatibility;
  workspaceBinding?: ConnectorWorkspaceBinding;
  revision: number;
}

export interface ConnectorOperation {
  operationId: string;
  clientRequestId: string;
  connectorKey?: string;
  kind: ConnectorOperationKind;
  state: ConnectorOperationState;
  stage?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorMarketSnapshot {
  catalogState: ConnectorCatalogState;
  connectors: Connector[];
  operations: ConnectorOperation[];
  revision: number;
  sourceRevision?: string;
}

export interface ConnectorMarketMutationInput {
  clientRequestId: string;
  expectedRevision: number;
}

export interface ConnectorMutationInput extends ConnectorMarketMutationInput {
  connectorKey: string;
}

export interface SetConnectorWorkspaceEnabledInput extends ConnectorMutationInput {
  workspaceId: string;
  enabled: boolean;
}

export interface ConnectorMutationResult {
  connector?: Connector;
  operation: ConnectorOperation;
  revision: number;
}

export interface ConnectorAuthorizationResult {
  connector: Connector;
  operation: ConnectorOperation;
  authorizationUrl?: string;
  revision: number;
}

export interface ConnectorWorkspaceBindingResult {
  connector: Connector;
  operation: ConnectorOperation;
  revision: number;
}

export interface ConnectorMarketChangedEvent {
  type: "connector.market.changed";
  revision: number;
  connectorKey?: string;
  operationId?: string;
}

export interface ConnectorMarketErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}
