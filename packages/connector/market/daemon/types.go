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

type Manifest struct {
	SchemaVersion     string                    `json:"schemaVersion"`
	Key               string                    `json:"key"`
	Version           string                    `json:"version"`
	DisplayName       string                    `json:"displayName"`
	Description       string                    `json:"description,omitempty"`
	Permissions       []string                  `json:"permissions"`
	Artifact          Artifact                  `json:"artifact"`
	Implementation    Implementation            `json:"implementation"`
	AuthorizationKind string                    `json:"authorizationKind"`
	Compatibility     CompatibilityRequirements `json:"compatibility,omitempty"`
}

type Artifact struct {
	Key       string `json:"key"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}

type CompatibilityRequirements struct {
	Products           []string `json:"products,omitempty"`
	Platforms          []string `json:"platforms,omitempty"`
	MinimumHostVersion string   `json:"minimumHostVersion,omitempty"`
}

type Implementation struct {
	Kind   string         `json:"kind"`
	Config map[string]any `json:"config,omitempty"`
}

type Installation struct {
	State            InstallationState `json:"state"`
	InstalledVersion string            `json:"installedVersion,omitempty"`
	FailureCode      string            `json:"failureCode,omitempty"`
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
	Manifest         Manifest          `json:"manifest"`
	Installation     Installation      `json:"installation"`
	Authorization    Authorization     `json:"authorization"`
	Compatibility    Compatibility     `json:"compatibility"`
	WorkspaceBinding *WorkspaceBinding `json:"workspaceBinding,omitempty"`
	Revision         uint64            `json:"revision"`
}

type Operation struct {
	OperationID     string         `json:"operationId"`
	ClientRequestID string         `json:"clientRequestId"`
	ConnectorKey    string         `json:"connectorKey,omitempty"`
	Kind            OperationKind  `json:"kind"`
	State           OperationState `json:"state"`
	Stage           string         `json:"stage,omitempty"`
	FailureCode     string         `json:"failureCode,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
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
