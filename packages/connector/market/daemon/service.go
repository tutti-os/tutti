package daemon

import "context"

// Service is the host-neutral connector-market application boundary. Host
// daemons provide ports for persistence, artifacts, authorization, scheduling,
// and events; transports adapt their generated OpenAPI DTOs to this interface.
type Service interface {
	Snapshot(ctx context.Context, workspaceID string) (Snapshot, error)
	ListCatalogCategories(ctx context.Context) ([]CatalogCategory, error)
	ListCatalogPage(ctx context.Context, query CatalogPageQuery) (CatalogPage, error)
	GetConnector(ctx context.Context, connectorKey, workspaceID string) (Connector, error)
	GetOperation(ctx context.Context, operationID string) (Operation, error)
	RefreshCatalog(ctx context.Context, mutation Mutation) (MutationResult, error)
	Install(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	Uninstall(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	BeginAuthorization(ctx context.Context, mutation ConnectorMutation) (AuthorizationResult, error)
	DisconnectAuthorization(ctx context.Context, mutation ConnectorMutation) (MutationResult, error)
	SetWorkspaceEnabled(ctx context.Context, command SetWorkspaceEnabledCommand) (WorkspaceBindingResult, error)
	ExecuteOperation(ctx context.Context, operationID string) error
	Recover(ctx context.Context) error
}
