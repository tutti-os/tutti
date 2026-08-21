package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func enabledSideConversationAPI(service SideConversationService) DaemonAPI {
	return DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{
			preferencesbiz.LabFlagAgentSideConversation: true,
		}, nil),
		SideConversationService: service,
	}
}

type sideConversationServiceStub struct {
	resolveFn func(context.Context, string, string) (agenthost.SideConversationCapabilities, error)
	openFn    func(context.Context, string, string, agentservice.OpenSideConversationInput) (agentservice.SideConversation, error)
	respondFn func(context.Context, agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error)
}

func (s sideConversationServiceStub) ResolveSideConversation(
	ctx context.Context,
	workspaceID string,
	sourceID string,
) (agenthost.SideConversationCapabilities, error) {
	if s.resolveFn != nil {
		return s.resolveFn(ctx, workspaceID, sourceID)
	}
	return agenthost.SideConversationCapabilities{
		Supported: true, ActiveSourceTurn: true, Ephemeral: true,
		HideInheritedTurns: true, ModelBoundaryInjected: true,
	}, nil
}

func TestResolveWorkspaceAgentSideCapabilitiesFailsClosedWhenDisabled(t *testing.T) {
	service := sideConversationServiceStub{
		resolveFn: func(
			context.Context,
			string,
			string,
		) (agenthost.SideConversationCapabilities, error) {
			t.Fatal("disabled capability lookup reached the Side service")
			return agenthost.SideConversationCapabilities{}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService:      gateTestPreferences(map[string]bool{}, nil),
		SideConversationService: service,
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/side-capabilities",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Capabilities struct {
			Supported bool `json:"supported"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Capabilities.Supported {
		t.Fatalf("disabled capabilities = %#v, want unsupported", body.Capabilities)
	}
}

func TestResolveWorkspaceAgentSideCapabilitiesMapsDisconnectedToExpiredConflict(
	t *testing.T,
) {
	service := sideConversationServiceStub{
		resolveFn: func(
			context.Context,
			string,
			string,
		) (agenthost.SideConversationCapabilities, error) {
			return agenthost.SideConversationCapabilities{},
				agentservice.ErrRuntimeSessionDisconnected
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(enabledSideConversationAPI(service)))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/side-capabilities",
		nil,
	)
	if recorder.Code != http.StatusConflict {
		t.Fatalf(
			"status = %d, want 409; body=%s",
			recorder.Code,
			recorder.Body.String(),
		)
	}
	var body struct {
		Error struct {
			Reason string `json:"reason"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Reason != "agent_side_conversation_expired" {
		t.Fatalf("error reason = %q", body.Error.Reason)
	}
}

func TestResolveWorkspaceAgentSideCapabilitiesMapsWorkspaceNotFound(
	t *testing.T,
) {
	service := sideConversationServiceStub{
		resolveFn: func(
			context.Context,
			string,
			string,
		) (agenthost.SideConversationCapabilities, error) {
			return agenthost.SideConversationCapabilities{},
				apierrors.WorkspaceNotFound(apierrors.ReasonWorkspaceNotFound)
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(enabledSideConversationAPI(service)))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/missing/agent-sessions/source-1/side-capabilities",
		nil,
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf(
			"status = %d, want 404; body=%s",
			recorder.Code,
			recorder.Body.String(),
		)
	}
}

func (s sideConversationServiceStub) OpenSideConversation(
	ctx context.Context,
	workspaceID string,
	sourceID string,
	input agentservice.OpenSideConversationInput,
) (agentservice.SideConversation, error) {
	if s.openFn != nil {
		return s.openFn(ctx, workspaceID, sourceID, input)
	}
	return agentservice.SideConversation{}, nil
}

func (sideConversationServiceStub) SendSideConversation(
	context.Context,
	string,
	string,
	agentservice.SendSideConversationInput,
) (agenthost.RuntimeExecResult, error) {
	return agenthost.RuntimeExecResult{}, nil
}

func (sideConversationServiceStub) CancelSideConversation(
	context.Context,
	string,
	string,
	string,
) (agenthost.RuntimeCancelResult, error) {
	return agenthost.RuntimeCancelResult{}, nil
}

func (s sideConversationServiceStub) SubmitSideConversationInteractive(
	ctx context.Context,
	input agenthost.RuntimeSubmitInteractiveInput,
) (agenthost.RuntimeSubmitInteractiveResult, error) {
	if s.respondFn != nil {
		return s.respondFn(ctx, input)
	}
	return agenthost.RuntimeSubmitInteractiveResult{}, nil
}

func (sideConversationServiceStub) CloseSideConversation(
	context.Context,
	string,
	string,
) error {
	return nil
}

func TestOpenWorkspaceAgentSideConversationPreservesTransientIdentity(t *testing.T) {
	var observedWorkspaceID, observedSourceID string
	var observedInput agentservice.OpenSideConversationInput
	service := sideConversationServiceStub{
		openFn: func(
			_ context.Context,
			workspaceID string,
			sourceID string,
			input agentservice.OpenSideConversationInput,
		) (agentservice.SideConversation, error) {
			observedWorkspaceID, observedSourceID, observedInput =
				workspaceID, sourceID, input
			return agentservice.SideConversation{
				WorkspaceID: workspaceID, SourceAgentSessionID: sourceID,
				SideAgentSessionID: input.SideAgentSessionID, Provider: "codex",
				Status: "ready",
				Capabilities: agenthost.SideConversationCapabilities{
					Supported: true, ActiveSourceTurn: true, Ephemeral: true,
					HideInheritedTurns: true, ModelBoundaryInjected: true,
				},
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(enabledSideConversationAPI(service)))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/side-conversations",
		map[string]any{
			"sideAgentSessionId": "side-1",
			"requestId":          "request-1",
		},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if observedWorkspaceID != "workspace-1" ||
		observedSourceID != "source-1" ||
		observedInput.SideAgentSessionID != "side-1" ||
		observedInput.RequestID != "request-1" {
		t.Fatalf(
			"open identity = workspace=%q source=%q input=%#v",
			observedWorkspaceID,
			observedSourceID,
			observedInput,
		)
	}
	var body struct {
		Side struct {
			SideAgentSessionID string `json:"sideAgentSessionId"`
			Status             string `json:"status"`
			Capabilities       struct {
				ActiveSourceTurn      bool `json:"activeSourceTurn"`
				Ephemeral             bool `json:"ephemeral"`
				HideInheritedTurns    bool `json:"hideInheritedTurns"`
				ModelBoundaryInjected bool `json:"modelBoundaryInjected"`
			} `json:"capabilities"`
		} `json:"side"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Side.SideAgentSessionID != "side-1" ||
		body.Side.Status != "ready" ||
		!body.Side.Capabilities.ActiveSourceTurn ||
		!body.Side.Capabilities.Ephemeral ||
		!body.Side.Capabilities.HideInheritedTurns ||
		!body.Side.Capabilities.ModelBoundaryInjected {
		t.Fatalf("side response = %#v", body.Side)
	}
}

func TestOpenWorkspaceAgentSideConversationRejectsDisabledFeature(t *testing.T) {
	service := sideConversationServiceStub{
		openFn: func(
			context.Context,
			string,
			string,
			agentservice.OpenSideConversationInput,
		) (agentservice.SideConversation, error) {
			t.Fatal("disabled Side open reached the service")
			return agentservice.SideConversation{}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService:      gateTestPreferences(map[string]bool{}, nil),
		SideConversationService: service,
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-sessions/source-1/side-conversations",
		map[string]any{
			"sideAgentSessionId": "side-1",
			"requestId":          "request-1",
		},
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSubmitWorkspaceAgentSideConversationInteractiveUsesExactIdentity(
	t *testing.T,
) {
	var observed agenthost.RuntimeSubmitInteractiveInput
	service := sideConversationServiceStub{
		respondFn: func(
			_ context.Context,
			input agenthost.RuntimeSubmitInteractiveInput,
		) (agenthost.RuntimeSubmitInteractiveResult, error) {
			observed = input
			return agenthost.RuntimeSubmitInteractiveResult{
				Disposition: agenthost.RuntimeInteractiveDispositionAnswered,
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(enabledSideConversationAPI(service)))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/agent-side-conversations/side-1/turns/turn-1/interactive/request-1",
		map[string]any{
			"action":   "approve",
			"optionId": "allow",
			"payload":  map[string]any{"reason": "reviewed"},
		},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	if observed.WorkspaceID != "workspace-1" ||
		observed.RootAgentSessionID != "side-1" ||
		observed.AgentSessionID != "side-1" ||
		observed.TurnID != "turn-1" ||
		observed.RequestID != "request-1" ||
		observed.Action != "approve" ||
		observed.OptionID != "allow" ||
		observed.Payload["reason"] != "reviewed" {
		t.Fatalf("interactive identity = %#v", observed)
	}
}

func TestSubmitWorkspaceAgentSideConversationInteractiveClassifiesErrors(
	t *testing.T,
) {
	for _, test := range []struct {
		name       string
		err        error
		wantStatus int
		wantReason string
	}{
		{
			name:       "request no longer live",
			err:        agenthost.ErrInteractiveRequestNotLive,
			wantStatus: http.StatusConflict,
			wantReason: "agent_side_interaction_not_live",
		},
		{
			name:       "invalid option",
			err:        agenthost.ErrInteractiveResponseInvalid,
			wantStatus: http.StatusBadRequest,
			wantReason: "agent_side_interaction_invalid_response",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := sideConversationServiceStub{
				respondFn: func(
					context.Context,
					agenthost.RuntimeSubmitInteractiveInput,
				) (agenthost.RuntimeSubmitInteractiveResult, error) {
					return agenthost.RuntimeSubmitInteractiveResult{}, test.err
				},
			}
			mux := http.NewServeMux()
			RegisterRoutes(
				mux,
				NewRoutes(enabledSideConversationAPI(service)),
			)
			recorder := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodPost,
				"/v1/workspaces/workspace-1/agent-side-conversations/side-1/turns/turn-1/interactive/request-1",
				map[string]any{"optionId": "allow"},
			)
			if recorder.Code != test.wantStatus {
				t.Fatalf(
					"status = %d, want %d; body=%s",
					recorder.Code,
					test.wantStatus,
					recorder.Body.String(),
				)
			}
			var body struct {
				Error struct {
					Reason *string `json:"reason"`
				} `json:"error"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Error.Reason == nil || *body.Error.Reason != test.wantReason {
				t.Fatalf("reason = %#v, want %q", body.Error.Reason, test.wantReason)
			}
		})
	}
}
