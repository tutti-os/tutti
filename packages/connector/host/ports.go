package host

import (
	"context"
	"time"
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
	ClaimOperation(ctx context.Context, operationID, owner string, now, leaseExpiresAt time.Time) (Operation, bool, error)
	RenewOperationLease(ctx context.Context, operationID, owner string, token uint64, now, leaseExpiresAt time.Time) error
	ReleaseOperationLease(ctx context.Context, operationID, owner string, token uint64) error
	Transaction(ctx context.Context, fn func(Transaction) error) error
	RecoverableOperations(ctx context.Context) ([]Operation, error)
	InstalledRelease(ctx context.Context, connectorKey, releaseDigest string) (Release, error)
}

type Transaction interface {
	Revision() uint64
	AdvanceRevision() uint64
	Connectors() ([]Connector, error)
	Connector(connectorKey string) (Connector, error)
	Operation(operationID string) (Operation, error)
	OperationByClientRequestID(clientRequestID string) (*Operation, error)
	ActiveOperation(connectorKey string) (*Operation, error)
	SaveCatalogRevision(sourceRevision string) error
	SetCatalogState(state CatalogState) error
	SaveConnector(Connector) error
	DeleteConnector(connectorKey string) error
	SaveOperation(Operation) error
	EnqueueConnectorMarketChanged(ChangedEvent) error
}

type ArtifactPreparer interface {
	Prepare(ctx context.Context, request PrepareArtifactRequest) (PreparedArtifactReceipt, error)
	Remove(ctx context.Context, request RemoveArtifactRequest) error
}

// CLIInstallationManager installs and resolves daemon-managed CLI packages.
// Implementations must bind installation and launch to the same managed
// runtime and keep package storage outside the user's global package manager.
type CLIInstallationManager interface {
	InstallCLI(ctx context.Context, request InstallCLIRequest) (CLIInstallationReceipt, error)
	ResolveCLI(ctx context.Context, release Release) (CLIInstallationReceipt, error)
	RemoveCLI(ctx context.Context, request RemoveCLIRequest) error
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
	Generation    HostGeneration
	Deadline      time.Time
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
	RuntimeBindingPurposeReconcile  RuntimeBindingPurpose = "reconcile"
	RuntimeBindingPurposeDeactivate RuntimeBindingPurpose = "deactivate"
)

type RuntimeBinding struct {
	ConnectionID          string
	Enabled               bool
	CredentialBrokerGrant []byte
}

// AuthorizationProjectionStore keeps account authorization separate from the
// device-scoped Connector installation fact.
type AuthorizationProjectionStore interface {
	AuthorizationProjection(ctx context.Context, accountID, connectorKey string) (AuthorizationProjection, error)
	SaveAuthorizationProjection(ctx context.Context, projection AuthorizationProjection) error
}

type CredentialBrokerGrantIssuer interface {
	IssueCredentialBrokerGrant(ctx context.Context, accountID, connectorKey, connectionID string) ([]byte, error)
}

type AuthorizationProvider interface {
	Begin(ctx context.Context, request AuthorizationStartRequest) (AuthorizationSession, error)
	Disconnect(ctx context.Context, request AuthorizationDisconnectRequest) error
}

type AuthorizationStartRequest struct {
	OperationID     string
	ClientRequestID string
	Scope           OperationScope
	Connector       Connector
	Release         Release
}

type AuthorizationDisconnectRequest struct {
	OperationID string
	Scope       OperationScope
	Connector   Connector
}

type CompatibilityEvaluator interface {
	Evaluate(manifest Manifest) Compatibility
}

type OperationScheduler interface {
	Schedule(ctx context.Context, operationID string) error
}

type ChangedEvent struct {
	ConnectorKey string `json:"connectorKey,omitempty"`
	OperationID  string `json:"operationId,omitempty"`
	Revision     uint64 `json:"revision"`
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
