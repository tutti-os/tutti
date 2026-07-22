package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type modelPlanServiceStub struct {
	setEnabledCalls int
	lastEnabled     bool
	references      []modelplanbiz.Reference
}

func (*modelPlanServiceStub) ListPlans(context.Context, string) ([]modelplanbiz.PublicPlan, error) {
	return nil, nil
}

func (*modelPlanServiceStub) GetPlan(context.Context, string, string) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}

func (*modelPlanServiceStub) CreatePlan(context.Context, modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}

func (*modelPlanServiceStub) UpdatePlan(context.Context, modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}

func (*modelPlanServiceStub) DuplicatePlan(context.Context, string, string, string) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}

func (s *modelPlanServiceStub) SetPlanEnabled(_ context.Context, _, _ string, enabled bool) (modelplanbiz.PublicPlan, error) {
	s.setEnabledCalls++
	s.lastEnabled = enabled
	return modelplanbiz.PublicPlan{}, nil
}

func (*modelPlanServiceStub) DeletePlan(context.Context, string, string) error { return nil }

func (s *modelPlanServiceStub) PlanReferences(context.Context, string, string) ([]modelplanbiz.Reference, error) {
	return s.references, nil
}

func (*modelPlanServiceStub) Detect(context.Context, modelplanservice.DetectInput) (modelplanservice.DetectResult, error) {
	return modelplanservice.DetectResult{}, nil
}

func TestListModelPlanReferencesSerializesModelPolicyKind(t *testing.T) {
	t.Parallel()

	service := &modelPlanServiceStub{references: []modelplanbiz.Reference{
		{Kind: modelplanbiz.ReferenceModelPolicy, ID: "pol-1", Name: "Careful", Role: "review"},
	}}
	api := DaemonAPI{ModelPlanService: service}

	response, err := api.ListModelPlanReferences(context.Background(), tuttigenerated.ListModelPlanReferencesRequestObject{
		WorkspaceID: "ws",
		ModelPlanID: "mp-1",
	})
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	ok200, ok := response.(tuttigenerated.ListModelPlanReferences200JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if len(ok200.References) != 1 {
		t.Fatalf("references = %#v, want exactly one", ok200.References)
	}
	ref := ok200.References[0]
	if ref.Kind != tuttigenerated.ModelPlanReferenceKindModelPolicy {
		t.Fatalf("kind = %q, want model_policy", ref.Kind)
	}
	// The value must be a known member of the regenerated contract enum.
	if !ref.Kind.Valid() {
		t.Fatalf("kind %q is not a valid ModelPlanReferenceKind under the generated contract", ref.Kind)
	}
	if ref.Id != "pol-1" || ref.Name == nil || *ref.Name != "Careful" || ref.Role == nil || *ref.Role != "review" {
		t.Fatalf("reference fields = %#v, want id/name/role populated", ref)
	}

	// The serialized 200 wire form carries kind=model_policy with role/name/id.
	recorder := httptest.NewRecorder()
	if err := ok200.VisitListModelPlanReferencesResponse(recorder); err != nil {
		t.Fatalf("visit error = %v", err)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("http status = %d, want 200", recorder.Code)
	}
	var decoded tuttigenerated.ModelPlanReferencesResponse
	decodeGeneratedRouteResponse(t, recorder, &decoded)
	if len(decoded.References) != 1 {
		t.Fatalf("decoded references = %#v, want one", decoded.References)
	}
	got := decoded.References[0]
	if got.Kind != tuttigenerated.ModelPlanReferenceKindModelPolicy {
		t.Fatalf("decoded kind = %q, want model_policy", got.Kind)
	}
	if got.Id != "pol-1" || got.Name == nil || *got.Name != "Careful" || got.Role == nil || *got.Role != "review" {
		t.Fatalf("decoded reference = %#v, want id/name/role preserved", got)
	}
}

func TestSetModelPlanEnabledRejectsMissingEnabled(t *testing.T) {
	t.Parallel()

	service := &modelPlanServiceStub{}
	api := DaemonAPI{
		ModelPlanService:   service,
		PreferencesService: gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
	}
	response, err := api.SetModelPlanEnabled(context.Background(), tuttigenerated.SetModelPlanEnabledRequestObject{
		WorkspaceID: "ws",
		ModelPlanID: "mp-1",
		Body:        &tuttigenerated.SetModelPlanEnabledRequest{},
	})
	if err != nil {
		t.Fatalf("SetModelPlanEnabled() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.SetModelPlanEnabled400JSONResponse); !ok {
		t.Fatalf("SetModelPlanEnabled() response = %T, want 400", response)
	}
	if service.setEnabledCalls != 0 {
		t.Fatalf("SetPlanEnabled() calls = %d, want 0", service.setEnabledCalls)
	}
}

func TestSetModelPlanEnabledAcceptsExplicitFalse(t *testing.T) {
	t.Parallel()

	service := &modelPlanServiceStub{}
	api := DaemonAPI{
		ModelPlanService:   service,
		PreferencesService: gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
	}
	enabled := false
	response, err := api.SetModelPlanEnabled(context.Background(), tuttigenerated.SetModelPlanEnabledRequestObject{
		WorkspaceID: "ws",
		ModelPlanID: "mp-1",
		Body:        &tuttigenerated.SetModelPlanEnabledRequest{Enabled: &enabled},
	})
	if err != nil {
		t.Fatalf("SetModelPlanEnabled() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.SetModelPlanEnabled200JSONResponse); !ok {
		t.Fatalf("SetModelPlanEnabled() response = %T, want 200", response)
	}
	if service.setEnabledCalls != 1 || service.lastEnabled {
		t.Fatalf("SetPlanEnabled() calls/enabled = %d/%v, want 1/false", service.setEnabledCalls, service.lastEnabled)
	}
}
