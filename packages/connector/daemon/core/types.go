package host

import (
	"encoding/json"
	"time"
)

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
	OperationStageAccepted       OperationStage = "accepted"
	OperationStageRefreshing     OperationStage = "refreshing"
	OperationStageInstalling     OperationStage = "installing"
	OperationStageInstalled      OperationStage = "installed"
	OperationStageRuntimePending OperationStage = "runtime_pending"
	OperationStageDeactivating   OperationStage = "deactivating"
	OperationStageRemoving       OperationStage = "removing"
	OperationStageAuthorizing    OperationStage = "authorizing"
	OperationStageDisconnecting  OperationStage = "disconnecting"
	OperationStageCompleted      OperationStage = "completed"
	OperationStageFailed         OperationStage = "failed"
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
	SchemaVersion                string                    `json:"schemaVersion"`
	DisplayName                  string                    `json:"displayName"`
	IconURL                      string                    `json:"iconUrl"`
	Description                  string                    `json:"description,omitempty"`
	AgentRouting                 *AgentRouting             `json:"agentRouting,omitempty"`
	Permissions                  []string                  `json:"permissions"`
	RequiredCapabilities         []string                  `json:"requiredCapabilities,omitempty"`
	Implementation               Implementation            `json:"implementation"`
	AuthorizationKind            string                    `json:"authorizationKind"`
	AuthorizationInteraction     json.RawMessage           `json:"authorizationInteraction,omitempty"`
	AuthorizationInteractionMode string                    `json:"authorizationInteractionMode,omitempty"`
	Compatibility                CompatibilityRequirements `json:"compatibility,omitempty"`
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
	Presentation string   `json:"presentation,omitempty"`
	AllowedHosts []string `json:"allowedHosts"`
}

type ManagedMCPInterface struct {
	Entrypoint string   `json:"entrypoint"`
	Arguments  []string `json:"arguments,omitempty"`
}

type ManagedCLIInterface struct {
	Entrypoint     string             `json:"entrypoint"`
	Command        string             `json:"command,omitempty"`
	Arguments      []string           `json:"arguments,omitempty"`
	TimeoutMS      int                `json:"timeoutMs,omitempty"`
	ReadinessProbe *CLIReadinessProbe `json:"readinessProbe,omitempty"`
	Launch         *CLIArtifactLaunch `json:"launch,omitempty"`
	Install        *CLIInstallation   `json:"install,omitempty"`
	Commands       []CLICommand       `json:"commands,omitempty"`
}

