package daemon

import "time"

type InstallationState string

const (
	InstallationStateNotInstalled InstallationState = "not_installed"
	InstallationStateInstalling   InstallationState = "installing"
	InstallationStateInstalled    InstallationState = "installed"
	InstallationStateUpdating     InstallationState = "updating"
	InstallationStateUninstalling InstallationState = "uninstalling"
	InstallationStateFailed       InstallationState = "failed"
)

type AuthorizationState string

const (
	AuthorizationStateNotRequired  AuthorizationState = "not_required"
	AuthorizationStateDisconnected AuthorizationState = "disconnected"
	AuthorizationStatePending      AuthorizationState = "pending"
	AuthorizationStateConnected    AuthorizationState = "connected"
	AuthorizationStateExpired      AuthorizationState = "expired"
	AuthorizationStateFailed       AuthorizationState = "failed"
)

type CompatibilityState string

const (
	CompatibilityStateSupported                 CompatibilityState = "supported"
	CompatibilityStateUnsupportedProduct        CompatibilityState = "unsupported_product"
	CompatibilityStateUnsupportedPlatform       CompatibilityState = "unsupported_platform"
	CompatibilityStateUnsupportedVersion        CompatibilityState = "unsupported_version"
	CompatibilityStateUnsupportedImplementation CompatibilityState = "unsupported_implementation"
)

type CatalogState string

const (
	CatalogStateReady      CatalogState = "ready"
	CatalogStateRefreshing CatalogState = "refreshing"
	CatalogStateStale      CatalogState = "stale"
	CatalogStateFailed     CatalogState = "failed"
)

type ReleaseStatus string

const (
	ReleaseStatusAvailable  ReleaseStatus = "available"
	ReleaseStatusSuperseded ReleaseStatus = "superseded"
)

type OperationKind string

const (
	OperationKindRefreshCatalog          OperationKind = "refresh_catalog"
	OperationKindInstall                 OperationKind = "install"
	OperationKindUninstall               OperationKind = "uninstall"
	OperationKindStartAuthorization      OperationKind = "start_authorization"
	OperationKindSetWorkspaceEnabled     OperationKind = "set_workspace_enabled"
	OperationKindDisconnectAuthorization OperationKind = "disconnect_authorization"
)

type OperationState string

const (
	OperationStateAccepted  OperationState = "accepted"
	OperationStateRunning   OperationState = "running"
	OperationStateCompleted OperationState = "completed"
	OperationStateFailed    OperationState = "failed"
)

type OperationStage string

const (
	OperationStageAccepted      OperationStage = "accepted"
	OperationStageRefreshing    OperationStage = "refreshing"
	OperationStageDownloading   OperationStage = "downloading"
	OperationStagePrepared      OperationStage = "prepared"
	OperationStageActivating    OperationStage = "activating"
	OperationStageDeactivating  OperationStage = "deactivating"
	OperationStageAuthorizing   OperationStage = "authorizing"
	OperationStageDisconnecting OperationStage = "disconnecting"
	OperationStageCompleted     OperationStage = "completed"
	OperationStageFailed        OperationStage = "failed"
)

// Release is the immutable catalog fact selected for an install operation.
// Hosts map their generated remote-market DTOs into this host-neutral shape.
type Release struct {
	SchemaVersion  string        `json:"schemaVersion"`
	ReleaseID      string        `json:"releaseId"`
	ConnectorKey   string        `json:"connectorKey"`
	Version        string        `json:"version"`
	ReleaseDigest  string        `json:"releaseDigest"`
	ManifestDigest string        `json:"manifestDigest"`
	Manifest       Manifest      `json:"manifest"`
	Artifact       Artifact      `json:"artifact"`
	PublishedAt    time.Time     `json:"publishedAt"`
	Status         ReleaseStatus `json:"status"`
}

type Manifest struct {
	SchemaVersion     string                    `json:"schemaVersion"`
	DisplayName       string                    `json:"displayName"`
	Description       string                    `json:"description,omitempty"`
	Permissions       []string                  `json:"permissions"`
	Implementation    Implementation            `json:"implementation"`
	AuthorizationKind string                    `json:"authorizationKind"`
	Compatibility     CompatibilityRequirements `json:"compatibility,omitempty"`
}

