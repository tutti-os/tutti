package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerIssueRoutes(mux *http.ServeMux, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceIssues(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceIssue(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/from-plan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CreateWorkspaceIssueFromPlan(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/auto-token-budget-estimate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.EstimateWorkspaceIssueAutoTokenBudget(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issue-references/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SearchWorkspaceIssueReferences(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issue-topics", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceIssueTopics(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceIssueTopic(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issue-topics/{topicID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			wrapper.UpdateWorkspaceIssueTopic(w, r)
		case http.MethodDelete:
			wrapper.DeleteWorkspaceIssueTopic(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceIssueDetail(w, r)
		case http.MethodPatch:
			wrapper.UpdateWorkspaceIssue(w, r)
		case http.MethodDelete:
			wrapper.DeleteWorkspaceIssue(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/context-refs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AddWorkspaceIssueContextRefs(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/context-refs/{contextRefID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RemoveWorkspaceIssueContextRef(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/cancel-execution", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelWorkspaceIssueExecution(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/runs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceIssueRuns(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceIssueRun(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/runs/{runID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceIssueRun(w, r)
		case http.MethodPatch:
			wrapper.CompleteWorkspaceIssueRun(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceIssueTasks(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceIssueTask(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/batch-create", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CreateWorkspaceIssueTasks(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/{taskID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceIssueTaskDetail(w, r)
		case http.MethodPatch:
			wrapper.UpdateWorkspaceIssueTask(w, r)
		case http.MethodDelete:
			wrapper.DeleteWorkspaceIssueTask(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/{taskID}/context-refs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AddWorkspaceIssueTaskContextRefs(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/{taskID}/context-refs/{contextRefID}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RemoveWorkspaceIssueTaskContextRef(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/{taskID}/runs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceIssueTaskRuns(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceIssueTaskRun(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tasks/{taskID}/runs/{runID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceIssueTaskRun(w, r)
		case http.MethodPatch:
			wrapper.CompleteWorkspaceIssueTaskRun(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
}
