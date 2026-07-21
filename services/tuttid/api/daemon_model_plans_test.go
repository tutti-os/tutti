package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type modelPlanServiceStub struct {
	setEnabledCalls int
	lastEnabled     bool
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

func (*modelPlanServiceStub) PlanReferences(context.Context, string, string) ([]modelplanbiz.Reference, error) {
	return nil, nil
}

func (*modelPlanServiceStub) Detect(context.Context, modelplanservice.DetectInput) (modelplanservice.DetectResult, error) {
	return modelplanservice.DetectResult{}, nil
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
