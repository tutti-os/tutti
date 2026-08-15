package host

import (
	"context"
	"errors"
	"time"
)

var (
	ErrReleaseInstallationAbsent  = errors.New("connector release installation is absent")
	ErrReleaseInstallationInvalid = errors.New("connector release installation is invalid")
)

type CatalogSource interface {
	ListCategories(context.Context) ([]CatalogCategory, error)
	ListPage(context.Context, CatalogSourcePageQuery) (CatalogSourcePage, error)
	Refresh(context.Context) (CatalogSnapshot, error)
}

type CatalogSourcePageQuery struct {
	SectionID string
	PageSize  int
	PageToken string
}

type CatalogPageQuery struct {
	SectionID string
	PageSize  int
	PageToken string
}

type CatalogCategory struct {
	CategoryID string `json:"categoryId"`
	Kind       string `json:"kind"`
	SortOrder  int32  `json:"sortOrder"`
	ItemCount  int64  `json:"itemCount"`
}

type CatalogEntry struct {
	CategoryID string  `json:"categoryId"`
	Featured   bool    `json:"featured"`
	Release    Release `json:"release"`
}

type CatalogSourcePage struct {
	SectionID     string
	Entries       []CatalogEntry
	NextPageToken string
}

type CatalogListing struct {
	CategoryID string    `json:"categoryId"`
	Featured   bool      `json:"featured"`
	Connector  Connector `json:"connector"`
}

type CatalogPage struct {
	SectionID     string           `json:"sectionId"`
	Items         []CatalogListing `json:"items"`
	NextPageToken string           `json:"nextPageToken,omitempty"`
	Revision      uint64           `json:"revision"`
}

type CatalogSnapshot struct {
	SourceRevision string
	Releases       []Release
}

type Repository interface {
	Snapshot(ctx context.Context) (Snapshot, error)
	Connector(ctx context.Context, connectorKey string) (Connector, error)
	Operation(ctx context.Context, operationID string) (Operation, error)
	OperationForScope(ctx context.Context, scope OperationScope, operationID string) (Operation, error)
	// UnresolvedAuthorizationSessionOperations exposes private durable receipts
	// only for the explicitly active account. Snapshot remains safe for public
	// presentation and must not contain Operation.Execution.
	UnresolvedAuthorizationSessionOperations(ctx context.Context, scope OperationScope) ([]Operation, error)
	ResolveAuthorizationSession(ctx context.Context, operationID string, resolution AuthorizationSessionResolution) error
	ClaimOperation(ctx context.Context, operationID, owner string, now, leaseExpiresAt time.Time) (Operation, bool, error)
	RenewOperationLease(ctx context.Context, operationID, owner string, token uint64, now, leaseExpiresAt time.Time) error
	ReleaseOperationLease(ctx context.Context, operationID, owner string, token uint64) error
	Transaction(ctx context.Context, fn func(Transaction) error) error
	RecoverableOperations(ctx context.Context) ([]Operation, error)
	InstalledRelease(ctx context.Context, connectorKey, releaseDigest string) (Release, error)
	RuntimeConvergence(ctx context.Context, scope OperationScope, connectorKey string) (RuntimeConvergence, error)
	DueRuntimeConvergences(ctx context.Context, scope OperationScope, bootEpoch string, now time.Time, limit int) ([]RuntimeConvergence, error)
	ClaimRuntimeConvergence(ctx context.Context, scope OperationScope, connectorKey, bootEpoch, owner string, now, leaseExpiresAt time.Time) (RuntimeConvergence, bool, error)
	RenewRuntimeConvergenceLease(ctx context.Context, scope OperationScope, connectorKey, owner string, token uint64, now, leaseExpiresAt time.Time) error
	ReleaseRuntimeConvergenceLease(ctx context.Context, scope OperationScope, connectorKey, owner string, token uint64) error
	CompleteRuntimeConvergence(ctx context.Context, scope OperationScope, connectorKey, owner string, token, desiredGeneration uint64, observed RuntimeObserved, now time.Time) error
	RetryRuntimeConvergence(ctx context.Context, scope OperationScope, connectorKey, owner string, token, desiredGeneration uint64, nextAttemptAt time.Time, errorCode, errorMessage string, now time.Time) error
}