// CLIArtifactLaunch identifies a native executable already contained in the
// signed Connector artifact. Upstream acquisition is a publication concern;
// runtime hosts only execute the prepared artifact after checking this identity.
type CLIArtifactLaunch struct {
	Kind      string `json:"kind"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}

// CLIReadinessProbe is an optional bounded health check for an already
// installed and resolved CLI interface. It is never used to decide whether a
// release is physically installed. Exit code 0 reports ready; every other
// outcome reports an interface-level readiness failure.
type CLIReadinessProbe struct {
	Arguments []string `json:"arguments"`
	TimeoutMS int      `json:"timeoutMs"`
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
	ProtocolVersion     string `json:"protocolVersion"`
	BindingRef          string `json:"bindingRef"`
	ContractVersion     int    `json:"contractVersion"`
	BindingContractHash string `json:"bindingContractHash"`
}

type Installation struct {
	State                  InstallationState `json:"state"`
	InstalledAtUnixMS      int64             `json:"installedAtUnixMs,omitempty"`
	InstalledVersion       string            `json:"installedVersion,omitempty"`
	InstalledReleaseID     string            `json:"installedReleaseId,omitempty"`
	InstalledReleaseDigest string            `json:"installedReleaseDigest,omitempty"`
	CandidateVersion       string            `json:"candidateVersion,omitempty"`
	CandidateReleaseID     string            `json:"candidateReleaseId,omitempty"`
	CandidateReleaseDigest string            `json:"candidateReleaseDigest,omitempty"`
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

type ConnectorRuntimeState string

const (
	ConnectorRuntimeStateStarted  ConnectorRuntimeState = "started"
	ConnectorRuntimeStateStarting ConnectorRuntimeState = "starting"
	ConnectorRuntimeStateStopped  ConnectorRuntimeState = "stopped"
	ConnectorRuntimeStateFailed   ConnectorRuntimeState = "failed"
)

// ConnectorRuntime is a public, credential-free projection of the current
// runtime convergence. It is derived while reading a scoped snapshot and is
// never the source of capability publication truth.
type ConnectorRuntime struct {
	State       ConnectorRuntimeState `json:"state"`
	FailureCode string                `json:"failureCode,omitempty"`
}

type Connector struct {
	Key           string            `json:"key"`
	Release       Release           `json:"release"`
	Installation  Installation      `json:"installation"`
	Authorization Authorization     `json:"authorization"`
	Compatibility Compatibility     `json:"compatibility"`
	Runtime       *ConnectorRuntime `json:"runtime,omitempty"`
	Revision      uint64            `json:"revision"`
}

type Operation struct {
	OperationID     string              `json:"operationId"`
	ClientRequestID string              `json:"clientRequestId"`
	OwnerAccountID  string              `json:"ownerAccountId,omitempty"`
	Visibility      OperationVisibility `json:"visibility"`
	ConnectorKey    string              `json:"connectorKey,omitempty"`
	Kind            OperationKind       `json:"kind"`
	Scope           OperationScope      `json:"scope,omitempty"`
	State           OperationState      `json:"state"`
	Stage           OperationStage      `json:"stage,omitempty"`
	Target          *OperationTarget    `json:"target,omitempty"`
	HostGeneration  HostGeneration      `json:"hostGeneration,omitempty"`
	Execution       OperationExecution  `json:"execution,omitempty"`
	Attempt         uint32              `json:"attempt"`
	LeaseOwner      string              `json:"leaseOwner,omitempty"`
	LeaseToken      uint64              `json:"leaseToken,omitempty"`
	LeaseExpiresAt  *time.Time          `json:"leaseExpiresAt,omitempty"`
	FailureCode     string              `json:"failureCode,omitempty"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt"`
}

// OperationScope freezes the external authority under which a durable
// operation was accepted. AccountID is intentionally the only persisted
// authority fact: short-lived artifact and credential grants belong to ports
// and must never be serialized into an operation.
type OperationScope struct {
	AccountID string `json:"accountId,omitempty"`
}

type OperationVisibility string

const (
	OperationVisibilityAccount       OperationVisibility = "account"
	OperationVisibilitySystemPrivate OperationVisibility = "system_private"
)

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
	ReleaseInstallation  *ReleaseInstallationReceipt `json:"releaseInstallation,omitempty"`
	RuntimeActivation    *RuntimeActivationReceipt   `json:"runtimeActivation,omitempty"`
	AuthorizationSession *AuthorizationSession       `json:"authorizationSession,omitempty"`
}

// ReleaseInstallationReceipt is the control-plane evidence that the exact
// accepted release was installed by its physical runtime owner. Local paths
// are optional because remote installations expose only opaque references.
type ReleaseInstallationReceipt struct {
	OperationID      string                  `json:"operationId"`
	ConnectorKey     string                  `json:"connectorKey"`
	Version          string                  `json:"version"`
	ReleaseID        string                  `json:"releaseId"`
	ReleaseDigest    string                  `json:"releaseDigest"`
	ArtifactSHA256   string                  `json:"artifactSha256"`
	Artifact         PreparedArtifactReceipt `json:"artifact"`
	CLIInstallation  *CLIInstallationReceipt `json:"cliInstallation,omitempty"`
	OpaqueRuntimeRef string                  `json:"opaqueRuntimeRef,omitempty"`
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
	OperationID   string           `json:"operationId"`
	ConnectionID  string           `json:"connectionId"`
	ConnectorKey  string           `json:"connectorKey"`
	ReleaseDigest string           `json:"releaseDigest"`
	Generation    HostGeneration   `json:"generation"`
	Readiness     RuntimeReadiness `json:"readiness"`
	// Summary is the immutable, verified discovery projection committed by this
	// exact reconcile. It is independent of capability publication so lifecycle
	// observers can establish ready state while Agent-facing routes are fenced.
	Summary *ConnectorSummary `json:"summary,omitempty"`
}

