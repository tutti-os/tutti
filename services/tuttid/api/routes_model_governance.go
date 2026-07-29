package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

// registerModelGovernanceRoutes registers the model usage policy, session
// policy override, and acceptance routes. Model access plan and agent model
// binding routes stay inline in routes.go.
func registerModelGovernanceRoutes(mux *http.ServeMux, routes Routes, _ *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-policies", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.ListModelPolicies(w, r, workspaceID)
		case http.MethodPost:
			routes.CreateModelPolicy(w, r, workspaceID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-policies/{modelPolicyID}", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		modelPolicyID := r.PathValue("modelPolicyID")
		switch r.Method {
		case http.MethodGet:
			routes.GetModelPolicy(w, r, workspaceID, modelPolicyID)
		case http.MethodPut:
			routes.UpdateModelPolicy(w, r, workspaceID, modelPolicyID)
		case http.MethodDelete:
			routes.DeleteModelPolicy(w, r, workspaceID, modelPolicyID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/model-policy-override", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		agentSessionID := tuttigenerated.AgentSessionID(r.PathValue("agentSessionID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetAgentSessionModelPolicyOverride(w, r, workspaceID, agentSessionID)
		case http.MethodPut:
			routes.SetAgentSessionModelPolicyOverride(w, r, workspaceID, agentSessionID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/acceptance", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		agentSessionID := tuttigenerated.AgentSessionID(r.PathValue("agentSessionID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetAgentSessionAcceptance(w, r, workspaceID, agentSessionID)
		case http.MethodPost:
			routes.AcceptAgentSessionWork(w, r, workspaceID, agentSessionID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
}
