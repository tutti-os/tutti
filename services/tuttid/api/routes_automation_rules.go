package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAutomationRuleRoutes(mux *http.ServeMux, routes Routes) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/automation-rules", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.ListAutomationRules(w, r, workspaceID)
		case http.MethodPost:
			routes.CreateAutomationRule(w, r, workspaceID)
		default:
			types.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/automation-rules/{automationRuleID}", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		ruleID := tuttigenerated.AutomationRuleID(r.PathValue("automationRuleID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetAutomationRule(w, r, workspaceID, ruleID)
		case http.MethodPut:
			routes.UpdateAutomationRule(w, r, workspaceID, ruleID)
		case http.MethodDelete:
			routes.DeleteAutomationRule(w, r, workspaceID, ruleID)
		default:
			types.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/automation-rule-override", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		sessionID := tuttigenerated.AgentSessionID(r.PathValue("agentSessionID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetAgentSessionAutomationRuleOverride(w, r, workspaceID, sessionID)
		case http.MethodPut:
			routes.SetAgentSessionAutomationRuleOverride(w, r, workspaceID, sessionID)
		default:
			types.WriteMethodNotAllowed(w)
		}
	})
}