type Transaction interface {
	Revision() uint64
	AdvanceRevision() uint64
	Connectors() ([]Connector, error)
	Connector(connectorKey string) (Connector, error)
	Operation(operationID string) (Operation, error)
	OperationByClientRequestID(ownerAccountID, clientRequestID string) (*Operation, error)
	ActiveOperation(connectorKey string) (*Operation, error)
	SaveCatalogRevision(sourceRevision string) error
	SetCatalogState(state CatalogState) error
	SaveConnector(Connector) error
	DeleteConnector(connectorKey string) error
	SaveOperation(Operation) error
	RuntimeConvergence(scope OperationScope, connectorKey string) (RuntimeConvergence, error)
	SaveRuntimeConvergence(RuntimeConvergence) error
	DeleteRuntimeConvergence(scope OperationScope, connectorKey string) error
	EnqueueConnectorMarketChanged(ChangedEvent) error
}

// ReleaseInstallationManager owns the complete physical release installation
// boundary. A same-machine host may compose artifact import and CLI package
// installation locally, while a remote host may download on the control-plane
// machine, transfer verified bytes, and ask the runtime machine to install them
// in one idempotent operation.
//
// Installation never implies capability publication. Runtime activation is a
// separate ImplementationHost reconcile driven by authorization state.
type ReleaseInstallationManager interface {
	InstallRelease(ctx context.Context, request InstallReleaseRequest) (ReleaseInstallationReceipt, error)
	InspectReleaseInstallation(ctx context.Context, request InspectReleaseInstallationRequest) (ReleaseInstallationObservation, error)
	CommitReleaseInstallation(ctx context.Context, request CommitReleaseInstallationRequest) error
	UninstallRelease(ctx context.Context, request UninstallReleaseRequest) error
}

type InstallReleaseRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
}

type UninstallReleaseRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
}

type InspectReleaseInstallationRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
}

type ReleaseInstallationObservationState string

const (
	ReleaseInstallationPresent       ReleaseInstallationObservationState = "present"
	ReleaseInstallationAbsent        ReleaseInstallationObservationState = "absent"
	ReleaseInstallationInvalid       ReleaseInstallationObservationState = "invalid"
	ReleaseInstallationIndeterminate ReleaseInstallationObservationState = "indeterminate"
)

type ReleaseInstallationObservation struct {
	State         ReleaseInstallationObservationState `json:"state"`
	ConnectorKey  string                              `json:"connectorKey"`
	ReleaseDigest string                              `json:"releaseDigest"`
	ReasonCode    string                              `json:"reasonCode,omitempty"`
	Receipt       *ReleaseInstallationReceipt         `json:"receipt,omitempty"`
}

// CommitReleaseInstallation is invoked only after installed truth is durable
// in the business repository. Cross-machine hosts use it to promote a cached
// candidate to current; same-machine installers may implement it as a no-op.
type CommitReleaseInstallationRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
	Receipt     ReleaseInstallationReceipt
}

// ArtifactPreparer is the same-machine artifact import boundary used by the
// runtime package's ReleaseInstaller composition. Application hosts depend on
// ReleaseInstallationManager instead of orchestrating this lower-level port.
type ArtifactPreparer interface {
	Prepare(ctx context.Context, request PrepareArtifactRequest) (PreparedArtifactReceipt, error)
	ResolvePrepared(ctx context.Context, release Release) (PreparedArtifactReceipt, error)
	Remove(ctx context.Context, request RemoveArtifactRequest) error
	RemoveConnector(ctx context.Context, request RemoveConnectorInstallationRequest) error
}

// CLIInstallationManager installs and resolves daemon-managed CLI packages.
// Implementations must bind installation and launch to the same managed
// runtime and keep package storage outside the user's global package manager.
type CLIInstallationManager interface {
	InstallCLI(ctx context.Context, request InstallCLIRequest) (CLIInstallationReceipt, error)
	ResolveCLI(ctx context.Context, release Release) (CLIInstallationReceipt, error)
	RemoveCLI(ctx context.Context, request RemoveCLIRequest) error
	RemoveConnector(ctx context.Context, request RemoveConnectorInstallationRequest) error
}

