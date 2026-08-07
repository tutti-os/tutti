package host

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
	OperationKindReconcileRuntime        OperationKind = "reconcile_runtime"
	OperationKindStartAuthorization      OperationKind = "start_authorization"
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
	IconURL           string                    `json:"iconUrl"`
	Description       string                    `json:"description,omitempty"`
	AgentRouting      *AgentRouting             `json:"agentRouting,omitempty"`
	Permissions       []string                  `json:"permissions"`
	Implementation    Implementation            `json:"implementation"`
	AuthorizationKind string                    `json:"authorizationKind"`
	Compatibility     CompatibilityRequirements `json:"compatibility,omitempty"`
}

// AgentRouting carries connector-owned brand and product aliases used only to
// select the Connector Broker. Capability intent remains connector-owned and
// is discovered lazily after the connector has been selected.
type AgentRouting struct {
	Aliases []string `json:"aliases"`
}

type Artifact struct {
	Key           string `json:"key"`
	SHA256        string `json:"sha256"`
	SizeBytes     int64  `json:"sizeBytes"`
	MediaType     string `json:"mediaType"`
	ObjectVersion string `json:"objectVersion,omitempty"`
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
	Language     string `json:"language"`
	Profile      string `json:"profile"`
	ABI          string `json:"abi"`
	VersionRange string `json:"versionRange,omitempty"`
}

type ManagedStdioImplementation struct {
	Runtime          RuntimeRequirement       `json:"runtime"`
	MCP              *ManagedMCPInterface     `json:"mcp,omitempty"`
	CLI              *ManagedCLIInterface     `json:"cli,omitempty"`
	CredentialBroker *ManagedCredentialBroker `json:"credentialBroker,omitempty"`
}

// ManagedCredentialBroker is a connector-owned adapter that translates a
// provider-specific authorization flow into the host-neutral credential
// broker event protocol. The host still owns process isolation and URL policy.
type ManagedCredentialBroker struct {
	Protocol     string   `json:"protocol"`
	Entrypoint   string   `json:"entrypoint"`
	TimeoutMS    int      `json:"timeoutMs"`
	AllowedHosts []string `json:"allowedHosts"`
}

type ManagedMCPInterface struct {
	Entrypoint string   `json:"entrypoint"`
	Arguments  []string `json:"arguments,omitempty"`
}

type ManagedCLIInterface struct {
	Entrypoint string           `json:"entrypoint"`
	Arguments  []string         `json:"arguments,omitempty"`
	TimeoutMS  int              `json:"timeoutMs,omitempty"`
	Install    *CLIInstallation `json:"install,omitempty"`
	Commands   []CLICommand     `json:"commands,omitempty"`
}

// CLIInstallation is a typed installation command. The daemon compiles this
// intent into a package-manager invocation; connector manifests never provide
// an arbitrary shell command.
type CLIInstallation struct {
	Kind        string                   `json:"kind"`
	NodePackage *NodePackageInstallation `json:"nodePackage,omitempty"`
}

type NodePackageInstallation struct {
	Package   string                 `json:"package"`
	Version   string                 `json:"version"`
	Integrity string                 `json:"integrity"`
	Launch    NodePackageLaunch      `json:"launch"`
	Lifecycle []NodeLifecycleCommand `json:"lifecycle,omitempty"`
}

