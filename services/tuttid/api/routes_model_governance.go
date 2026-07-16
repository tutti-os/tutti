package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

// registerModelGovernanceRoutes registers the model access plan, agent model
// binding, collaboration run, model usage policy, and acceptance routes.
func registerModelGovernanceRoutes(mux *http.ServeMux, routes Routes, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.ListModelPlans(w, r, workspaceID)
		case http.MethodPost:
			routes.CreateModelPlan(w, r, workspaceID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans/detect", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.DetectModelPlan(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans/{modelPlanID}", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		modelPlanID := tuttigenerated.ModelPlanID(r.PathValue("modelPlanID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetModelPlan(w, r, workspaceID, modelPlanID)
		case http.MethodPut:
			routes.UpdateModelPlan(w, r, workspaceID, modelPlanID)
		case http.MethodDelete:
			routes.DeleteModelPlan(w, r, workspaceID, modelPlanID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans/{modelPlanID}/duplicate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.DuplicateModelPlan(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.ModelPlanID(r.PathValue("modelPlanID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans/{modelPlanID}/enabled", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.SetModelPlanEnabled(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.ModelPlanID(r.PathValue("modelPlanID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/model-plans/{modelPlanID}/references", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.ListModelPlanReferences(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.ModelPlanID(r.PathValue("modelPlanID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/collaboration-runs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListCollaborationRuns(w, r)
		case http.MethodPost:
			routes.CreateCollaborationRun(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")))
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/collaboration-runs/{collaborationRunID}/adoption", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.SetCollaborationRunAdoption(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.CollaborationRunID(r.PathValue("collaborationRunID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/collaboration-runs/{collaborationRunID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.CancelCollaborationRun(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.CollaborationRunID(r.PathValue("collaborationRunID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/collaboration-runs/{collaborationRunID}/retry", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.RetryCollaborationRun(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), tuttigenerated.CollaborationRunID(r.PathValue("collaborationRunID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-model-bindings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.ListAgentModelBindings(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-model-bindings/{agentTargetID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.SetAgentModelBinding(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")), r.PathValue("agentTargetID"))
	})

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
