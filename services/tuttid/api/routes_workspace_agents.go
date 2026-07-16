package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerWorkspaceAgentRoutes(mux *http.ServeMux, routes Routes) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agents", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.ListWorkspaceAgents(w, r, workspaceID)
		case http.MethodPost:
			routes.CreateWorkspaceAgent(w, r, workspaceID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agents/{workspaceAgentID}", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		agentID := tuttigenerated.WorkspaceAgentID(r.PathValue("workspaceAgentID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetWorkspaceAgent(w, r, workspaceID, agentID)
		case http.MethodPut:
			routes.UpdateWorkspaceAgent(w, r, workspaceID, agentID)
		case http.MethodDelete:
			routes.DeleteWorkspaceAgent(w, r, workspaceID, agentID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
}