// ConnectorSummary contains bounded, non-secret metadata for one committed
// runtime route. RuntimeReceipt owns the route identity; this projection must
// never contain credentials, filesystem paths, or Skill bodies.
type ConnectorSummary struct {
	Key         string                      `json:"key"`
	Version     string                      `json:"version,omitempty"`
	Name        string                      `json:"name"`
	Description string                      `json:"description"`
	Skills      []ConnectorSkillSummary     `json:"skills"`
	Interfaces  []ConnectorInterfaceSummary `json:"interfaces"`
}

type ConnectorSkillSummary struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type ConnectorInterfaceSummary struct {
	Kind       string `json:"kind"`
	ServerName string `json:"serverName,omitempty"`
	ToolPrefix string `json:"toolPrefix,omitempty"`
	Command    string `json:"command,omitempty"`
	Status     string `json:"status"`
}

type RuntimeReadinessState string

const (
	RuntimeReadinessReady   RuntimeReadinessState = "ready"
	RuntimeReadinessBlocked RuntimeReadinessState = "blocked"
	RuntimeReadinessFailed  RuntimeReadinessState = "failed"
)

// RuntimeReadinessReasonRuntimeDisabled confirms that a disabled reconcile
// removed capability publication instead of attempting to start a runtime.
const RuntimeReadinessReasonRuntimeDisabled = "runtime_disabled"

type InterfaceReadiness struct {
	Kind       string                `json:"kind"`
	State      RuntimeReadinessState `json:"state"`
	ReasonCode string                `json:"reasonCode,omitempty"`
	RouteIDs   []string              `json:"routeIds,omitempty"`
}

// RuntimeReadiness describes the usable interfaces committed by one
// reconcile. A CLI-only Connector can therefore be ready without MCP routes.
type RuntimeReadiness struct {
	State      RuntimeReadinessState `json:"state"`
	ReasonCode string                `json:"reasonCode,omitempty"`
	Interfaces []InterfaceReadiness  `json:"interfaces,omitempty"`
}

// RuntimeDesired is the durable, level-triggered runtime intent for one
// account scope and Connector. Generation belongs to this convergence stream;
// it must not reuse the catalog or public event revision.
type RuntimeDesired struct {
	Scope        OperationScope `json:"scope,omitempty"`
	ConnectorKey string         `json:"connectorKey"`
	Generation   uint64         `json:"generation"`
	// ActivationEnabled is the durable user intent for an installed Connector.
	// Nil preserves the pre-activation-control behavior and therefore means on.
	ActivationEnabled  *bool              `json:"activationEnabled,omitempty"`
	Enabled            bool               `json:"enabled"`
	ConnectionID       string             `json:"connectionId"`
	ReleaseDigest      string             `json:"releaseDigest"`
	AuthorizationState AuthorizationState `json:"authorizationState"`
	UpdatedAt          time.Time          `json:"updatedAt"`
}

// RuntimeObserved records the exact desired generation applied by one host
// boot. A matching generation from an older boot is intentionally stale.
type RuntimeObserved struct {
	DesiredGeneration uint64            `json:"desiredGeneration"`
	BootEpoch         string            `json:"bootEpoch"`
	Enabled           bool              `json:"enabled"`
	ConnectionID      string            `json:"connectionId"`
	ReleaseDigest     string            `json:"releaseDigest"`
	Readiness         RuntimeReadiness  `json:"readiness"`
	Summary           *ConnectorSummary `json:"summary,omitempty"`
	ObservedAt        time.Time         `json:"observedAt,omitempty"`
}

