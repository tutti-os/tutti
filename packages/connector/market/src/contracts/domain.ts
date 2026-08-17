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
  | "disconnect_authorization";

export type ConnectorOperationState =
  | "accepted"
  | "running"
  | "completed"
  | "failed";

export type ConnectorOperationStage =
  | "accepted"
  | "refreshing"
  | "installing"
  | "installed"
  | "runtime_pending"
  | "deactivating"
  | "removing"
  | "authorizing"
  | "disconnecting"
  | "completed"
  | "failed";

export interface ConnectorBuiltinImplementation {
  providerId: string;
  mcp: boolean;
  cli: boolean;
}

export interface ConnectorRuntimeRequirement {
  language: "node" | "python";
  profile: string;
  abi: string;
}

export interface ConnectorManagedMcpInterface {
  entrypoint: string;
  arguments?: string[];
}

export interface ConnectorManagedCliCommand {
  name: string;
  description?: string;
}

export interface ConnectorManagedCliInterface {
  entrypoint: string;
  arguments?: string[];
  readinessProbe?: {
    arguments: string[];
    timeoutMs: number;
  };
  commands: ConnectorManagedCliCommand[];
}

export interface ConnectorManagedCredentialBroker {
  protocol: "tutti.connector.credentials.v1";
  entrypoint: string;
  timeoutMs: number;
  allowedHosts: string[];
}

export interface ConnectorManagedStdioImplementation {
  runtime: ConnectorRuntimeRequirement;
  mcp?: ConnectorManagedMcpInterface;
  cli?: ConnectorManagedCliInterface;
  credentialBroker?: ConnectorManagedCredentialBroker;
}

export interface ConnectorRemoteStreamableHttpImplementation {
  protocolVersion: "2026-07-28";
  bindingRef: string;
  contractVersion: number;
  bindingContractHash: string;
}

export interface ConnectorManifestImplementation {
  kind: "builtin" | "managed_stdio" | "remote_streamable_http";
  builtin?: ConnectorBuiltinImplementation;
  managedStdio?: ConnectorManagedStdioImplementation;
  remoteStreamableHttp?: ConnectorRemoteStreamableHttpImplementation;
}

export interface ConnectorReleaseArtifact {
  key: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface ConnectorCompatibilityRequirements {
  products?: string[];
  platforms?: string[];
  minimumHostVersion?: string;
}

export interface ConnectorAgentRouting {
  aliases: string[];
}

export interface ConnectorManifest {
  schemaVersion: "1";
  displayName: string;
  iconUrl: string;
  description?: string;
  agentRouting?: ConnectorAgentRouting;
  permissions: string[];
  requiredCapabilities?: string[];
  implementation: ConnectorManifestImplementation;
  authorizationKind: string;
  authorizationInteraction?: unknown;
  authorizationInteractionMode?: "managed";
  compatibility?: ConnectorCompatibilityRequirements;
}

export interface ConnectorRelease {
  schemaVersion: "1";
  releaseId: string;
  connectorKey: string;
  version: string;
  releaseDigest: string;
  manifestDigest: string;
  manifest: ConnectorManifest;
  artifact: ConnectorReleaseArtifact;
  publishedAt: string;
  status: "available" | "superseded";
}

export interface ConnectorInstallation {
  state: ConnectorInstallationState;
  installedVersion?: string;
  installedReleaseId?: string;
  installedReleaseDigest?: string;
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

export interface Connector {
  key: string;
  release: ConnectorRelease;
  installation: ConnectorInstallation;
  authorization: ConnectorAuthorization;
  compatibility: ConnectorCompatibility;
  revision: number;
}

export interface ConnectorOperation {
  operationId: string;
  clientRequestId: string;
  connectorKey?: string;
  kind: ConnectorOperationKind;
  state: ConnectorOperationState;
  stage?: ConnectorOperationStage;
  target?: ConnectorOperationTarget;
  attempt: number;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorOperationTarget {
  connectorKey: string;
  version: string;
  releaseId: string;
  releaseDigest: string;
  artifactSha256?: string;
}

export interface ConnectorMarketSnapshot {
  catalogState: ConnectorCatalogState;
  connectors: Connector[];
  operations: ConnectorOperation[];
  revision: number;
  eventCursor?: number;
  sourceRevision?: string;
}

export type ConnectorMarketCategoryKind = "category" | "featured";

export interface ConnectorMarketCategory {
  categoryId: string;
  kind: ConnectorMarketCategoryKind;
  sortOrder: number;
  itemCount: number;
}

export interface ConnectorMarketCatalogItem {
  categoryId: string;
  featured: boolean;
  connector: Connector;
}

export interface ConnectorMarketCatalogPage {
  sectionId: string;
  items: ConnectorMarketCatalogItem[];
  nextPageToken?: string;
  revision: number;
}

export interface ConnectorMarketMutationInput {
  clientRequestId: string;
  expectedRevision: number;
}

export interface ConnectorMutationInput extends ConnectorMarketMutationInput {
  connectorKey: string;
  expectedConnectorRevision?: number;
}

export interface ConnectorAuthorizationInput extends ConnectorMutationInput {
  replacementPolicy?: "replace_active";
  secret?: string;
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
  authorizationExpiresAt?: string;
  authorizationView?: unknown;
  revision: number;
}

export interface ConnectorMarketChangedEvent {
  type: "connector.market.changed";
  revision: number;
  cursor?: number;
  connectorKey?: string;
  operationId?: string;
}

export interface ConnectorMarketErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}
