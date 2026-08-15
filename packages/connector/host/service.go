package host

import "context"

// SnapshotReader is the read-only connector-market state boundary used by
// consumers that must not depend on repository persistence details.
type SnapshotReader interface {
	Snapshot(ctx context.Context) (Snapshot, error)
}

type ScopedSnapshotReader interface {
	SnapshotForScope(ctx context.Context, scope OperationScope) (Snapshot, error)
}

type ScopedOperationReader interface {
	GetOperationForScope(ctx context.Context, scope OperationScope, operationID string) (Operation, error)
}

// Service is the host-neutral connector-market application boundary. Host
// daemons provide ports for persistence, artifacts, authorization, scheduling,
// and events; transports adapt their generated OpenAPI DTOs to this interface.
type Service interface {
	SnapshotReader
	ListCatalogCategories(ctx context.Context) ([]CatalogCategory, error)
	ListCatalogPage(ctx context.Context, query CatalogPageQuery) (CatalogPage, error)
	GetConnector(ctx context.Context, connectorKey string) (Connector, error)
	GetOperationForScope(ctx context.Context, scope OperationScope, operationID string) (Operation, error)
	RefreshCatalog(ctx context.Context, mutation Mutation) (MutationResult, error)
	Install(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	Uninstall(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	ReconcileRuntime(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	GetAuthorizationProjection(ctx context.Context, accountID, connectorKey string) (AuthorizationProjection, error)
	ObserveAuthorization(ctx context.Context, mutation ConnectorMutation, projection AuthorizationProjection) (MutationResult, error)
	BeginAuthorization(ctx context.Context, mutation ConnectorMutation, secret []byte) (AuthorizationResult, error)
	CancelAuthorization(ctx context.Context, scope OperationScope, connectorKey string) error
	DisconnectAuthorization(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	ExecuteOperation(ctx context.Context, operationID string) error
	Recover(ctx context.Context) error
}
