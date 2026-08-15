package api

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestDaemonAPIGeneratedRoutesCancelExactAgentTurn(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			cancelTurnFn: func(_ context.Context, workspaceID string, agentSessionID string, turnID string) (agentservice.CancelTurnResult, error) {
				if workspaceID != "ws-1" || agentSessionID != "session-1" || turnID != "turn-1" {
					t.Fatalf("workspace/session/turn = %q/%q/%q", workspaceID, agentSessionID, turnID)
				}
				return agentservice.CancelTurnResult{
					Canceled: true,
					Reason:   agentservice.CancelTurnReasonTurnCanceled,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/turns/turn-1/cancel",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentTurnCancelResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Cancel.Canceled || response.Cancel.Reason != tuttigenerated.TurnCanceled {
		t.Fatalf("cancel = %#v", response.Cancel)
	}
}

func TestDaemonAPIGeneratedRoutesSendAgentSessionInputForwardsGuidance(t *testing.T) {
	mux := http.NewServeMux()
	updatedAt := time.UnixMilli(1000)
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			sendInputFn: func(_ context.Context, workspaceID string, agentSessionID string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
				if workspaceID != "ws-1" || agentSessionID != "agent-session-1" {
					t.Fatalf("workspace/session = %q/%q", workspaceID, agentSessionID)
				}
				if !input.Guidance {
					t.Fatal("input guidance = false, want true")
				}
				if input.TurnID != "turn-target" {
					t.Fatalf("input turn id = %q, want turn-target", input.TurnID)
				}
				if input.ClientSubmitID != "submit-1" {
					t.Fatalf("client submit id = %q, want submit-1", input.ClientSubmitID)
				}
				if _, ok := input.Metadata["clientSubmitId"]; ok {
					t.Fatalf("client submit id leaked into diagnostics metadata: %#v", input.Metadata)
				}
				if len(input.CapabilityRefs) != 1 || input.CapabilityRefs[0] != (agentservice.CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
					t.Fatalf("input capability refs = %#v", input.CapabilityRefs)
				}
				if len(input.Content) != 1 || input.Content[0].Text != "guide current turn" {
					t.Fatalf("input content = %#v", input.Content)
				}
				return agentservice.SendInputResult{
					Kind: "turn",
					Session: agentservice.Session{
						ID:        agentSessionID,
						Provider:  "codex",
						Visible:   true,
						CreatedAt: time.UnixMilli(1000),
						UpdatedAt: &updatedAt,
					},
					TurnID: "turn-guidance",
					Turn: &agentactivitybiz.Turn{
						WorkspaceID: "ws-1", AgentSessionID: agentSessionID, TurnID: "turn-guidance",
						Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: agentactivitybiz.TurnOriginUserPrompt,
						StartedAtUnixMS: 1000, UpdatedAtUnixMS: 1000,
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
		map[string]any{
			"clientSubmitId": "submit-1",
			"capabilityRefs": []map[string]any{{
				"capability": "tutti",
				"source":     "slash_command",
			}},
			"content": []map[string]any{{
				"type": "text",
				"text": "guide current turn",
			}},
			"guidance": true,
			"turnId":   "turn-target",
		},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response tuttigenerated.SendWorkspaceAgentSessionInputResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	turnResponse, err := response.AsSendWorkspaceAgentSessionInputTurnResponse()
	if err != nil {
		t.Fatalf("decode turn response: %v", err)
	}
	if turnResponse.TurnId != "turn-guidance" || turnResponse.Turn.TurnId != "turn-guidance" {
		t.Fatalf("turn response = %#v, want exact guidance turn", turnResponse)
	}
}

func TestDaemonAPIGeneratedRoutesMapsMissingGuidanceTarget(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			sendInputFn: func(_ context.Context, _, _ string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
				if !input.Guidance || input.TurnID != "" {
					t.Fatalf("guidance input = %#v, want missing target", input)
				}
				return agentservice.SendInputResult{}, agentservice.ErrActiveTurnTargetRequired
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t, mux, http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
		map[string]any{
			"content":  []map[string]any{{"type": "text", "text": "stale guidance"}},
			"guidance": true,
		},
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	assertGeneratedRouteError(t, recorder, tuttigenerated.InvalidRequest, "agent.active_turn_target_required", "active-turn guidance requires an exact target turn")
}

func TestDaemonAPIGeneratedRoutesMapsMismatchedGuidanceTarget(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			sendInputFn: func(_ context.Context, _, _ string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
				if input.TurnID != "turn-stale" {
					t.Fatalf("guidance target = %q, want turn-stale", input.TurnID)
				}
				return agentservice.SendInputResult{}, agentservice.ErrActiveTurnTargetMismatch
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t, mux, http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
		map[string]any{
			"content":  []map[string]any{{"type": "text", "text": "stale guidance"}},
			"guidance": true,
			"turnId":   "turn-stale",
		},
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	assertGeneratedRouteError(t, recorder, tuttigenerated.InvalidRequest, "agent.active_turn_target_mismatch", "active-turn guidance target is no longer active")
}

func TestDaemonAPIGeneratedRoutesSendTypedGoalReturnsOperationWithoutTurn(t *testing.T) {
	mux := http.NewServeMux()
	updatedAt := time.UnixMilli(1000)
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			sendInputFn: func(_ context.Context, _, agentSessionID string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
				if len(input.Content) != 1 || input.Content[0].Text != "/goal clear" {
					t.Fatalf("input content = %#v", input.Content)
				}
				goalState := agentactivitybiz.SessionGoalState{
					AgentSessionID: agentSessionID,
					Revision:       2,
					SyncStatus:     agentactivitybiz.GoalSyncStatusApplying,
				}
				goalResult := agentservice.GoalControlSessionResult{
					OperationID: "goal-op-2",
					GoalState:   &goalState,
				}
				return agentservice.SendInputResult{
					Kind: "goalControl",
					Session: agentservice.Session{
						ID: agentSessionID, Provider: "claude-code", Visible: true,
						CreatedAt: time.UnixMilli(1000), UpdatedAt: &updatedAt,
					},
					GoalControl: &goalResult,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
		map[string]any{"content": []map[string]any{{"type": "text", "text": "/goal clear"}}},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response tuttigenerated.SendWorkspaceAgentSessionInputResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	goalResponse, err := response.AsSendWorkspaceAgentSessionInputGoalControlResponse()
	if err != nil {
		t.Fatalf("decode goal-control response: %v", err)
	}
	if goalResponse.Kind != tuttigenerated.SendWorkspaceAgentSessionInputGoalControlResponseKindGoalControl {
		t.Fatalf("kind = %q, want goalControl", goalResponse.Kind)
	}
	if goalResponse.OperationId == nil || *goalResponse.OperationId != "goal-op-2" {
		t.Fatalf("operationId = %v, want goal-op-2", goalResponse.OperationId)
	}
	if goalResponse.GoalState == nil || goalResponse.GoalState.Revision != 2 {
		t.Fatalf("goalState = %#v", goalResponse.GoalState)
	}
}

func TestDaemonAPIGeneratedRoutesSendTurnRejectsMissingExactTurn(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			sendInputFn: func(_ context.Context, _, agentSessionID string, _ agentservice.SendInput) (agentservice.SendInputResult, error) {
				return agentservice.SendInputResult{
					Kind: "turn", TurnID: "turn-missing",
					Session: agentservice.Session{ID: agentSessionID, Provider: "codex", Visible: true, CreatedAt: time.UnixMilli(1000)},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
		map[string]any{"content": []map[string]any{{"type": "text", "text": "hello"}}},
	)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesRejectsUnsupportedAgentCapabilityReferences(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		path   string
		body   map[string]any
	}{
		{
			name:   "create",
			method: http.MethodPost,
			path:   "/v1/workspaces/ws-1/agent-sessions",
			body: map[string]any{
				"agentSessionId": "11111111-1111-4111-8111-111111111111",
				"agentTargetId":  agenttargetbiz.IDLocalCodex,
				"clientSubmitId": "submit-1",
				"capabilityRefs": []map[string]any{{"capability": "other", "source": "slash_command"}},
			},
		},
		{
			name:   "send",
			method: http.MethodPost,
			path:   "/v1/workspaces/ws-1/agent-sessions/agent-session-1/input",
			body: map[string]any{
				"clientSubmitId": "submit-1",
				"capabilityRefs": []map[string]any{{"capability": "tutti", "source": "other"}},
				"content":        []map[string]any{{"type": "text", "text": "hello"}},
			},
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					createFn: func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error) {
						t.Fatal("Create should not be called for unsupported capability refs")
						return agentservice.Session{}, nil
					},
					sendInputFn: func(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error) {
						t.Fatal("SendInput should not be called for unsupported capability refs")
						return agentservice.SendInputResult{}, nil
					},
				},
			}))

			recorder := performGeneratedRouteRequest(t, mux, tt.method, tt.path, tt.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
			}
		})
	}
}

func TestDaemonAPIGeneratedRoutesCreateAgentSessionRejectsMissingAgentTarget(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			createFn: func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error) {
				t.Fatal("Create should not be called when agentTargetId is missing")
				return agentservice.Session{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/agent-sessions", map[string]any{
		"agentSessionId": "11111111-1111-4111-8111-111111111111",
		"initialContent": []map[string]any{{"type": "text", "text": "hello"}},
		"clientSubmitId": "submit-1",
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		apierrors.ReasonMalformedRequest,
		"agentTargetId is required",
	)
}

func TestDaemonAPIGeneratedRoutesCreateAgentSessionAllowsTargetOnlyRequest(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			createFn: func(_ context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.AgentTargetID != agenttargetbiz.IDLocalCodex {
					t.Fatalf("agent target id = %q, want %s", input.AgentTargetID, agenttargetbiz.IDLocalCodex)
				}
				if input.Provider != "" {
					t.Fatalf("provider = %q, want empty pre-service target-only authority", input.Provider)
				}
				if input.Isolation != agentservice.WorktreeIsolationMode {
					t.Fatalf("isolation = %q, want worktree", input.Isolation)
				}
				if input.ModelExplicit == nil || *input.ModelExplicit {
					t.Fatalf("model explicit = %#v, want false", input.ModelExplicit)
				}
				if input.ReasoningEffortExplicit == nil || *input.ReasoningEffortExplicit {
					t.Fatalf("reasoning explicit = %#v, want false", input.ReasoningEffortExplicit)
				}
				return agentservice.Session{
					ID:            input.AgentSessionID,
					AgentTargetID: input.AgentTargetID,
					Provider:      "codex",
					CreatedAt:     createdAt,
					Isolation: &agentservice.SessionIsolation{
						Mode:         agentservice.WorktreeIsolationMode,
						WorktreePath: "/state/worktrees/session",
						Branch:       "tutti/session",
						BaseCommit:   "abc123",
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/agent-sessions", map[string]any{
		"agentSessionId":          "11111111-1111-4111-8111-111111111111",
		"agentTargetId":           agenttargetbiz.IDLocalCodex,
		"isolation":               "worktree",
		"modelExplicit":           false,
		"reasoningEffortExplicit": false,
		"initialContent":          []map[string]any{{"type": "text", "text": "hello"}},
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Session.AgentTargetId == nil || *response.Session.AgentTargetId != agenttargetbiz.IDLocalCodex {
		t.Fatalf("session agent target id = %#v, want %s", response.Session.AgentTargetId, agenttargetbiz.IDLocalCodex)
	}
	if response.Session.Isolation == nil ||
		response.Session.Isolation.Mode != tuttigenerated.WorkspaceAgentSessionIsolationModeWorktree ||
		response.Session.Isolation.WorktreePath != "/state/worktrees/session" {
		t.Fatalf("session isolation = %#v", response.Session.Isolation)
	}
}

func TestDaemonAPIGeneratedRoutesCreateAgentSessionMapsTypedInitialGoal(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			createFn: func(_ context.Context, _ string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
				if input.InitialGoalControl == nil ||
					input.InitialGoalControl.Action != "set" ||
					input.InitialGoalControl.Objective != "ship it" {
					t.Fatalf("initial goal control = %#v", input.InitialGoalControl)
				}
				if len(input.InitialContent) != 0 {
					t.Fatalf("initial content = %#v, want empty", input.InitialContent)
				}
				return agentservice.Session{
					ID:            input.AgentSessionID,
					AgentTargetID: input.AgentTargetID,
					Provider:      "codex",
					CreatedAt:     createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/agent-sessions", map[string]any{
		"agentSessionId":     "11111111-1111-4111-8111-111111111111",
		"agentTargetId":      agenttargetbiz.IDLocalCodex,
		"clientSubmitId":     "goal-submit-1",
		"initialContent":     []map[string]any{},
		"initialGoalControl": map[string]any{"action": "set", "objective": "ship it"},
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesUpdateAgentSessionPin(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			updatePinFn: func(_ context.Context, workspaceID string, agentSessionID string, pinned bool) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if !pinned {
					t.Fatal("pinned = false, want true")
				}
				return agentservice.Session{
					ID:             agentSessionID,
					Provider:       "codex",
					PinnedAtUnixMS: 1700000000000,
					CreatedAt:      createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/pin",
		map[string]any{"pinned": true},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Session.PinnedAtUnixMs == nil || *response.Session.PinnedAtUnixMs != 1700000000000 {
		t.Fatalf("pinnedAtUnixMs = %#v", response.Session.PinnedAtUnixMs)
	}
}

func TestDaemonAPIGeneratedRoutesUpdateAgentSessionTitle(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	title := "Renamed conversation"
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			updateTitleFn: func(_ context.Context, workspaceID string, agentSessionID string, nextTitle string) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if nextTitle != title {
					t.Fatalf("title = %q, want %q", nextTitle, title)
				}
				return agentservice.Session{
					ID:        agentSessionID,
					Provider:  "codex",
					Title:     &nextTitle,
					CreatedAt: createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/title",
		map[string]any{"title": title},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Session.Title == nil || *response.Session.Title != title {
		t.Fatalf("title = %#v, want %q", response.Session.Title, title)
	}
}

func TestDaemonAPIGeneratedRoutesUpdateAgentSessionVisibility(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			updateVisibleFn: func(_ context.Context, workspaceID string, agentSessionID string, visible bool) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if !visible {
					t.Fatal("visible = false, want true")
				}
				return agentservice.Session{
					ID:        agentSessionID,
					Provider:  "claude-code",
					Visible:   visible,
					CreatedAt: createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/visibility",
		map[string]any{"visible": true},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Session.Visible {
		t.Fatal("response visible = false, want true")
	}
}

func TestDaemonAPIGeneratedRoutesDeleteAgentSession(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			deleteFn: func(_ context.Context, workspaceID string, agentSessionID string) (agentservice.DeleteSessionResult, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "agent-session-1" {
					t.Fatalf("agentSessionID = %q, want agent-session-1", agentSessionID)
				}
				return agentservice.DeleteSessionResult{Removed: true, CleanupFailed: true}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.DeleteWorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Removed {
		t.Fatal("removed = false, want true")
	}
	if !response.CleanupFailed {
		t.Fatal("cleanupFailed = false, want true")
	}
}

func TestDaemonAPIGeneratedRoutesClearAgentSessions(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			clearFn: func(_ context.Context, workspaceID string) (agentservice.ClearSessionsResult, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				return agentservice.ClearSessionsResult{
					RemovedMessages: 5, RemovedSessions: 2,
					CleanupFailedSessionIDs: []string{"session-2"},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-1/agent-sessions",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.ClearWorkspaceAgentSessionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.RemovedSessions != 2 || response.RemovedMessages != 5 {
		t.Fatalf("response = %#v, want 2 sessions and 5 messages", response)
	}
	if !slices.Equal(response.CleanupFailedSessionIds, []string{"session-2"}) {
		t.Fatalf("cleanupFailedSessionIds = %#v, want session-2", response.CleanupFailedSessionIds)
	}
}
