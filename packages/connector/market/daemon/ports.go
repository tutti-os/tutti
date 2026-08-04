package daemon

import "context"

type CatalogSource interface {
	Refresh(context.Context) (CatalogSnapshot, error)
}

type CatalogSnapshot struct {
	SourceRevision string
	Manifests      []Manifest
}

type Repository interface {
	Snapshot(ctx context.Context, workspaceID string) (Snapshot, error)
	Connector(ctx context.Context, connectorKey, workspaceID string) (Connector, error)
	Operation(ctx context.Context, operationID string) (Operation, error)
	Transaction(ctx context.Context, fn func(Transaction) error) error
	RecoverableOperations(ctx context.Context) ([]Operation, error)
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
}

type ArtifactInstaller interface {
	Install(ctx context.Context, manifest Manifest) error
	Uninstall(ctx context.Context, connector Connector) error
}

type AuthorizationProvider interface {
	Begin(ctx context.Context, connector Connector, clientRequestID string) (authorizationURL string, err error)
	Disconnect(ctx context.Context, connector Connector) error
}

type CompatibilityEvaluator interface {
	Evaluate(manifest Manifest) Compatibility
}

type OperationScheduler interface {
	Schedule(ctx context.Context, operationID string) error
}

type EventPublisher interface {
	ConnectorMarketChanged(ctx context.Context, event ChangedEvent) error
}

type ChangedEvent struct {
	ConnectorKey string `json:"connectorKey,omitempty"`
	OperationID  string `json:"operationId,omitempty"`
	Revision     uint64 `json:"revision"`
}