// RemoveConnectorInstallationRequest identifies an explicit Connector
// uninstall. Unlike the release-scoped removal requests used by installation
// rollback, this request removes every locally retained release for the
// Connector while preserving storage shared by other Connectors.
type RemoveConnectorInstallationRequest struct {
	OperationID  string
	Scope        OperationScope
	Generation   HostGeneration
	ConnectorKey string
}

type InstallCLIRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
}

type RemoveCLIRequest struct {
	OperationID   string
	Scope         OperationScope
	Generation    HostGeneration
	ConnectorKey  string
	ReleaseDigest string
}

type PrepareArtifactRequest struct {
	OperationID string
	Scope       OperationScope
	Generation  HostGeneration
	Release     Release
}

type RemoveArtifactRequest struct {
	OperationID   string
	Scope         OperationScope
	Generation    HostGeneration
	ConnectorKey  string
	Version       string
	ReleaseDigest string
}

type RuntimeState string

const (
	RuntimeStateInactive RuntimeState = "inactive"
	RuntimeStateActive   RuntimeState = "active"
	RuntimeStateUnknown  RuntimeState = "unknown"
)

type RuntimeObservation struct {
	State         RuntimeState
	ReleaseDigest string
}

// ImplementationHost reconciles installed connector releases into global MCP
// routes and CLI registrations.
type ImplementationHost interface {
	Reconcile(ctx context.Context, request RuntimeReconcileRequest) (RuntimeReceipt, error)
	DeactivateRuntime(ctx context.Context, request RuntimeDeactivationRequest) error
	// FailClosed stops all capability publication before best-effort fencing.
	FailClosed(ctx context.Context, deadline time.Time) error
}

type RuntimeReconcileRequest struct {
	OperationID  string
	Scope        OperationScope
	ConnectionID string
	Connector    Connector
	Enabled      bool
	Generation   HostGeneration
	// CredentialBrokerGrant is a one-shot authority passed directly to the
	// runtime adapter. Implementations must not log or persist it.
	CredentialBrokerGrant []byte
}

type RuntimeDeactivationRequest struct {
	Scope         OperationScope
	ConnectionID  string
	ConnectorKey  string
	ReleaseDigest string
	// AllConnections fences every local route for this Connector, including
	// routes for superseded releases. Device uninstall uses this because an
	// authorization provider may rotate the connection identity after a route was
	// published, and a failed earlier retirement may retain an older release.
	AllConnections bool
	Generation     HostGeneration
	Deadline       time.Time
}

// RuntimeBindingResolver converts device installation plus an explicit
// operation scope into account-aware runtime intent. It is the only port that
// may obtain a short-lived credential grant; the Application clears the grant
// after the ImplementationHost call returns.
type RuntimeBindingResolver interface {
	ResolveRuntimeBinding(context.Context, RuntimeBindingRequest) (RuntimeBinding, error)
}

type RuntimeBindingRequest struct {
	OperationID string
	Scope       OperationScope
	Purpose     RuntimeBindingPurpose
	Connector   Connector
	Release     Release
}

type RuntimeBindingPurpose string

const (
	RuntimeBindingPurposePlan       RuntimeBindingPurpose = "plan"
	RuntimeBindingPurposeReconcile  RuntimeBindingPurpose = "reconcile"
	RuntimeBindingPurposeDeactivate RuntimeBindingPurpose = "deactivate"
)

type RuntimeBinding struct {
	ConnectionID          string
	Enabled               bool
	AuthorizationState    AuthorizationState
	CredentialBrokerGrant []byte
}

// AuthorizationProjectionStore keeps account authorization separate from the
// device-scoped Connector installation fact.
type AuthorizationProjectionStore interface {
	AuthorizationProjection(ctx context.Context, accountID, connectorKey string) (AuthorizationProjection, error)
	SaveAuthorizationProjection(ctx context.Context, projection AuthorizationProjection) error
}