type NodePackageLaunch struct {
	Kind       string `json:"kind"`
	Entrypoint string `json:"entrypoint,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
}

// NodeLifecycleCommand allows a published connector release to opt into a
// specific Node script without granting a general-purpose lifecycle shell.
type NodeLifecycleCommand struct {
	Event      string   `json:"event"`
	Entrypoint string   `json:"entrypoint"`
	Arguments  []string `json:"arguments,omitempty"`
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

type Connector struct {
	Key           string        `json:"key"`
	Release       Release       `json:"release"`
	Installation  Installation  `json:"installation"`
	Authorization Authorization `json:"authorization"`
	Compatibility Compatibility `json:"compatibility"`
	Revision      uint64        `json:"revision"`
}

type Operation struct {
	OperationID     string             `json:"operationId"`
	ClientRequestID string             `json:"clientRequestId"`
	ConnectorKey    string             `json:"connectorKey,omitempty"`
	Kind            OperationKind      `json:"kind"`
	Scope           OperationScope     `json:"scope,omitempty"`
	State           OperationState     `json:"state"`
	Stage           OperationStage     `json:"stage,omitempty"`
	Target          *OperationTarget   `json:"target,omitempty"`
	HostGeneration  HostGeneration     `json:"hostGeneration,omitempty"`
	Execution       OperationExecution `json:"execution,omitempty"`
	Attempt         uint32             `json:"attempt"`
	LeaseOwner      string             `json:"leaseOwner,omitempty"`
	LeaseToken      uint64             `json:"leaseToken,omitempty"`
	LeaseExpiresAt  *time.Time         `json:"leaseExpiresAt,omitempty"`
	FailureCode     string             `json:"failureCode,omitempty"`
	CreatedAt       time.Time          `json:"createdAt"`
	UpdatedAt       time.Time          `json:"updatedAt"`
}

// OperationScope freezes the external authority under which a durable
// operation was accepted. AccountID is intentionally the only persisted
// authority fact: short-lived artifact and credential grants belong to ports
// and must never be serialized into an operation.
type OperationScope struct {
	AccountID string `json:"accountId,omitempty"`
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
	CLIInstallation      *CLIInstallationReceipt   `json:"cliInstallation,omitempty"`
	RuntimeActivation    *RuntimeActivationReceipt `json:"runtimeActivation,omitempty"`
	AuthorizationSession *AuthorizationSession     `json:"authorizationSession,omitempty"`
}

type CLIInstallationReceipt struct {
	SchemaVersion    string `json:"schemaVersion"`
	OperationID      string `json:"operationId"`
	ConnectorKey     string `json:"connectorKey"`
	ReleaseDigest    string `json:"releaseDigest"`
	RuntimeProfile   string `json:"runtimeProfile"`
	RuntimeABI       string `json:"runtimeAbi"`
	NodeVersion      string `json:"nodeVersion"`
	NodeSHA256       string `json:"nodeSha256"`
	Package          string `json:"package"`
	PackageVersion   string `json:"packageVersion"`
	PackageIntegrity string `json:"packageIntegrity"`
	LaunchKind       string `json:"launchKind"`
	InstallRoot      string `json:"installRoot"`
	StoreRoot        string `json:"storeRoot"`
	Entrypoint       string `json:"entrypoint"`
	EntrypointSHA256 string `json:"entrypointSha256"`
	EntrypointSize   int64  `json:"entrypointSizeBytes"`
	LockSHA256       string `json:"lockSha256"`
	// OpaqueInstallationRef identifies an installation owned by a remote or
	// isolated runtime. Cross-machine hosts persist this value instead of guest
	// filesystem paths.
	OpaqueInstallationRef string `json:"opaqueInstallationRef,omitempty"`
}

type PreparedArtifactReceipt struct {
	OperationID     string `json:"operationId"`
	ConnectorKey    string `json:"connectorKey"`
	Version         string `json:"version"`
	ReleaseDigest   string `json:"releaseDigest"`
	ArtifactSHA256  string `json:"artifactSha256"`
	InventoryDigest string `json:"inventoryDigest"`
	PreparedPath    string `json:"preparedPath"`
	// OpaqueArtifactRef identifies a prepared artifact owned by a remote or
	// isolated runtime. It is deliberately meaningless to the control plane.
	OpaqueArtifactRef string `json:"opaqueArtifactRef,omitempty"`
}

type RuntimeActivationReceipt struct {
	OperationID   string `json:"operationId"`
	ConnectorKey  string `json:"connectorKey"`
	ReleaseDigest string `json:"releaseDigest"`
	RuntimeID     string `json:"runtimeId,omitempty"`
}

// HostGeneration fences every MCP/CLI route and child process. BootEpoch
// changes on daemon restart and Generation changes on reconcile or runtime
// deactivation.
type HostGeneration struct {
	BootEpoch  string `json:"bootEpoch"`
	Generation uint64 `json:"generation"`
}

type RuntimeReceipt struct {
	OperationID   string         `json:"operationId"`
	ConnectionID  string         `json:"connectionId"`
	ConnectorKey  string         `json:"connectorKey"`
	ReleaseDigest string         `json:"releaseDigest"`
	Generation    HostGeneration `json:"generation"`
	RouteIDs      []string       `json:"routeIds,omitempty"`
}

type AuthorizationSession struct {
	OperationID      string             `json:"operationId"`
	ConnectorKey     string             `json:"connectorKey"`
	SessionID        string             `json:"sessionId"`
	AuthorizationURL string             `json:"-"`
	State            AuthorizationState `json:"-"`
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
	AccountID    string `json:"accountId,omitempty"`
}

// AuthorizationProjection is account-scoped runtime intent. Installation is
// still device-scoped on Connector; switching accounts changes only this
// projection and the runtime binding derived from it.
type AuthorizationProjection struct {
	AccountID    string             `json:"accountId"`
	ConnectorKey string             `json:"connectorKey"`
	ConnectionID string             `json:"connectionId,omitempty"`
	State        AuthorizationState `json:"state"`
	FailureCode  string             `json:"failureCode,omitempty"`
	UpdatedAt    time.Time          `json:"updatedAt"`
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
