package daemon

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
	SectionID   string
	PageSize    int
	PageToken   string
	WorkspaceID string
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
	Snapshot(ctx context.Context, workspaceID string) (Snapshot, error)
	Connector(ctx context.Context, connectorKey, workspaceID string) (Connector, error)
	Operation(ctx context.Context, operationID string) (Operation, error)
	ClaimOperation(ctx context.Context, operationID, owner string, now, leaseExpiresAt time.Time) (Operation, bool, error)
	RenewOperationLease(ctx context.Context, operationID, owner string, token uint64, now, leaseExpiresAt time.Time) error
	ReleaseOperationLease(ctx context.Context, operationID, owner string, token uint64) error
	Transaction(ctx context.Context, fn func(Transaction) error) error
	RecoverableOperations(ctx context.Context) ([]Operation, error)
	WorkspaceBindings(ctx context.Context, connectorKey string) ([]WorkspaceBinding, error)
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
	SetWorkspaceBinding(connectorKey string, binding WorkspaceBinding) (Connector, error)
	EnqueueConnectorMarketChanged(ChangedEvent) error
}

type ArtifactPreparer interface {
	Prepare(ctx context.Context, request PrepareArtifactRequest) (PreparedArtifactReceipt, error)
	Remove(ctx context.Context, request RemoveArtifactRequest) error
}

type PrepareArtifactRequest struct {
	OperationID string
	Release     Release
}

type RemoveArtifactRequest struct {
	OperationID   string
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

// ImplementationHost reconciles durable workspace intent into MCP routes and
// CLI registrations. Installing an artifact never starts a connector process.
type ImplementationHost interface {
	Reconcile(ctx context.Context, request WorkspaceReconcileRequest) (WorkspaceRuntimeReceipt, error)
	DeactivateWorkspace(ctx context.Context, request WorkspaceDeactivationRequest) error
	// FailClosed stops all capability publication before best-effort fencing.
	FailClosed(ctx context.Context, deadline time.Time) error
}

type WorkspaceReconcileRequest struct {
	OperationID string
	WorkspaceID string
	Connector   Connector
	Enabled     bool
	Generation  HostGeneration
}

type WorkspaceDeactivationRequest struct {
	WorkspaceID   string
	ConnectorKey  string
	ReleaseDigest string
	Generation    HostGeneration
	Deadline      time.Time
}

type RuntimeObserveRequest struct {
	ConnectorKey string
}

type RuntimeActivationRequest struct {
	OperationID string
	Release     Release
	Prepared    PreparedArtifactReceipt
}

type RuntimeDeactivationRequest struct {
	OperationID   string
	ConnectorKey  string
	Version       string
	ReleaseID     string
	ReleaseDigest string
}

type AuthorizationProvider interface {
	Begin(ctx context.Context, request AuthorizationStartRequest) (AuthorizationSession, error)
	Disconnect(ctx context.Context, request AuthorizationDisconnectRequest) error
}

type AuthorizationStartRequest struct {
	OperationID     string
	ClientRequestID string
	Connector       Connector
	Release         Release
}

type AuthorizationDisconnectRequest struct {
	OperationID string
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
