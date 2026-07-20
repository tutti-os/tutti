package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type AgentExtensionCatalogService interface {
	ListCatalog(context.Context) ([]agentextensionservice.CatalogEntry, error)
}

func (api DaemonAPI) ListAgentExtensionCatalog(ctx context.Context, _ tuttigenerated.ListAgentExtensionCatalogRequestObject) (tuttigenerated.ListAgentExtensionCatalogResponseObject, error) {
	if api.AgentExtensionCatalogService == nil {
		return tuttigenerated.ListAgentExtensionCatalog503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_extension_catalog_service_unavailable",
					apierrors.WithDeveloperMessage("agent extension catalog service is unavailable"),
				),
			),
		}, nil
	}
	entries, err := api.AgentExtensionCatalogService.ListCatalog(ctx)
	if err != nil {
		return tuttigenerated.ListAgentExtensionCatalog502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	extensions := make([]tuttigenerated.AgentExtensionCatalogEntry, 0, len(entries))
	for _, entry := range entries {
		extensions = append(extensions, tuttigenerated.AgentExtensionCatalogEntry{
			IconUrl:  entry.IconURL,
			Key:      entry.Key,
			Name:     entry.Name,
			TargetId: entry.TargetID,
		})
	}
	return tuttigenerated.ListAgentExtensionCatalog200JSONResponse{
		Extensions: extensions,
	}, nil
}
