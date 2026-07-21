package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
)

// notFoundModelPolicyService reports every lookup/mutation as a missing policy
// so the handlers exercise their 404 mapping.
type notFoundModelPolicyService struct{}

func (notFoundModelPolicyService) ListPolicies(context.Context, string) ([]modelpolicybiz.Policy, error) {
	return nil, nil
}

func (notFoundModelPolicyService) GetPolicy(context.Context, string, string) (modelpolicybiz.Policy, error) {
	return modelpolicybiz.Policy{}, workspacedata.ErrModelPolicyNotFound
}

func (notFoundModelPolicyService) PutPolicy(context.Context, modelpolicyservice.PutPolicyInput) (modelpolicybiz.Policy, error) {
	return modelpolicybiz.Policy{}, nil
}

func (notFoundModelPolicyService) DeletePolicy(context.Context, string, string) error {
	return workspacedata.ErrModelPolicyNotFound
}

func (notFoundModelPolicyService) GetSessionOverride(context.Context, string, string) (modelpolicybiz.SessionOverride, bool, error) {
	return modelpolicybiz.SessionOverride{}, false, nil
}

func (notFoundModelPolicyService) SetSessionOverride(context.Context, modelpolicybiz.SessionOverride) (modelpolicybiz.SessionOverride, error) {
	return modelpolicybiz.SessionOverride{}, workspacedata.ErrModelPolicyNotFound
}

func (notFoundModelPolicyService) GetAcceptance(context.Context, string, string) (modelpolicybiz.Acceptance, bool, error) {
	return modelpolicybiz.Acceptance{}, false, nil
}

func (notFoundModelPolicyService) MarkUserAccepted(context.Context, string, string) (modelpolicybiz.Acceptance, error) {
	return modelpolicybiz.Acceptance{}, nil
}

// assertModelPolicyNotFoundBody visits the response and checks it renders as an
// HTTP 404 whose body carries the WorkspaceNotFound machine code with the
// specific model_policy_not_found reason.
func assertModelPolicyNotFoundBody(t *testing.T, visit func(http.ResponseWriter) error) {
	t.Helper()
	recorder := httptest.NewRecorder()
	if err := visit(recorder); err != nil {
		t.Fatalf("visit response error = %v", err)
	}
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("http status = %d, want 404", recorder.Code)
	}
	var body tuttigenerated.ApiErrorResponse
	decodeGeneratedRouteResponse(t, recorder, &body)
	if body.Error.Code != tuttigenerated.WorkspaceNotFound {
		t.Fatalf("error.code = %q, want %q", body.Error.Code, tuttigenerated.WorkspaceNotFound)
	}
	if body.Error.Reason == nil || *body.Error.Reason != "model_policy_not_found" {
		got := "<nil>"
		if body.Error.Reason != nil {
			got = *body.Error.Reason
		}
		t.Fatalf("error.reason = %q, want model_policy_not_found", got)
	}
}

// referencedModelPolicyService reports policy deletion as blocked by a live
// binding reference, exactly as the production service does.
type referencedModelPolicyService struct{ notFoundModelPolicyService }

func (referencedModelPolicyService) DeletePolicy(context.Context, string, string) error {
	return fmt.Errorf("%w: 1 agent bindings", modelpolicyservice.ErrPolicyReferenced)
}