type AuthorizationSnapshotStore interface {
	AuthorizationProjectionStore
	ApplyAuthorizationSnapshot(ctx context.Context, accountID string, snapshot AuthorizationSnapshot) (AuthorizationSnapshotApplyResult, error)
}

type AuthorizationSnapshotSource interface {
	AuthorizationSnapshot(ctx context.Context, accountID string) (AuthorizationSnapshot, error)
}

type AuthorizationEventSource interface {
	RunAuthorizationEvents(ctx context.Context, accountID string, notify func()) error
}

type CredentialBrokerGrantIssuer interface {
	IssueCredentialBrokerGrant(ctx context.Context, accountID, connectorKey, connectionID string) ([]byte, error)
}

type AuthorizationProvider interface {
	Begin(ctx context.Context, request AuthorizationStartRequest) (AuthorizationSession, error)
	Disconnect(ctx context.Context, request AuthorizationDisconnectRequest) error
}

// AuthorizationObserver is an optional asynchronous extension implemented by
// providers whose user interaction completes outside the daemon process.
type AuthorizationObserver interface {
	Observe(ctx context.Context, request AuthorizationObserveRequest) (AuthorizationObservation, error)
}

// AuthorizationInspector is the synchronous calibration boundary used by a
// runtime owner after boot, before reconcile, and after authorization errors.
type AuthorizationInspector interface {
	InspectAuthorization(ctx context.Context, request AuthorizationInspectRequest) (AuthorizationObservation, error)
}

type AuthorizationInspectRequest struct {
	Scope                   OperationScope
	Connector               Connector
	AccountGeneration       uint64
	VMAssignmentID          string
	AuthorizationSessionID  string
	AuthorizationGeneration uint64
	DesktopBootEpoch        string
	GuestBootID             string
	RuntimeEpoch            string
	StateRevision           uint64
}

type AuthorizationStartRequest struct {
	OperationID     string
	ClientRequestID string
	Scope           OperationScope
	Connector       Connector
	Release         Release
	Secret          []byte
}

type AuthorizationDisconnectRequest struct {
	OperationID string
	Scope       OperationScope
	Connector   Connector
	Release     Release
}

type AuthorizationObserveRequest struct {
	Scope     OperationScope
	Connector Connector
	Release   Release
	Session   AuthorizationSession
}

type CompatibilityEvaluator interface {
	Evaluate(manifest Manifest) Compatibility
}

type OperationScheduler interface {
	Schedule(ctx context.Context, operationID string) error
}

type ChangedEvent struct {
	ConnectorKey   string              `json:"connectorKey,omitempty"`
	OperationID    string              `json:"operationId,omitempty"`
	OwnerAccountID string              `json:"ownerAccountId,omitempty"`
	Visibility     OperationVisibility `json:"visibility,omitempty"`
	Revision       uint64              `json:"revision"`
	Cursor         int64               `json:"cursor,omitempty"`
}

type ChangedEventRecord struct {
	Sequence int64
	Event    ChangedEvent
}

// ChangedEventOutbox is a host persistence extension. Events are appended by
// Repository.Transaction and delivered after commit by a host-owned worker.
type ChangedEventOutbox interface {
	PendingChangedEvents(ctx context.Context, limit int) ([]ChangedEventRecord, error)
	MarkChangedEventPublished(ctx context.Context, sequence int64, publishedAt time.Time) error
}

// LifecycleCleanupStore removes only terminal operation results and events
// whose publication has already been recorded. Active operations and pending
// events are deliberately outside this contract so cleanup cannot weaken
// crash recovery or at-least-once event delivery.
type LifecycleCleanupStore interface {
	CleanupLifecycle(ctx context.Context, request LifecycleCleanupRequest) (LifecycleCleanupResult, error)
}

type LifecycleCleanupRequest struct {
	TerminalOperationsUpdatedThrough time.Time
	PublishedEventsPublishedThrough  time.Time
	BatchSize                        int
}

type LifecycleCleanupResult struct {
	TerminalOperationsDeleted int64
	PublishedEventsDeleted    int64
}