type Artifact struct {
	Key       string `json:"key"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	MediaType string `json:"mediaType"`
}

type CompatibilityRequirements struct {
	Products           []string `json:"products,omitempty"`
	Platforms          []string `json:"platforms,omitempty"`
	MinimumHostVersion string   `json:"minimumHostVersion,omitempty"`
}

type Implementation struct {
	Kind                 string                              `json:"kind"`
	Builtin              *BuiltinImplementation              `json:"builtin,omitempty"`
	ManagedStdio         *ManagedStdioImplementation         `json:"managedStdio,omitempty"`
	RemoteStreamableHTTP *RemoteStreamableHTTPImplementation `json:"remoteStreamableHttp,omitempty"`
}

type BuiltinImplementation struct {
	ProviderID string `json:"providerId"`
	MCP        bool   `json:"mcp"`
	CLI        bool   `json:"cli"`
}

type RuntimeRequirement struct {
	Language string `json:"language"`
	Profile  string `json:"profile"`
	ABI      string `json:"abi"`
}

type ManagedStdioImplementation struct {
	Runtime                  RuntimeRequirement   `json:"runtime"`
	MCP                      *ManagedMCPInterface `json:"mcp,omitempty"`
	CLI                      *ManagedCLIInterface `json:"cli,omitempty"`
	CredentialBrokerProtocol string               `json:"credentialBrokerProtocol,omitempty"`
}

type ManagedMCPInterface struct {
	Entrypoint string   `json:"entrypoint"`
	Arguments  []string `json:"arguments,omitempty"`
}

type ManagedCLIInterface struct {
	Entrypoint string       `json:"entrypoint"`
	Arguments  []string     `json:"arguments,omitempty"`
	Commands   []CLICommand `json:"commands"`
}

type CLICommand struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Arguments   []string       `json:"arguments,omitempty"`
	InputSchema map[string]any `json:"inputSchema"`
	TimeoutMS   int            `json:"timeoutMs"`
}

type RemoteStreamableHTTPImplementation struct {
	Endpoint     string   `json:"endpoint"`
	AllowedHosts []string `json:"allowedHosts"`
}

type Installation struct {
	State                  InstallationState `json:"state"`
	InstalledVersion       string            `json:"installedVersion,omitempty"`
	InstalledReleaseID     string            `json:"installedReleaseId,omitempty"`
	InstalledReleaseDigest string            `json:"installedReleaseDigest,omitempty"`
	FailureCode            string            `json:"failureCode,omitempty"`
}

type Authorization struct {
	State       AuthorizationState `json:"state"`
	FailureCode string             `json:"failureCode,omitempty"`
}

type Compatibility struct {
	State  CompatibilityState `json:"state"`
	Reason string             `json:"reason,omitempty"`
}

type WorkspaceBinding struct {
	WorkspaceID string `json:"workspaceId"`
	Enabled     bool   `json:"enabled"`
}

type Connector struct {
	Key              string            `json:"key"`
	Release          Release           `json:"release"`
	Installation     Installation      `json:"installation"`
	Authorization    Authorization     `json:"authorization"`
	Compatibility    Compatibility     `json:"compatibility"`
	WorkspaceBinding *WorkspaceBinding `json:"workspaceBinding,omitempty"`
	Revision         uint64            `json:"revision"`
}

type Operation struct {
	OperationID      string             `json:"operationId"`
	ClientRequestID  string             `json:"clientRequestId"`
	ConnectorKey     string             `json:"connectorKey,omitempty"`
	Kind             OperationKind      `json:"kind"`
	State            OperationState     `json:"state"`
	Stage            OperationStage     `json:"stage,omitempty"`
	Target           *OperationTarget   `json:"target,omitempty"`
	WorkspaceID      string             `json:"workspaceId,omitempty"`
	WorkspaceEnabled *bool              `json:"workspaceEnabled,omitempty"`
	HostGeneration   HostGeneration     `json:"hostGeneration,omitempty"`
	Execution        OperationExecution `json:"execution,omitempty"`
	Attempt          uint32             `json:"attempt"`
	LeaseOwner       string             `json:"leaseOwner,omitempty"`
	LeaseToken       uint64             `json:"leaseToken,omitempty"`
	LeaseExpiresAt   *time.Time         `json:"leaseExpiresAt,omitempty"`
	FailureCode      string             `json:"failureCode,omitempty"`
	CreatedAt        time.Time          `json:"createdAt"`
	UpdatedAt        time.Time          `json:"updatedAt"`
}

// OperationTarget freezes the exact release identity at command acceptance so
// a concurrent catalog refresh cannot change what an operation installs.
type OperationTarget struct {
	ConnectorKey   string   `json:"connectorKey"`
	Version        string   `json:"version"`
	ReleaseID      string   `json:"releaseId"`
	ReleaseDigest  string   `json:"releaseDigest"`
	ArtifactSHA256 string   `json:"artifactSha256,omitempty"`
	Release        *Release `json:"release,omitempty"`
}

type OperationExecution struct {
	PreparedArtifact     *PreparedArtifactReceipt  `json:"preparedArtifact,omitempty"`
	RuntimeActivation    *RuntimeActivationReceipt `json:"runtimeActivation,omitempty"`
	AuthorizationSession *AuthorizationSession     `json:"authorizationSession,omitempty"`
}

type PreparedArtifactReceipt struct {
	OperationID     string `json:"operationId"`
	ConnectorKey    string `json:"connectorKey"`
	Version         string `json:"version"`
	ReleaseDigest   string `json:"releaseDigest"`
	ArtifactSHA256  string `json:"artifactSha256"`
	InventoryDigest string `json:"inventoryDigest"`
	PreparedPath    string `json:"preparedPath"`
}

type RuntimeActivationReceipt struct {
	OperationID   string `json:"operationId"`
	ConnectorKey  string `json:"connectorKey"`
	ReleaseDigest string `json:"releaseDigest"`
	RuntimeID     string `json:"runtimeId,omitempty"`
}

// HostGeneration fences every MCP/CLI route and child process. BootEpoch
// changes on daemon restart and Generation changes on reconcile or workspace
// deactivation.
type HostGeneration struct {
	BootEpoch  string `json:"bootEpoch"`
	Generation uint64 `json:"generation"`
}

type WorkspaceRuntimeReceipt struct {
	OperationID   string         `json:"operationId"`
	WorkspaceID   string         `json:"workspaceId"`
	ConnectorKey  string         `json:"connectorKey"`
	ReleaseDigest string         `json:"releaseDigest"`
	Generation    HostGeneration `json:"generation"`
	RouteIDs      []string       `json:"routeIds,omitempty"`
}

type AuthorizationSession struct {
	OperationID      string `json:"operationId"`
	ConnectorKey     string `json:"connectorKey"`
	SessionID        string `json:"sessionId"`
	AuthorizationURL string `json:"-"`
}

type Snapshot struct {
	CatalogState   CatalogState `json:"catalogState"`
	Connectors     []Connector  `json:"connectors"`
	Operations     []Operation  `json:"operations"`
	Revision       uint64       `json:"revision"`
	SourceRevision string       `json:"sourceRevision,omitempty"`
}

type Mutation struct {
	ClientRequestID  string `json:"clientRequestId"`
	ExpectedRevision uint64 `json:"expectedRevision"`
}

type ConnectorMutation struct {
	Mutation
	ConnectorKey string `json:"connectorKey"`
	WorkspaceID  string `json:"workspaceId,omitempty"`
}

type SetWorkspaceEnabledCommand struct {
	ConnectorMutation
	WorkspaceID string `json:"workspaceId"`
	Enabled     bool   `json:"enabled"`
}

type MutationResult struct {
	Connector *Connector `json:"connector,omitempty"`
	Operation Operation  `json:"operation"`
	Revision  uint64     `json:"revision"`
}

type AuthorizationResult struct {
	Connector        Connector `json:"connector"`
	Operation        Operation `json:"operation"`
	AuthorizationURL string    `json:"authorizationUrl,omitempty"`
	Revision         uint64    `json:"revision"`
}

type WorkspaceBindingResult struct {
	Connector Connector `json:"connector"`
	Operation Operation `json:"operation"`
	Revision  uint64    `json:"revision"`
}
