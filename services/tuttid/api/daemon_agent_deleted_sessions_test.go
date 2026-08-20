package api

import (
	"context"
	"net/http"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentmaintenance "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
)

type stubWorkspaceDeletedAgentSessionService struct {
	stubAgentSessionService
	listDeletedFn    func(context.Context, string, agentservice.ListDeletedSessionsInput) (agentservice.DeletedSessionPage, error)
	restoreDeletedFn func(context.Context, string, string) (agentservice.RestoreDeletedSessionResult, error)
}

func (s stubWorkspaceDeletedAgentSessionService) ListDeletedSessions(
	ctx context.Context,
	workspaceID string,
	input agentservice.ListDeletedSessionsInput,
) (agentservice.DeletedSessionPage, error) {
	if s.listDeletedFn == nil {
		return agentservice.DeletedSessionPage{}, nil
	}
	return s.listDeletedFn(ctx, workspaceID, input)
}

func (s stubWorkspaceDeletedAgentSessionService) RestoreDeletedSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (agentservice.RestoreDeletedSessionResult, error) {
	if s.restoreDeletedFn == nil {
		return agentservice.RestoreDeletedSessionResult{}, nil
	}
	return s.restoreDeletedFn(ctx, workspaceID, agentSessionID)
}

func TestDaemonAPIListsWorkspaceDeletedAgentSessions(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubWorkspaceDeletedAgentSessionService{
			listDeletedFn: func(_ context.Context, workspaceID string, input agentservice.ListDeletedSessionsInput) (agentservice.DeletedSessionPage, error) {
				if workspaceID != "ws-1" || input.SearchQuery != "hello" || input.Cursor != "20|session-0" || input.Limit != 25 {
					t.Fatalf("workspace/input = %q/%#v", workspaceID, input)
				}
				if input.RailSectionKey == nil || *input.RailSectionKey != "conversations" {
					t.Fatalf("rail section key = %#v, want conversations", input.RailSectionKey)
				}
				return agentservice.DeletedSessionPage{
					Sessions: []agentservice.DeletedSessionSummary{{
						AgentSessionID: "session-1", Title: "Hello", UpdatedAtUnixMS: 20,
						RailSectionKey:  "conversations",
						DeletedAtUnixMS: 30, Restorable: false, UnavailableReason: "legacyDataUnavailable",
					}},
					ProjectOptions: []agentservice.DeletedSessionProjectOption{{
						RailSectionKey: "project:/projects/tutti", ProjectPath: "/projects/tutti",
						ProjectLabel: "tutti", ProjectAvailable: false,
					}},
					TotalCount: 1, WorkspaceTotalCount: 3, HasMore: true, NextCursor: "10|session-2",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/deleted-agent-sessions?searchQuery=hello&railSectionKey=conversations&cursor=20%7Csession-0&limit=25",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.WorkspaceDeletedAgentSessionListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Sessions) != 1 || response.Sessions[0].RailSectionKey != "conversations" || response.Sessions[0].ProjectPath != nil || response.Sessions[0].UnavailableReason == nil {
		t.Fatalf("sessions = %#v", response.Sessions)
	}
	if response.TotalCount != 1 || response.WorkspaceTotalCount != 3 || !response.HasMore || response.NextCursor == nil {
		t.Fatalf("page = %#v", response)
	}
	if len(response.ProjectOptions) != 1 || response.ProjectOptions[0].RailSectionKey != "project:/projects/tutti" || response.ProjectOptions[0].ProjectAvailable {
		t.Fatalf("project options = %#v", response.ProjectOptions)
	}
}

func TestDaemonAPIRejectsAmbiguousDeletedSessionProjectFilter(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubWorkspaceDeletedAgentSessionService{},
	}))
	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/deleted-agent-sessions?railSectionKey=conversations&projectPath=%2Fprojects%2Ftutti",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIRestoresWorkspaceDeletedAgentSession(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubWorkspaceDeletedAgentSessionService{
			restoreDeletedFn: func(_ context.Context, workspaceID string, agentSessionID string) (agentservice.RestoreDeletedSessionResult, error) {
				if workspaceID != "ws-1" || agentSessionID != "session-1" {
					t.Fatalf("workspace/session = %q/%q", workspaceID, agentSessionID)
				}
				return agentservice.RestoreDeletedSessionResult{Restored: true}, nil
			},
		},
	}))
	recorder := performGeneratedRouteRequest(
		t, mux, http.MethodPost,
		"/v1/workspaces/ws-1/deleted-agent-sessions/session-1/restore", nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.RestoreWorkspaceDeletedAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.AgentSessionId != "session-1" || !response.Restored {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIMapsUnavailableDeletedSessionRestoreToConflict(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubWorkspaceDeletedAgentSessionService{
			restoreDeletedFn: func(context.Context, string, string) (agentservice.RestoreDeletedSessionResult, error) {
				return agentservice.RestoreDeletedSessionResult{}, agenthost.ErrDeletedSessionNotRestorable
			},
		},
	}))
	recorder := performGeneratedRouteRequest(
		t, mux, http.MethodPost,
		"/v1/workspaces/ws-1/deleted-agent-sessions/session-1/restore", nil,
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIPurgesWorkspaceDeletedAgentSessionsThroughMaintenanceGate(t *testing.T) {
	result := agentmaintenance.PurgeResult{RemovedSessions: 2, RemovedMessages: 5, PayloadBytes: 128}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentMaintenanceService: stubAgentMaintenanceService{
			purgeWorkspaceFn: func(_ context.Context, workspaceID string) (agentmaintenance.PurgeResult, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspace = %q", workspaceID)
				}
				return result, nil
			},
			purgeSessionFn: func(_ context.Context, workspaceID string, agentSessionID string) (agentmaintenance.PurgeResult, error) {
				if workspaceID != "ws-1" || agentSessionID != "session-1" {
					t.Fatalf("workspace/session = %q/%q", workspaceID, agentSessionID)
				}
				return result, nil
			},
		},
	}))
	for _, path := range []string{
		"/v1/workspaces/ws-1/deleted-agent-sessions",
		"/v1/workspaces/ws-1/deleted-agent-sessions/session-1",
	} {
		recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete, path, nil)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d; body: %s", path, recorder.Code, recorder.Body.String())
		}
		var response tuttigenerated.DeletedAgentConversationPurgeResult
		decodeGeneratedRouteResponse(t, recorder, &response)
		if response.RemovedSessions != 2 || response.RemovedMessages != 5 || response.PayloadBytes != 128 {
			t.Fatalf("response = %#v", response)
		}
	}
}

