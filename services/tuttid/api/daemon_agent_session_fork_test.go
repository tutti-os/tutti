package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestForkWorkspaceAgentSessionPreservesExactThroughTurnIdentity(t *testing.T) {
	var observedWorkspaceID, observedSourceID string
	var observedInput agentservice.ForkSessionInput
	service := stubAgentSessionService{
		forkFn: func(
			_ context.Context,
			workspaceID, sourceID string,
			input agentservice.ForkSessionInput,
		) (agentservice.SessionForkOperation, error) {
			observedWorkspaceID, observedSourceID, observedInput = workspaceID, sourceID, input
			now := time.UnixMilli(100)
			session := agentservice.Session{
				ID: input.TargetAgentSessionID, Kind: storesqlite.SessionKindRoot,
				Provider: "codex", RailSectionKey: "conversations", CreatedAt: now,
				LifecycleCapabilities: agentservice.SessionLifecycleCapabilities{
					ForkThroughTurn: true,
				},
			}
			lineage := agentservice.SessionForkLineage{
				SourceAgentSessionID: sourceID, SourceTurnID: input.ThroughTurnID,
				TargetTurnID: "target-turn-7",
				OperationID:  "operation-1", ForkedAtUnixMS: 100,
			}
			return agentservice.SessionForkOperation{
				OperationID: "operation-1", RequestID: input.RequestID,
				SourceAgentSessionID: sourceID,
				TargetAgentSessionID: input.TargetAgentSessionID,
				Point: agentservice.SessionForkPoint{
					Type: "throughTurn", TurnID: input.ThroughTurnID,
				},
				Status:  agentservice.SessionForkOperationCommitted,
				Phase:   "committed",
				Session: &session, Lineage: &lineage,
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: service,
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/fork",
		map[string]any{
			"targetAgentSessionId": "f0f21d94-af7c-4bdd-8f24-bffd169474bc",
			"requestId":            "request-1",
			"point": map[string]any{
				"type": "throughTurn", "turnId": "turn-7",
			},
		},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if observedWorkspaceID != "workspace-1" || observedSourceID != "source-1" ||
		observedInput.TargetAgentSessionID != "f0f21d94-af7c-4bdd-8f24-bffd169474bc" ||
		observedInput.RequestID != "request-1" ||
		observedInput.ThroughTurnID != "turn-7" {
		t.Fatalf(
			"fork identity = workspace=%q source=%q input=%#v",
			observedWorkspaceID,
			observedSourceID,
			observedInput,
		)
	}
	var body struct {
		Operation struct {
			OperationID string `json:"operationId"`
			Status      string `json:"status"`
			Phase       string `json:"phase"`
			Session     *struct {
				ID                    string `json:"id"`
				LifecycleCapabilities struct {
					ForkThroughTurn bool `json:"forkThroughTurn"`
				} `json:"lifecycleCapabilities"`
			} `json:"session"`
			Lineage *struct {
				SourceTurnID string `json:"sourceTurnId"`
				TargetTurnID string `json:"targetTurnId"`
			} `json:"lineage"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Operation.OperationID != "operation-1" ||
		body.Operation.Status != "committed" ||
		body.Operation.Phase != "committed" ||
		body.Operation.Session == nil ||
		body.Operation.Session.ID != "f0f21d94-af7c-4bdd-8f24-bffd169474bc" ||
		!body.Operation.Session.LifecycleCapabilities.ForkThroughTurn ||
		body.Operation.Lineage == nil ||
		body.Operation.Lineage.SourceTurnID != "turn-7" ||
		body.Operation.Lineage.TargetTurnID != "target-turn-7" {
		t.Fatalf("operation response=%#v", body.Operation)
	}
}

func TestForkWorkspaceAgentSessionUnsupportedIsConflict(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			forkFn: func(
				context.Context,
				string,
				string,
				agentservice.ForkSessionInput,
			) (agentservice.SessionForkOperation, error) {
				return agentservice.SessionForkOperation{}, agentservice.ErrSessionForkUnsupported
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/fork",
		map[string]any{
			"targetAgentSessionId": "f0f21d94-af7c-4bdd-8f24-bffd169474bc",
			"requestId":            "request-1",
			"point": map[string]any{
				"type": "throughTurn", "turnId": "turn-7",
			},
		},
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestForkWorkspaceAgentSessionReportsBoundaryRejectionReason(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			forkFn: func(
				context.Context,
				string,
				string,
				agentservice.ForkSessionInput,
			) (agentservice.SessionForkOperation, error) {
				boundaryErr := &storesqlite.SessionForkBoundaryError{
					Reason: storesqlite.SessionForkBoundaryReasonTurnSequenceUnverified,
				}
				return agentservice.SessionForkOperation{}, fmt.Errorf(
					"%w: %w",
					agentservice.ErrSessionForkConflict,
					boundaryErr,
				)
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/fork",
		map[string]any{
			"targetAgentSessionId": "f0f21d94-af7c-4bdd-8f24-bffd169474bc",
			"requestId":            "request-1",
			"point": map[string]any{
				"type": "throughTurn", "turnId": "turn-7",
			},
		},
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", recorder.Code, recorder.Body.String())
	}
	var body tuttigenerated.ApiErrorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Reason == nil || *body.Error.Reason != "agent_session_fork_conflict" {
		t.Fatalf("reason=%v", body.Error.Reason)
	}
	if body.Error.Params == nil ||
		(*body.Error.Params)["forkBoundaryReason"] !=
			string(storesqlite.SessionForkBoundaryReasonTurnSequenceUnverified) {
		t.Fatalf("params=%v", body.Error.Params)
	}
	if body.Error.DeveloperMessage == nil ||
		!strings.Contains(*body.Error.DeveloperMessage, storesqlite.ErrSessionForkTurnState.Error()) {
		t.Fatalf("developerMessage=%v", body.Error.DeveloperMessage)
	}
}

func TestForkWorkspaceAgentSessionReturnsDurableOutcomesAsOperationSnapshots(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     agentservice.SessionForkOperationStatus
		errorValue string
		wantHTTP   int
	}{
		{name: "accepted", status: agentservice.SessionForkOperationAccepted, wantHTTP: http.StatusAccepted},
		{name: "failed", status: agentservice.SessionForkOperationFailed, errorValue: "provider rejected fork", wantHTTP: http.StatusOK},
		{name: "unknown", status: agentservice.SessionForkOperationUnknown, errorValue: "delivery outcome unknown", wantHTTP: http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					forkFn: func(
						context.Context,
						string,
						string,
						agentservice.ForkSessionInput,
					) (agentservice.SessionForkOperation, error) {
						var operationError *string
						if test.errorValue != "" {
							value := test.errorValue
							operationError = &value
						}
						return agentservice.SessionForkOperation{
							OperationID: "operation-1", RequestID: "request-1",
							SourceAgentSessionID: "source-1",
							TargetAgentSessionID: "f0f21d94-af7c-4bdd-8f24-bffd169474bc",
							Point: agentservice.SessionForkPoint{
								Type: "throughTurn", TurnID: "turn-7",
							},
							Status: test.status, Error: operationError,
						}, nil
					},
				},
			}))

			recorder := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodPost,
				"/v1/workspaces/workspace-1/agent-sessions/source-1/fork",
				map[string]any{
					"targetAgentSessionId": "f0f21d94-af7c-4bdd-8f24-bffd169474bc",
					"requestId":            "request-1",
					"point": map[string]any{
						"type": "throughTurn", "turnId": "turn-7",
					},
				},
			)
			if recorder.Code != test.wantHTTP {
				t.Fatalf(
					"status=%d, want %d; body=%s",
					recorder.Code,
					test.wantHTTP,
					recorder.Body.String(),
				)
			}
			var body struct {
				Operation struct {
					Status string  `json:"status"`
					Error  *string `json:"error"`
				} `json:"operation"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Operation.Status != string(test.status) {
				t.Fatalf("operation=%#v", body.Operation)
			}
			if test.errorValue != "" &&
				(body.Operation.Error == nil || *body.Operation.Error != test.errorValue) {
				t.Fatalf("operation error=%#v", body.Operation.Error)
			}
		})
	}
}

func TestGetWorkspaceAgentSessionForkOperationReturnsDurableSnapshot(t *testing.T) {
	var observedWorkspaceID, observedOperationID string
	acknowledgeCalls := 0
	now := time.UnixMilli(200)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			getSessionForkOperationFn: func(
				_ context.Context,
				workspaceID, operationID string,
			) (agentservice.SessionForkOperation, error) {
				observedWorkspaceID, observedOperationID = workspaceID, operationID
				lineage := agentservice.SessionForkLineage{
					SourceAgentSessionID: "source-1",
					SourceTurnID:         "turn-7",
					TargetTurnID:         "target-turn-7",
					OperationID:          operationID,
					ForkedAtUnixMS:       200,
				}
				session := agentservice.Session{
					ID: "target-1", Kind: storesqlite.SessionKindRoot,
					Provider: "codex", RailSectionKey: "conversations",
					CreatedAt: now, ForkedFrom: &lineage,
				}
				return agentservice.SessionForkOperation{
					OperationID: operationID, RequestID: "request-1",
					SourceAgentSessionID: "source-1", TargetAgentSessionID: "target-1",
					Point: agentservice.SessionForkPoint{
						Type: "throughTurn", TurnID: "turn-7",
					},
					Status:  agentservice.SessionForkOperationCommitted,
					Session: &session,
					Lineage: &lineage,
				}, nil
			},
			acknowledgeSessionForkOperationFn: func(
				context.Context,
				string,
				string,
			) (agentservice.SessionForkOperation, error) {
				acknowledgeCalls++
				return agentservice.SessionForkOperation{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/workspace-1/agent-session-fork-operations/operation-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if observedWorkspaceID != "workspace-1" || observedOperationID != "operation-1" {
		t.Fatalf(
			"lookup identity=workspace %q operation %q",
			observedWorkspaceID,
			observedOperationID,
		)
	}
	if acknowledgeCalls != 0 {
		t.Fatalf("GET implicitly acknowledged operation %d times", acknowledgeCalls)
	}
	var body struct {
		Operation struct {
			Status  string `json:"status"`
			Session *struct {
				ForkedFrom *struct {
					TargetTurnID string `json:"targetTurnId"`
				} `json:"forkedFrom"`
			} `json:"session"`
			Lineage *struct {
				TargetTurnID string `json:"targetTurnId"`
			} `json:"lineage"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Operation.Status != "committed" ||
		body.Operation.Session == nil ||
		body.Operation.Session.ForkedFrom == nil ||
		body.Operation.Session.ForkedFrom.TargetTurnID != "target-turn-7" ||
		body.Operation.Lineage == nil ||
		body.Operation.Lineage.TargetTurnID != "target-turn-7" {
		t.Fatalf("operation response=%#v", body.Operation)
	}
}

func TestAcknowledgeWorkspaceAgentSessionForkOperationReturnsDurableSnapshot(t *testing.T) {
	var observedWorkspaceID, observedOperationID string
	now := time.UnixMilli(200)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			acknowledgeSessionForkOperationFn: func(
				_ context.Context,
				workspaceID, operationID string,
			) (agentservice.SessionForkOperation, error) {
				observedWorkspaceID, observedOperationID = workspaceID, operationID
				session := agentservice.Session{
					ID: "target-1", Kind: storesqlite.SessionKindRoot,
					Provider: "codex", RailSectionKey: "conversations",
					CreatedAt: now,
				}
				lineage := agentservice.SessionForkLineage{
					SourceAgentSessionID: "source-1", SourceTurnID: "turn-7",
					TargetTurnID: "target-turn-7",
					OperationID:  operationID, ForkedAtUnixMS: 200,
				}
				session.ForkedFrom = &lineage
				return agentservice.SessionForkOperation{
					OperationID: operationID, RequestID: "request-1",
					SourceAgentSessionID: "source-1",
					TargetAgentSessionID: "target-1",
					Point: agentservice.SessionForkPoint{
						Type: "throughTurn", TurnID: "turn-7",
					},
					Status:  agentservice.SessionForkOperationCommitted,
					Session: &session, Lineage: &lineage,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-session-fork-operations/operation-1/acknowledge",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if observedWorkspaceID != "workspace-1" || observedOperationID != "operation-1" {
		t.Fatalf(
			"acknowledge identity=workspace %q operation %q",
			observedWorkspaceID,
			observedOperationID,
		)
	}
	var body struct {
		Operation struct {
			OperationID string `json:"operationId"`
			Status      string `json:"status"`
			Session     *struct {
				ID         string `json:"id"`
				ForkedFrom *struct {
					TargetTurnID string `json:"targetTurnId"`
				} `json:"forkedFrom"`
			} `json:"session"`
			Lineage *struct {
				TargetTurnID string `json:"targetTurnId"`
			} `json:"lineage"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Operation.OperationID != "operation-1" ||
		body.Operation.Status != "committed" ||
		body.Operation.Session == nil ||
		body.Operation.Session.ID != "target-1" ||
		body.Operation.Session.ForkedFrom == nil ||
		body.Operation.Session.ForkedFrom.TargetTurnID != "target-turn-7" ||
		body.Operation.Lineage == nil ||
		body.Operation.Lineage.TargetTurnID != "target-turn-7" {
		t.Fatalf("operation response=%#v", body.Operation)
	}
}

func TestGetWorkspaceAgentSessionForkOperationNotFound(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			getSessionForkOperationFn: func(
				context.Context,
				string,
				string,
			) (agentservice.SessionForkOperation, error) {
				return agentservice.SessionForkOperation{},
					agentservice.ErrSessionForkOperationNotFound
			},
		},
	}))
	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/workspace-1/agent-session-fork-operations/missing",
		nil,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestAcknowledgeWorkspaceAgentSessionForkOperationNotFound(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			acknowledgeSessionForkOperationFn: func(
				context.Context,
				string,
				string,
			) (agentservice.SessionForkOperation, error) {
				return agentservice.SessionForkOperation{},
					agentservice.ErrSessionForkOperationNotFound
			},
		},
	}))
	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-session-fork-operations/missing/acknowledge",
		nil,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestForkWorkspaceAgentSessionRejectsUnknownPoint(t *testing.T) {
	recorder := httptest.NewRecorder()
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{},
	}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/fork",
		nil,
	)
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
}
