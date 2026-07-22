package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
)

// policyRejectingBindingService reports a binding write against a missing
// policy exactly as the production service does.
type policyRejectingBindingService struct{}

func (policyRejectingBindingService) ListBindings(context.Context, string) ([]modelbindingbiz.Binding, error) {
	return nil, nil
}

func (policyRejectingBindingService) SetBinding(context.Context, modelbindingservice.SetBindingInput) (modelbindingbiz.Binding, error) {
	return modelbindingbiz.Binding{}, fmt.Errorf("%w: policy not found", modelbindingservice.ErrPolicyNotUsable)
}

// referenceUnusableBindingService reports the post-validation foreign-key
// backstop firing (a reference disappeared mid-write), the way the production
// service maps a storage foreign-key rejection.
type referenceUnusableBindingService struct{}

func (referenceUnusableBindingService) ListBindings(context.Context, string) ([]modelbindingbiz.Binding, error) {
	return nil, nil
}

func (referenceUnusableBindingService) SetBinding(context.Context, modelbindingservice.SetBindingInput) (modelbindingbiz.Binding, error) {
	return modelbindingbiz.Binding{}, modelbindingservice.ErrBindingReferenceUnusable
}

func TestSetAgentModelBindingReferenceRaceMapsToNeutralInvalidRequest(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	api := DaemonAPI{
		PreferencesService:       gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
		AgentModelBindingService: referenceUnusableBindingService{},
	}

	response, err := api.SetAgentModelBinding(ctx, tuttigenerated.SetAgentModelBindingRequestObject{
		WorkspaceID:   "ws-1",
		AgentTargetID: "local:codex",
		Body:          &tuttigenerated.SetAgentModelBindingRequest{ModelPolicyId: stringPointer("pol-x")},
	})
	if err != nil {
		t.Fatalf("SetAgentModelBinding() error = %v", err)
	}
	rejected, ok := response.(tuttigenerated.SetAgentModelBinding400JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 400", response)
	}

	recorder := httptest.NewRecorder()
	if err := rejected.VisitSetAgentModelBindingResponse(recorder); err != nil {
		t.Fatalf("visit error = %v", err)
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("http status = %d, want 400", recorder.Code)
	}
	var body tuttigenerated.ApiErrorResponse
	decodeGeneratedRouteResponse(t, recorder, &body)
	if body.Error.Code != tuttigenerated.InvalidRequest {
		t.Fatalf("error.code = %q, want invalid_request", body.Error.Code)
	}
	if body.Error.Reason == nil || *body.Error.Reason != "invalid_agent_model_binding" {
		t.Fatalf("error.reason = %v, want invalid_agent_model_binding", body.Error.Reason)
	}
	// The developer message must stay neutral: it must not blame the plan when
	// SQLite cannot say which reference failed.
	if body.Error.DeveloperMessage == nil {
		t.Fatalf("developer message = nil, want the neutral reference message")
	}
	if strings.Contains(*body.Error.DeveloperMessage, "plan") {
		t.Fatalf("developer message = %q, must not claim the plan is unusable", *body.Error.DeveloperMessage)
	}
}

func TestSetAgentModelBindingRejectsUnknownPolicyAsInvalidRequest(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	api := DaemonAPI{
		PreferencesService:       gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
		AgentModelBindingService: policyRejectingBindingService{},
	}

	response, err := api.SetAgentModelBinding(ctx, tuttigenerated.SetAgentModelBindingRequestObject{
		WorkspaceID:   "ws-1",
		AgentTargetID: "local:codex",
		Body:          &tuttigenerated.SetAgentModelBindingRequest{ModelPolicyId: stringPointer("pol-missing")},
	})
	if err != nil {
		t.Fatalf("SetAgentModelBinding() error = %v", err)
	}
	rejected, ok := response.(tuttigenerated.SetAgentModelBinding400JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 400", response)
	}

	// Assert the real production wire shape, not just the Go type.
	recorder := httptest.NewRecorder()
	if err := rejected.VisitSetAgentModelBindingResponse(recorder); err != nil {
		t.Fatalf("visit error = %v", err)
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("http status = %d, want 400", recorder.Code)
	}
	var body tuttigenerated.ApiErrorResponse
	decodeGeneratedRouteResponse(t, recorder, &body)
	if body.Error.Code != tuttigenerated.InvalidRequest {
		t.Fatalf("error.code = %q, want invalid_request", body.Error.Code)
	}
	if body.Error.Reason == nil || *body.Error.Reason != "invalid_agent_model_binding" {
		t.Fatalf("error.reason = %v, want invalid_agent_model_binding", body.Error.Reason)
	}
}
