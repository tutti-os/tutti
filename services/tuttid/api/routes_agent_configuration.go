package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func registerAgentConfigurationRoutes(
	mux *http.ServeMux,
	routes Routes,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	registerWorkspaceAgentRoutes(mux, routes)
	registerAutomationRuleRoutes(mux, routes)
	registerModelGovernanceRoutes(mux, routes, wrapper)
}
