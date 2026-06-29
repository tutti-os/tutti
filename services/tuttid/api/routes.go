package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type Routes interface {
	tuttigenerated.ServerInterface
	AttachEventStreamWebSocket(http.ResponseWriter, *http.Request)
	AttachWorkspaceTerminalWebSocket(http.ResponseWriter, *http.Request)
	HandleManagedModelGrant(http.ResponseWriter, *http.Request, string, string, string)
	HandleManagedModelGrantCredential(http.ResponseWriter, *http.Request, string, string, string)
	HandleManagedModelGrantExchange(http.ResponseWriter, *http.Request, string, string)
	HandleManagedModelGrantModels(http.ResponseWriter, *http.Request, string, string, string)
	HandleManagedModelGrants(http.ResponseWriter, *http.Request, string, string)
	HandleManagedModelProvider(http.ResponseWriter, *http.Request, string, string)
	HandleManagedModelProviderModels(http.ResponseWriter, *http.Request, string, string)
	HandleManagedModelProviderTest(http.ResponseWriter, *http.Request, string, string)
	HandleManagedModelProviders(http.ResponseWriter, *http.Request, string)
}

func RegisterRoutes(mux *http.ServeMux, routes Routes) {
	wrapper := &tuttigenerated.ServerInterfaceWrapper{
		Handler:          routes,
		ErrorHandlerFunc: requestServerErrorHandler,
	}

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.GetHealth(w, r)
	})

	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.GetHealth(w, r)
	})

	mux.HandleFunc("/v1/track", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.TrackEvents(w, r)
	})

	mux.HandleFunc("/v1/cli/capabilities", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListCliCapabilities(w, r)
	})

	mux.HandleFunc("/v1/cli/commands/{commandID}/invoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.InvokeCliCommand(w, r)
	})

	mux.HandleFunc("/v1/preferences/desktop", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			routes.GetDesktopPreferences(w, r)
		case http.MethodPut:
			routes.PutDesktopPreferences(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/user-projects", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListUserProjects(w, r)
		case http.MethodPost:
			wrapper.UseUserProject(w, r)
		case http.MethodDelete:
			wrapper.DeleteUserProject(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/user-projects/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CheckUserProjectPath(w, r)
	})

	mux.HandleFunc("/v1/events/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.AttachEventStreamWebSocket(w, r)
	})

	mux.HandleFunc("/v1/agent-providers/{provider}/composer-options", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetAgentProviderComposerOptions(w, r)
	})

	mux.HandleFunc("/v1/agent-providers/{provider}/probe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ProbeAgentProvider(w, r)
	})

	mux.HandleFunc("/v1/agent-providers/{provider}/actions/{actionID}/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RunAgentProviderAction(w, r)
	})

	mux.HandleFunc("/v1/agent-providers/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetAgentProviderStatuses(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/providers/{provider}/composer-options", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceAppFactoryProviderComposerOptions(w, r)
	})

	mux.HandleFunc("/v1/workspaces", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			routes.ListWorkspaces(w, r)
		case http.MethodPost:
			routes.CreateWorkspace(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/startup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.GetStartupWorkspace(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetWorkspace(w, r, workspaceID)
		case http.MethodPatch:
			routes.UpdateWorkspace(w, r, workspaceID)
		case http.MethodDelete:
			routes.DeleteWorkspace(w, r, workspaceID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/workbench", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := tuttigenerated.WorkspaceID(r.PathValue("workspaceID"))
		switch r.Method {
		case http.MethodGet:
			routes.GetWorkspaceWorkbench(w, r, workspaceID)
		case http.MethodPut:
			routes.PutWorkspaceWorkbench(w, r, workspaceID)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-context/workspace-app-mentions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceAppMentionCandidates(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/managed-model-providers", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelProviders(w, r, r.PathValue("workspaceID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/managed-model-providers/{providerID}", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelProvider(w, r, r.PathValue("workspaceID"), r.PathValue("providerID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/managed-model-providers/{providerID}/test", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelProviderTest(w, r, r.PathValue("workspaceID"), r.PathValue("providerID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/managed-model-providers/{providerID}/models", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelProviderModels(w, r, r.PathValue("workspaceID"), r.PathValue("providerID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/managed-model-grants", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelGrants(w, r, r.PathValue("workspaceID"), r.PathValue("appID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/managed-model-grants/exchange", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelGrantExchange(w, r, r.PathValue("workspaceID"), r.PathValue("appID"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/managed-model-grants/{grantRef}/models", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelGrantModels(w, r, r.PathValue("workspaceID"), r.PathValue("appID"), r.PathValue("grantRef"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/managed-model-grants/{grantRef}/credentials", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelGrantCredential(w, r, r.PathValue("workspaceID"), r.PathValue("appID"), r.PathValue("grantRef"))
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/apps/{appID}/managed-model-grants/{grantRef}", func(w http.ResponseWriter, r *http.Request) {
		routes.HandleManagedModelGrant(w, r, r.PathValue("workspaceID"), r.PathValue("appID"), r.PathValue("grantRef"))
	})

	registerWorkspaceAppRoutes(mux, wrapper)

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceAppFactoryJobs(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceAppFactoryJob(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceAppFactoryJob(w, r)
		case http.MethodDelete:
			wrapper.DeleteWorkspaceAppFactoryJob(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelWorkspaceAppFactoryJob(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/retry-validation", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RetryWorkspaceAppFactoryJobValidation(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/fix", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.FixWorkspaceAppFactoryJob(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/prepare-modification", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.PrepareWorkspaceAppFactoryJobModification(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/app-factory/jobs/{jobID}/publish", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.PublishWorkspaceAppFactoryJob(w, r)
	})

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

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelWorkspaceAgentSession(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/input", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SendWorkspaceAgentSessionInput(w, r)
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

	mux.HandleFunc("/v1/workspaces/{workspaceID}/git-branches", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceGitBranches(w, r)
	})

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

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceTerminals(w, r)
		case http.MethodPost:
			wrapper.CreateWorkspaceTerminal(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals/{terminalID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetWorkspaceTerminal(w, r)
		case http.MethodDelete:
			wrapper.TerminateWorkspaceTerminal(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals/{terminalID}/close-guard", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CheckWorkspaceTerminalCloseGuard(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals/{terminalID}/resize", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ResizeWorkspaceTerminal(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals/{terminalID}/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceTerminalSnapshot(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/terminals/{terminalID}/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.AttachWorkspaceTerminalWebSocket(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/directory", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListWorkspaceFileDirectory(w, r)
		case http.MethodPut:
			wrapper.CreateWorkspaceFileDirectory(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/tree-snapshot", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetWorkspaceFileTreeSnapshot(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/recent", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListWorkspaceRecentFiles(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SearchWorkspaceFiles(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/file", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CreateWorkspaceFile(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/file/preview", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ReadWorkspaceFilePreview(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/file/text", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.WriteWorkspaceFileText(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/entry", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.DeleteWorkspaceFileEntry(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/entry/move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.MoveWorkspaceFileEntry(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/entry/rename", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RenameWorkspaceFileEntry(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/entry/copy", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CopyWorkspaceFileEntry(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.UploadWorkspaceFiles(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/files/upload/preflight", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.PreflightUploadWorkspaceFiles(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		routes.OpenWorkspace(w, r, tuttigenerated.WorkspaceID(r.PathValue("workspaceID")))
	})
}
