package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerWorkspaceAgentSessionRoutes(
	mux *http.ServeMux,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceAgentSessions(w, r)
		case http.MethodDelete:
			wrapper.ClearWorkspaceAgentSessions(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceAgentSession(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/batch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.DeleteWorkspaceAgentSessionsBatch(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/deleted-agent-sessions", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceDeletedAgentSessions(w, r)
		case http.MethodDelete:
			wrapper.PurgeWorkspaceDeletedAgentSessions(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/deleted-agent-sessions/{agentSessionID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.PurgeWorkspaceDeletedAgentSession(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/deleted-agent-sessions/{agentSessionID}/restore", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RestoreWorkspaceDeletedAgentSession(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-sections", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceAgentSessionSections(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-sections/page", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentSessionSectionPage(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-sections/deletion-candidates", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentSessionSectionDeletionCandidates(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-sections/pinned-page", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentPinnedSessionPage(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/external-imports/scan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ScanWorkspaceExternalAgentSessionImports(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/external-imports/import", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ImportWorkspaceExternalAgentSessions(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceAgentSession(w, r)
		case http.MethodDelete:
			wrapper.DeleteWorkspaceAgentSession(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/tutti-mode-activation", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceAgentSessionTuttiModeActivation(w, r)
		case http.MethodPut:
			wrapper.UpdateWorkspaceAgentSessionTuttiModeActivation(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentSessionMessages(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-generated-files", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentGeneratedFiles(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/attachments/{attachmentID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ReadWorkspaceAgentSessionAttachment(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/goal", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GoalControlWorkspaceAgentSession(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/goal/reconcile", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ReconcileWorkspaceAgentSessionGoal(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/input", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SendWorkspaceAgentSessionInput(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/fork", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ForkWorkspaceAgentSession(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/side-capabilities", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ResolveWorkspaceAgentSideCapabilities(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/side-conversations", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.OpenWorkspaceAgentSideConversation(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-side-conversations/{sideAgentSessionID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CloseWorkspaceAgentSideConversation(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-side-conversations/{sideAgentSessionID}/turns", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SendWorkspaceAgentSideConversationInput(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-side-conversations/{sideAgentSessionID}/turns/{turnID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelWorkspaceAgentSideConversationTurn(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-side-conversations/{sideAgentSessionID}/turns/{turnID}/interactive/{requestID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SubmitWorkspaceAgentSideConversationInteractive(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-fork-operations/{operationID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceAgentSessionForkOperation(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-fork-operations/{operationID}/acknowledge", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AcknowledgeWorkspaceAgentSessionForkOperation(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UpdateWorkspaceAgentSessionSettings(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/pin", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UpdateWorkspaceAgentSessionPin(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/title", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UpdateWorkspaceAgentSessionTitle(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelWorkspaceAgentTurn(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/plan-decisions/{requestID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SubmitWorkspaceAgentPlanDecision(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/visibility", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UpdateWorkspaceAgentSessionVisibility(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/interactives/{requestID}/response", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SubmitWorkspaceAgentInteractive(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/git-branches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAgentSessionGitBranches(w, r)
	})

}