func TestDaemonAPIMapsWorkspaceDeletedAgentSessionPurgeBusy(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentMaintenanceService: stubAgentMaintenanceService{err: agentmaintenance.ErrBusy},
	}))
	for _, path := range []string{
		"/v1/workspaces/ws-1/deleted-agent-sessions",
		"/v1/workspaces/ws-1/deleted-agent-sessions/session-1",
	} {
		recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete, path, nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d; body: %s", path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestDaemonAPIMapsMissingDeletedAgentSession(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubWorkspaceDeletedAgentSessionService{
			restoreDeletedFn: func(context.Context, string, string) (agentservice.RestoreDeletedSessionResult, error) {
				return agentservice.RestoreDeletedSessionResult{}, agenthost.ErrDeletedSessionNotFound
			},
		},
		AgentMaintenanceService: stubAgentMaintenanceService{err: agenthost.ErrDeletedSessionNotFound},
	}))
	requests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/v1/workspaces/ws-1/deleted-agent-sessions/missing/restore"},
		{http.MethodDelete, "/v1/workspaces/ws-1/deleted-agent-sessions/missing"},
	}
	for _, request := range requests {
		recorder := performGeneratedRouteRequest(t, mux, request.method, request.path, nil)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d; body: %s", request.path, recorder.Code, recorder.Body.String())
		}
	}
}
