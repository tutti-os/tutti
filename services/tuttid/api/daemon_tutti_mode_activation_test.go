package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

func TestGetTuttiModeActivationReturnsSessionNotFound(t *testing.T) {
	t.Parallel()
	api := DaemonAPI{
		AgentSessionService: stubAgentSessionService{getFn: func(context.Context, string, string) (agentservice.Session, error) {
			return agentservice.Session{}, agentservice.ErrSessionNotFound
		}},
		TuttiModeActivationService: &stubTuttiModeActivationService{},
	}
	response, err := api.GetWorkspaceAgentSessionTuttiModeActivation(context.Background(), tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivationRequestObject{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation404JSONResponse); !ok {
		t.Fatalf("response = %T, want 404", response)
	}
}

func TestUpdateTuttiModeActivationReturnsRevisionConflict(t *testing.T) {
	t.Parallel()
	api := DaemonAPI{
		AgentSessionService: stubAgentSessionService{},
		TuttiModeActivationService: &stubTuttiModeActivationService{setFn: func(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error) {
			return tuttimodeactivationservice.SetResult{}, tuttimodeactivationservice.ErrRevisionConflict
		}},
	}
	expected := int64(1)
	response, err := api.UpdateWorkspaceAgentSessionTuttiModeActivation(context.Background(), tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivationRequestObject{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Body: &tuttigenerated.UpdateTuttiModeActivationRequest{
			Status:           tuttigenerated.TuttiModeActivationStatusInactive,
			Source:           tuttigenerated.TuttiModeActivationSourceBadgeRemove,
			ExpectedRevision: &expected,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.UpdateWorkspaceAgentSessionTuttiModeActivation409JSONResponse); !ok {
		t.Fatalf("response = %T, want 409", response)
	}
}

func TestUpdateTuttiModeActivationRejectsNegativeExpectedRevisionAtTransportBoundary(t *testing.T) {
	t.Parallel()
	api := DaemonAPI{
		AgentSessionService: stubAgentSessionService{getFn: func(context.Context, string, string) (agentservice.Session, error) {
			t.Fatal("Get should not be called for a negative expectedRevision")
			return agentservice.Session{}, nil
		}},
		TuttiModeActivationService: &stubTuttiModeActivationService{setFn: func(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error) {
			t.Fatal("Set should not be called for a negative expectedRevision")
			return tuttimodeactivationservice.SetResult{}, nil
		}},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(api))
	request := httptest.NewRequest(
		http.MethodPut,
		"/v1/workspaces/workspace-1/agent-sessions/session-1/tutti-mode-activation",
		strings.NewReader(`{"status":"inactive","source":"badge_remove","expectedRevision":-1}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
}

func TestCreateAgentSessionRejectsInvalidInitialTuttiModeActivationAtTransportBoundary(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		activation map[string]any
	}{
		{name: "invalid status", activation: map[string]any{"status": "paused", "source": "slash_command"}},
		{name: "invalid source", activation: map[string]any{"status": "active", "source": "toolbar"}},
		{name: "missing status", activation: map[string]any{"source": "slash_command"}},
		{name: "missing source", activation: map[string]any{"status": "active"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					createFn: func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error) {
						t.Fatal("Create should not be called for an invalid initialTuttiModeActivation")
						return agentservice.Session{}, nil
					},
				},
			}))

			response := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/workspace-1/agent-sessions", map[string]any{
				"agentSessionId":             "11111111-1111-4111-8111-111111111111",
				"agentTargetId":              agenttargetbiz.IDLocalCodex,
				"clientSubmitId":             "submit-1",
				"initialContent":             []map[string]any{},
				"initialTuttiModeActivation": test.activation,
			})
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
		})
	}
}

func TestUpdateTuttiModeActivationRejectsInvalidEnumsAtTransportBoundary(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		body map[string]any
	}{
		{name: "invalid status", body: map[string]any{"status": "paused", "source": "slash_command"}},
		{name: "invalid source", body: map[string]any{"status": "active", "source": "toolbar"}},
		{name: "missing status", body: map[string]any{"source": "slash_command"}},
		{name: "missing source", body: map[string]any{"status": "active"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			api := DaemonAPI{
				AgentSessionService: stubAgentSessionService{getFn: func(context.Context, string, string) (agentservice.Session, error) {
					t.Fatal("Get should not be called for invalid activation enums")
					return agentservice.Session{}, nil
				}},
				TuttiModeActivationService: &stubTuttiModeActivationService{setFn: func(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error) {
					t.Fatal("Set should not be called for invalid activation enums")
					return tuttimodeactivationservice.SetResult{}, nil
				}},
			}
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(api))

			response := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodPut,
				"/v1/workspaces/workspace-1/agent-sessions/session-1/tutti-mode-activation",
				test.body,
			)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
		})
	}
}

func TestTuttiModeActivationRouteIsRegistered(t *testing.T) {
	t.Parallel()
	api := DaemonAPI{
		AgentSessionService:        stubAgentSessionService{},
		TuttiModeActivationService: &stubTuttiModeActivationService{},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(api))
	request := httptest.NewRequest(http.MethodGet, "/v1/workspaces/workspace-1/agent-sessions/session-1/tutti-mode-activation", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"activation":null`) {
		t.Fatalf("route status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestGetTuttiModeActivationReturnsProjectionErrorForInvalidDurableIdentity(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	api := DaemonAPI{
		AgentSessionService: stubAgentSessionService{},
		TuttiModeActivationService: &stubTuttiModeActivationService{getFn: func(context.Context, string, string) (*tuttimodeactivationbiz.Activation, error) {
			return &tuttimodeactivationbiz.Activation{
				ID: "not-a-uuid", WorkspaceID: "workspace-opaque", AgentSessionID: "session-1",
				CreatedAt: now, UpdatedAt: now,
				CurrentRevision: tuttimodeactivationbiz.Revision{
					ID: "1ca08e98-728d-4fe9-8fd4-a2362698aeac", ActivationID: "not-a-uuid",
					Revision: 1, State: tuttimodeactivationbiz.StateActive, Source: tuttimodeactivationbiz.SourceSlashCommand, CreatedAt: now,
				},
			}, nil
		}},
	}
	response, err := api.GetWorkspaceAgentSessionTuttiModeActivation(context.Background(), tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivationRequestObject{
		WorkspaceID: "workspace-opaque", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.GetWorkspaceAgentSessionTuttiModeActivation502JSONResponse); !ok {
		t.Fatalf("response = %T, want 502 projection error", response)
	}
}

func TestGeneratedTuttiModeActivationProjectsCurrentRevision(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	activation := &tuttimodeactivationbiz.Activation{
		ID: "32bb4e49-5d37-423d-a087-c2f1b5881284", WorkspaceID: "60f2bb2e-02f0-41bd-bfaf-da28b0f92b7f", AgentSessionID: "session-1",
		CreatedAt: now, UpdatedAt: now.Add(time.Second),
		CurrentRevision: tuttimodeactivationbiz.Revision{
			ID: "1ca08e98-728d-4fe9-8fd4-a2362698aeac", ActivationID: "32bb4e49-5d37-423d-a087-c2f1b5881284",
			Revision: 2, State: tuttimodeactivationbiz.StateInactive, Source: tuttimodeactivationbiz.SourceBadgeRemove, CreatedAt: now.Add(time.Second),
		},
	}
	generated, err := generatedTuttiModeActivation(activation)
	if err != nil {
		t.Fatalf("generatedTuttiModeActivation() error = %v", err)
	}
	if generated == nil || generated.WorkspaceId != activation.WorkspaceID || generated.Status != tuttigenerated.TuttiModeActivationStatusInactive || generated.CurrentRevision.Revision != 2 || generated.CurrentRevision.Status != tuttigenerated.TuttiModeActivationStatusInactive || generated.CurrentRevision.Source != tuttigenerated.TuttiModeActivationSourceBadgeRemove {
		t.Fatalf("generated = %#v", generated)
	}
}

func TestGeneratedTuttiModeActivationPreservesOpaqueWorkspaceID(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	activation := &tuttimodeactivationbiz.Activation{
		ID: "32bb4e49-5d37-423d-a087-c2f1b5881284", WorkspaceID: "workspace-opaque", AgentSessionID: "session-1",
		CreatedAt: now, UpdatedAt: now,
		CurrentRevision: tuttimodeactivationbiz.Revision{
			ID: "1ca08e98-728d-4fe9-8fd4-a2362698aeac", ActivationID: "32bb4e49-5d37-423d-a087-c2f1b5881284",
			Revision: 1, State: tuttimodeactivationbiz.StateActive, Source: tuttimodeactivationbiz.SourceSlashCommand, CreatedAt: now,
		},
	}
	generated, err := generatedTuttiModeActivation(activation)
	if err != nil {
		t.Fatalf("generatedTuttiModeActivation() error = %v", err)
	}
	if generated == nil || generated.WorkspaceId != "workspace-opaque" {
		t.Fatalf("generated workspace id = %#v", generated)
	}
}

func TestGeneratedTuttiModeActivationRejectsInvalidUUIDIdentity(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	for _, invalidID := range []string{"not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		activation := &tuttimodeactivationbiz.Activation{
			ID: invalidID, WorkspaceID: "workspace-opaque", AgentSessionID: "session-1",
			CreatedAt: now, UpdatedAt: now,
			CurrentRevision: tuttimodeactivationbiz.Revision{
				ID: "1ca08e98-728d-4fe9-8fd4-a2362698aeac", ActivationID: invalidID,
				Revision: 1, State: tuttimodeactivationbiz.StateActive, Source: tuttimodeactivationbiz.SourceSlashCommand, CreatedAt: now,
			},
		}
		generated, err := generatedTuttiModeActivation(activation)
		if err == nil || generated != nil {
			t.Fatalf("id=%q generated=%#v error=%v, want explicit projection error", invalidID, generated, err)
		}
	}
}

func TestGeneratedAgentSessionPropagatesInvalidTuttiModeIdentity(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_000_000_000).UTC()
	_, err := generatedAgentSession(agentservice.Session{
		ID: "session-1", CreatedAt: now,
		TuttiModeActivation: &tuttimodeactivationbiz.Activation{
			ID: "not-a-uuid", WorkspaceID: "workspace-opaque", AgentSessionID: "session-1",
			CreatedAt: now, UpdatedAt: now,
			CurrentRevision: tuttimodeactivationbiz.Revision{
				ID: "1ca08e98-728d-4fe9-8fd4-a2362698aeac", ActivationID: "not-a-uuid",
				Revision: 1, State: tuttimodeactivationbiz.StateActive, Source: tuttimodeactivationbiz.SourceSlashCommand, CreatedAt: now,
			},
		},
	})
	if err == nil {
		t.Fatal("generatedAgentSession() error = nil, want activation projection error")
	}
}

func TestInitialTuttiModeActivationIsIndependentFromCapabilityRefs(t *testing.T) {
	t.Parallel()
	intent, err := tuttiModeActivationIntentFromGenerated(&tuttigenerated.TuttiModeActivationIntent{
		Status: tuttigenerated.TuttiModeActivationStatusActive,
		Source: tuttigenerated.TuttiModeActivationSourceSlashCommand,
	})
	if err != nil {
		t.Fatalf("tuttiModeActivationIntentFromGenerated() error = %v", err)
	}
	if intent == nil || intent.State != "active" || intent.Source != "slash_command" {
		t.Fatalf("intent = %#v", intent)
	}
	missing, err := tuttiModeActivationIntentFromGenerated(nil)
	if err != nil || missing != nil {
		t.Fatal("missing intent was reconstructed")
	}
}

type stubTuttiModeActivationService struct {
	getFn func(context.Context, string, string) (*tuttimodeactivationbiz.Activation, error)
	setFn func(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error)
}

func (s *stubTuttiModeActivationService) Get(ctx context.Context, workspaceID, sessionID string) (*tuttimodeactivationbiz.Activation, error) {
	if s.getFn == nil {
		return nil, nil
	}
	return s.getFn(ctx, workspaceID, sessionID)
}

func (s *stubTuttiModeActivationService) Set(ctx context.Context, input tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error) {
	if s.setFn == nil {
		return tuttimodeactivationservice.SetResult{}, nil
	}
	return s.setFn(ctx, input)
}
