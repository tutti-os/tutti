package api

import (
	"context"
	"net/http"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestAgentSessionRoutesRejectDuplicateCapabilityReferencesAtTransportBoundary(t *testing.T) {
	t.Parallel()
	duplicateReferences := []map[string]any{
		{"capability": "tutti", "source": "slash_command"},
		{"capability": "tutti", "source": "slash_command"},
	}
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
				"capabilityRefs": duplicateReferences,
			},
		},
		{
			name:   "send",
			method: http.MethodPost,
			path:   "/v1/workspaces/ws-1/agent-sessions/session-1/input",
			body: map[string]any{
				"clientSubmitId": "submit-1",
				"capabilityRefs": duplicateReferences,
				"content":        []map[string]any{{"type": "text", "text": "hello"}},
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			mux := http.NewServeMux()
			RegisterRoutes(mux, NewRoutes(DaemonAPI{
				AgentSessionService: stubAgentSessionService{
					createFn: func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error) {
						t.Fatal("Create should not be called for duplicate capabilityRefs")
						return agentservice.Session{}, nil
					},
					sendInputFn: func(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error) {
						t.Fatal("SendInput should not be called for duplicate capabilityRefs")
						return agentservice.SendInputResult{}, nil
					},
				},
			}))

			response := performGeneratedRouteRequest(t, mux, test.method, test.path, test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
		})
	}
}
