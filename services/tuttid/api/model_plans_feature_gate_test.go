package api

import (
	"context"
	"errors"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type gateStubModelPlanService struct{}

func (gateStubModelPlanService) ListPlans(context.Context, string) ([]modelplanbiz.PublicPlan, error) {
	return []modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) GetPlan(context.Context, string, string) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) CreatePlan(context.Context, modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) UpdatePlan(context.Context, modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) DuplicatePlan(context.Context, string, string, string) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) SetPlanEnabled(context.Context, string, string, bool) (modelplanbiz.PublicPlan, error) {
	return modelplanbiz.PublicPlan{}, nil
}
func (gateStubModelPlanService) DeletePlan(context.Context, string, string) error { return nil }
func (gateStubModelPlanService) PlanReferences(context.Context, string, string) ([]modelplanbiz.Reference, error) {
	return nil, nil
}
func (gateStubModelPlanService) Detect(context.Context, modelplanservice.DetectInput) (modelplanservice.DetectResult, error) {
	return modelplanservice.DetectResult{}, nil
}

func gateTestPreferences(flags map[string]bool, err error) stubPreferencesService {
	return stubPreferencesService{
		getFn: func(context.Context) (preferencesbiz.DesktopPreferences, error) {
			if err != nil {
				return preferencesbiz.DesktopPreferences{}, err
			}
			return preferencesbiz.DesktopPreferences{FeatureFlags: flags}, nil
		},
	}
}

func TestModelPlansWriteGateRejectsWritesWhenFlagOff(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	workspaceID := tuttigenerated.WorkspaceID("ws-1")

	cases := []struct {
		name  string
		flags map[string]bool
		err   error
	}{
		{name: "flag explicitly false", flags: map[string]bool{preferencesbiz.LabFlagModelPlans: false}},
		{name: "flag absent", flags: map[string]bool{}},
		{name: "preferences unreadable", err: errors.New("preferences store down")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := DaemonAPI{
				PreferencesService: gateTestPreferences(tc.flags, tc.err),
				ModelPlanService:   gateStubModelPlanService{},
			}
			createResponse, err := api.CreateModelPlan(ctx, tuttigenerated.CreateModelPlanRequestObject{WorkspaceID: workspaceID})
			if err != nil {
				t.Fatalf("CreateModelPlan() error = %v", err)
			}
			rejected, ok := createResponse.(tuttigenerated.CreateModelPlan400JSONResponse)
			if !ok {
				t.Fatalf("CreateModelPlan() response = %T, want 400 rejection", createResponse)
			}
			if reason := tuttigenerated.ApiErrorResponse(rejected.InvalidRequestErrorJSONResponse).Error.Reason; reason == nil || *reason != "model_plans_disabled" {
				t.Fatalf("CreateModelPlan() rejection reason = %v, want model_plans_disabled", reason)
			}
		})
	}
}

func TestModelPlansWriteGateKeepsReadsWorkingWhenFlagOff(t *testing.T) {
	t.Parallel()

	api := DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{}, nil),
		ModelPlanService:   gateStubModelPlanService{},
	}
	response, err := api.ListModelPlans(context.Background(), tuttigenerated.ListModelPlansRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("ListModelPlans() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.ListModelPlans200JSONResponse); !ok {
		t.Fatalf("ListModelPlans() response = %T, want 200 with writes gated", response)
	}
}

func TestModelPlansWriteGateAllowsWritesWhenFlagOn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// Nil services: reaching the 503 service-unavailable branch proves the
	// gate passed the request through to the handler.
	api := DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{preferencesbiz.LabFlagModelPlans: true}, nil),
	}
	createResponse, err := api.CreateModelPlan(ctx, tuttigenerated.CreateModelPlanRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("CreateModelPlan() error = %v", err)
	}
	if _, ok := createResponse.(tuttigenerated.CreateModelPlan503JSONResponse); !ok {
		t.Fatalf("CreateModelPlan() response = %T, want 503 passthrough with flag on", createResponse)
	}
	bindingResponse, err := api.SetAgentModelBinding(ctx, tuttigenerated.SetAgentModelBindingRequestObject{WorkspaceID: "ws-1", AgentTargetID: "codex"})
	if err != nil {
		t.Fatalf("SetAgentModelBinding() error = %v", err)
	}
	if _, ok := bindingResponse.(tuttigenerated.SetAgentModelBinding503JSONResponse); !ok {
		t.Fatalf("SetAgentModelBinding() response = %T, want 503 passthrough with flag on", bindingResponse)
	}
}

func TestModelPlansWriteGateCoversBindingWrites(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	api := DaemonAPI{PreferencesService: gateTestPreferences(map[string]bool{}, nil)}

	bindingResponse, err := api.SetAgentModelBinding(ctx, tuttigenerated.SetAgentModelBindingRequestObject{WorkspaceID: "ws-1", AgentTargetID: "codex"})
	if err != nil {
		t.Fatalf("SetAgentModelBinding() error = %v", err)
	}
	if _, ok := bindingResponse.(tuttigenerated.SetAgentModelBinding400JSONResponse); !ok {
		t.Fatalf("SetAgentModelBinding() response = %T, want 400 rejection", bindingResponse)
	}
}