func TestDeleteModelPolicyReferencedReturnsConflict(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	api := DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
		ModelPolicyService: referencedModelPolicyService{},
	}
	response, err := api.DeleteModelPolicy(ctx, tuttigenerated.DeleteModelPolicyRequestObject{
		WorkspaceID:   "ws-1",
		ModelPolicyID: "pol-1",
	})
	if err != nil {
		t.Fatalf("DeleteModelPolicy() error = %v", err)
	}
	conflict, ok := response.(tuttigenerated.DeleteModelPolicy409JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 409", response)
	}

	recorder := httptest.NewRecorder()
	if err := conflict.VisitDeleteModelPolicyResponse(recorder); err != nil {
		t.Fatalf("visit error = %v", err)
	}
	if recorder.Code != http.StatusConflict {
		t.Fatalf("http status = %d, want 409", recorder.Code)
	}
	var body tuttigenerated.ApiErrorResponse
	decodeGeneratedRouteResponse(t, recorder, &body)
	if body.Error.Code != tuttigenerated.ModelPolicyReferenced {
		t.Fatalf("error.code = %q, want model_policy_referenced", body.Error.Code)
	}
	if body.Error.Reason == nil || *body.Error.Reason != "model_policy_referenced" {
		t.Fatalf("error.reason = %v, want model_policy_referenced", body.Error.Reason)
	}
}

func TestGetModelPolicyNotFoundReturnsNotFoundCode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	api := DaemonAPI{ModelPolicyService: notFoundModelPolicyService{}}
	response, err := api.GetModelPolicy(ctx, tuttigenerated.GetModelPolicyRequestObject{
		WorkspaceID:   "ws-1",
		ModelPolicyID: "pol-missing",
	})
	if err != nil {
		t.Fatalf("GetModelPolicy() error = %v", err)
	}
	notFound, ok := response.(tuttigenerated.GetModelPolicy404JSONResponse)
	if !ok {
		t.Fatalf("GetModelPolicy() response = %T, want 404", response)
	}
	assertModelPolicyNotFoundBody(t, notFound.VisitGetModelPolicyResponse)
}

func TestWriteModelPolicyNotFoundReturnsNotFoundCode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// Writes require the model-plans lab flag; enable it so the handler reaches
	// the not-found branch instead of the write gate.
	api := DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
		ModelPolicyService: notFoundModelPolicyService{},
	}

	updateResponse, err := api.UpdateModelPolicy(ctx, tuttigenerated.UpdateModelPolicyRequestObject{
		WorkspaceID:   "ws-1",
		ModelPolicyID: "pol-missing",
		Body:          &tuttigenerated.PutModelPolicyRequest{Name: "Careful"},
	})
	if err != nil {
		t.Fatalf("UpdateModelPolicy() error = %v", err)
	}
	updateNotFound, ok := updateResponse.(tuttigenerated.UpdateModelPolicy404JSONResponse)
	if !ok {
		t.Fatalf("UpdateModelPolicy() response = %T, want 404", updateResponse)
	}
	assertModelPolicyNotFoundBody(t, updateNotFound.VisitUpdateModelPolicyResponse)

	deleteResponse, err := api.DeleteModelPolicy(ctx, tuttigenerated.DeleteModelPolicyRequestObject{
		WorkspaceID:   "ws-1",
		ModelPolicyID: "pol-missing",
	})
	if err != nil {
		t.Fatalf("DeleteModelPolicy() error = %v", err)
	}
	deleteNotFound, ok := deleteResponse.(tuttigenerated.DeleteModelPolicy404JSONResponse)
	if !ok {
		t.Fatalf("DeleteModelPolicy() response = %T, want 404", deleteResponse)
	}
	assertModelPolicyNotFoundBody(t, deleteNotFound.VisitDeleteModelPolicyResponse)

	overrideResponse, err := api.SetAgentSessionModelPolicyOverride(ctx, tuttigenerated.SetAgentSessionModelPolicyOverrideRequestObject{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Body:           &tuttigenerated.SetAgentSessionModelPolicyOverrideRequest{ModelPolicyId: stringPointer("pol-missing")},
	})
	if err != nil {
		t.Fatalf("SetAgentSessionModelPolicyOverride() error = %v", err)
	}
	overrideNotFound, ok := overrideResponse.(tuttigenerated.SetAgentSessionModelPolicyOverride404JSONResponse)
	if !ok {
		t.Fatalf("SetAgentSessionModelPolicyOverride() response = %T, want 404", overrideResponse)
	}
	assertModelPolicyNotFoundBody(t, overrideNotFound.VisitSetAgentSessionModelPolicyOverrideResponse)
}