// RuntimeConvergence is private durable work. It is deliberately separate
// from public Operations so runtime anti-entropy cannot block or leak into the
// Connector Market command contract.
type RuntimeConvergence struct {
	Desired        RuntimeDesired  `json:"desired"`
	Observed       RuntimeObserved `json:"observed"`
	Attempt        uint32          `json:"attempt"`
	NextAttemptAt  time.Time       `json:"nextAttemptAt,omitempty"`
	LeaseOwner     string          `json:"leaseOwner,omitempty"`
	LeaseToken     uint64          `json:"leaseToken,omitempty"`
	LeaseExpiresAt *time.Time      `json:"leaseExpiresAt,omitempty"`
	LastErrorCode  string          `json:"lastErrorCode,omitempty"`
	LastError      string          `json:"lastError,omitempty"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

type AuthorizationSession struct {
	OperationID      string                         `json:"operationId"`
	ConnectorKey     string                         `json:"connectorKey"`
	ConnectionID     string                         `json:"-"`
	SessionID        string                         `json:"sessionId"`
	ActionType       string                         `json:"actionType"`
	AuthorizationURL string                         `json:"-"`
	UserCode         string                         `json:"-"`
	ExpiresAt        time.Time                      `json:"expiresAt"`
	State            AuthorizationState             `json:"-"`
	Resolution       AuthorizationSessionResolution `json:"resolution"`
}

// AuthorizationSessionResolution records why a private, durable start receipt
// no longer needs provider polling. The empty value is treated as unresolved
// for receipts written by older daemon versions.
type AuthorizationSessionResolution string

const (
	AuthorizationSessionResolutionUnresolved            AuthorizationSessionResolution = "unresolved"
	AuthorizationSessionResolutionCanceling             AuthorizationSessionResolution = "canceling"
	AuthorizationSessionResolutionProviderConnected     AuthorizationSessionResolution = "provider_connected"
	AuthorizationSessionResolutionProviderFailed        AuthorizationSessionResolution = "provider_failed"
	AuthorizationSessionResolutionAccountStateConverged AuthorizationSessionResolution = "account_state_converged"
	AuthorizationSessionResolutionSuperseded            AuthorizationSessionResolution = "superseded"
)

// AuthorizationReconcileIntent is a private receipt transition that becomes
// terminal only after the daemon has awaited the corresponding runtime
// reconcile under its account lifecycle fence.
type AuthorizationReconcileIntent struct {
	OperationID  string
	ConnectorKey string
	Resolution   AuthorizationSessionResolution
}

func (session AuthorizationSession) IsResolved() bool {
	switch session.Resolution {
	case "", AuthorizationSessionResolutionUnresolved, AuthorizationSessionResolutionCanceling:
		return false
	default:
		return true
	}
}

type AuthorizationObservationState string

const (
	AuthorizationObservationPending      AuthorizationObservationState = "pending"
	AuthorizationObservationConnected    AuthorizationObservationState = "connected"
	AuthorizationObservationDisconnected AuthorizationObservationState = "disconnected"
	AuthorizationObservationExpired      AuthorizationObservationState = "expired"
	AuthorizationObservationFailed       AuthorizationObservationState = "failed"
)

type AuthorizationObservation struct {
	AccountID               string                        `json:"accountId,omitempty"`
	AccountGeneration       uint64                        `json:"accountGeneration,omitempty"`
	VMAssignmentID          string                        `json:"vmAssignmentId,omitempty"`
	ConnectorKey            string                        `json:"connectorKey,omitempty"`
	ConnectionID            string                        `json:"connectionId,omitempty"`
	ReleaseDigest           string                        `json:"releaseDigest,omitempty"`
	AuthorizationSessionID  string                        `json:"authorizationSessionId,omitempty"`
	AuthorizationGeneration uint64                        `json:"authorizationGeneration,omitempty"`
	DesktopBootEpoch        string                        `json:"desktopBootEpoch,omitempty"`
	GuestBootID             string                        `json:"guestBootId,omitempty"`
	RuntimeEpoch            string                        `json:"runtimeEpoch,omitempty"`
	StateRevision           uint64                        `json:"stateRevision,omitempty"`
	State                   AuthorizationObservationState `json:"state"`
	Reason                  string                        `json:"reason,omitempty"`
	FailureCode             string                        `json:"failureCode,omitempty"`
	ObservedAt              time.Time                     `json:"observedAt,omitempty"`
}

type Snapshot struct {
	CatalogState   CatalogState `json:"catalogState"`
	Connectors     []Connector  `json:"connectors"`
	Operations     []Operation  `json:"operations"`
	Revision       uint64       `json:"revision"`
	EventCursor    int64        `json:"eventCursor"`
	SourceRevision string       `json:"sourceRevision,omitempty"`
}

type Mutation struct {
	ClientRequestID  string         `json:"clientRequestId"`
	ExpectedRevision uint64         `json:"expectedRevision"`
	Scope            OperationScope `json:"scope,omitempty"`
}

type ConnectorMutation struct {
	Mutation
	ConnectorKey              string                         `json:"connectorKey"`
	AccountID                 string                         `json:"accountId,omitempty"`
	ExpectedConnectorRevision *uint64                        `json:"expectedConnectorRevision,omitempty"`
	ReplacementPolicy         AuthorizationReplacementPolicy `json:"replacementPolicy,omitempty"`
}

type AuthorizationReplacementPolicy string

const (
	AuthorizationReplacementPolicyReplaceActive AuthorizationReplacementPolicy = "replace_active"
)

// EnsureRuntimeReconcileResult reports whether a level-triggered repair
// created work from the caller's current desired state or joined older work
// that must be followed by another ensure after it reaches a terminal state.
type EnsureRuntimeReconcileResult struct {
	MutationResult
	Created bool
}

// AuthorizationProjection is account-scoped runtime intent. Installation is
// still device-scoped on Connector; switching accounts changes only this
// projection and the runtime binding derived from it.
type AuthorizationProjection struct {
	AccountID         string `json:"accountId"`
	ConnectorKey      string `json:"connectorKey"`
	ConnectorVersion  string `json:"connectorVersion,omitempty"`
	ConnectionID      string `json:"connectionId,omitempty"`
	ConnectionVersion uint64 `json:"connectionVersion,omitempty"`
	ServerRevision    uint64 `json:"serverRevision,omitempty"`
	// ServerSynchronized distinguishes an authoritative revision 0 snapshot
	// from device-local authorization state that has never been synchronized.
	ServerSynchronized bool               `json:"serverSynchronized,omitempty"`
	State              AuthorizationState `json:"state"`
	FailureCode        string             `json:"failureCode,omitempty"`
	UpdatedAt          time.Time          `json:"updatedAt"`
}

type AuthorizationSnapshot struct {
	Revision   uint64
	Connectors []AuthorizationProjection
}

type AuthorizationSnapshotApplyResult struct {
	ChangedConnectorKeys        []string
	PendingReceiptConnectorKeys []string
}

type MutationResult struct {
	Connector *Connector `json:"connector,omitempty"`
	Operation Operation  `json:"operation"`
	Revision  uint64     `json:"revision"`
}

type AuthorizationResult struct {
	Connector              Connector                  `json:"connector"`
	Operation              Operation                  `json:"operation"`
	AuthorizationURL       string                     `json:"authorizationUrl,omitempty"`
	AuthorizationView      *AuthorizationViewEnvelope `json:"authorizationView,omitempty"`
	AuthorizationExpiresAt time.Time                  `json:"authorizationExpiresAt"`
	Revision               uint64                     `json:"revision"`
}
