package api

import (
	"context"
	"errors"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

type gateStubAutomationRuleService struct{}

func (gateStubAutomationRuleService) ListRules(context.Context, string) ([]automationrulebiz.Rule, error) {
	return []automationrulebiz.Rule{}, nil
}
func (gateStubAutomationRuleService) GetRule(context.Context, string, string) (automationrulebiz.Rule, error) {
	return automationrulebiz.Rule{}, nil
}
func (gateStubAutomationRuleService) CreateRule(context.Context, automationruleservice.PutRuleInput) (automationrulebiz.Rule, error) {
	return automationrulebiz.Rule{}, nil
}
func (gateStubAutomationRuleService) UpdateRule(context.Context, automationruleservice.PutRuleInput) (automationrulebiz.Rule, error) {
	return automationrulebiz.Rule{}, nil
}
func (gateStubAutomationRuleService) DeleteRule(context.Context, string, string) error {
	return nil
}
func (gateStubAutomationRuleService) GetSessionOverride(context.Context, string, string) (automationrulebiz.SessionOverride, bool, error) {
	return automationrulebiz.SessionOverride{}, false, nil
}
func (gateStubAutomationRuleService) SetSessionOverride(_ context.Context, input automationrulebiz.SessionOverride) (automationrulebiz.SessionOverride, error) {
	return input, nil
}

type gateStubCollaborationRunService struct{}

func (gateStubCollaborationRunService) StartConsult(context.Context, collabrunservice.StartConsultInput) (collabrunbiz.Run, error) {
	return collabrunbiz.Run{}, nil
}
func (gateStubCollaborationRunService) RecordRun(context.Context, collabrunservice.RecordRunInput) (collabrunbiz.Run, error) {
	return collabrunbiz.Run{}, nil
}
func (gateStubCollaborationRunService) SetAdoption(context.Context, string, string, string) (collabrunbiz.Run, error) {
	return collabrunbiz.Run{}, nil
}
func (gateStubCollaborationRunService) CancelConsult(context.Context, string, string) (collabrunbiz.Run, error) {
	return collabrunbiz.Run{}, nil
}
func (gateStubCollaborationRunService) ListRuns(context.Context, string, string, int) ([]collabrunbiz.Run, error) {
	return []collabrunbiz.Run{}, nil
}

func TestAutomationRulesWriteGateRejectsWritesWhenFlagOff(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	workspaceID := tuttigenerated.WorkspaceID("ws-1")

	cases := []struct {
		name  string
		flags map[string]bool
		err   error
	}{
		{name: "flag explicitly false", flags: map[string]bool{AutomationRulesFeatureFlag: false}},
		{name: "flag absent", flags: map[string]bool{}},
		{name: "preferences unreadable", err: errors.New("preferences store down")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := DaemonAPI{
				AutomationRuleService:   gateStubAutomationRuleService{},
				CollaborationRunService: gateStubCollaborationRunService{},
				PreferencesService:      gateTestPreferences(tc.flags, tc.err),
			}
			createResponse, err := api.CreateAutomationRule(ctx, tuttigenerated.CreateAutomationRuleRequestObject{WorkspaceID: workspaceID})
			if err != nil {
				t.Fatalf("CreateAutomationRule() error = %v", err)
			}
			rejected, ok := createResponse.(tuttigenerated.CreateAutomationRule400JSONResponse)
			if !ok {
				t.Fatalf("CreateAutomationRule() response = %T, want 400 rejection", createResponse)
			}
			if reason := tuttigenerated.ApiErrorResponse(rejected.InvalidRequestErrorJSONResponse).Error.Reason; reason == nil || *reason != "automation_rules_disabled" {
				t.Fatalf("CreateAutomationRule() rejection reason = %v, want automation_rules_disabled", reason)
			}

			updateResponse, err := api.UpdateAutomationRule(ctx, tuttigenerated.UpdateAutomationRuleRequestObject{WorkspaceID: workspaceID, AutomationRuleID: "automation-rule:one"})
			if err != nil {
				t.Fatalf("UpdateAutomationRule() error = %v", err)
			}
			if _, ok := updateResponse.(tuttigenerated.UpdateAutomationRule400JSONResponse); !ok {
				t.Fatalf("UpdateAutomationRule() response = %T, want 400 rejection", updateResponse)
			}

			deleteResponse, err := api.DeleteAutomationRule(ctx, tuttigenerated.DeleteAutomationRuleRequestObject{WorkspaceID: workspaceID, AutomationRuleID: "automation-rule:one"})
			if err != nil {
				t.Fatalf("DeleteAutomationRule() error = %v", err)
			}
			if _, ok := deleteResponse.(tuttigenerated.DeleteAutomationRule400JSONResponse); !ok {
				t.Fatalf("DeleteAutomationRule() response = %T, want 400 rejection", deleteResponse)
			}

			overrideResponse, err := api.SetAgentSessionAutomationRuleOverride(ctx, tuttigenerated.SetAgentSessionAutomationRuleOverrideRequestObject{WorkspaceID: workspaceID, AgentSessionID: "session-1"})
			if err != nil {
				t.Fatalf("SetAgentSessionAutomationRuleOverride() error = %v", err)
			}
			if _, ok := overrideResponse.(tuttigenerated.SetAgentSessionAutomationRuleOverride400JSONResponse); !ok {
				t.Fatalf("SetAgentSessionAutomationRuleOverride() response = %T, want 400 rejection", overrideResponse)
			}

			collabCreateResponse, err := api.CreateCollaborationRun(ctx, tuttigenerated.CreateCollaborationRunRequestObject{WorkspaceID: workspaceID})
			if err != nil {
				t.Fatalf("CreateCollaborationRun() error = %v", err)
			}
			if _, ok := collabCreateResponse.(tuttigenerated.CreateCollaborationRun400JSONResponse); !ok {
				t.Fatalf("CreateCollaborationRun() response = %T, want 400 rejection", collabCreateResponse)
			}

			adoptionResponse, err := api.SetCollaborationRunAdoption(ctx, tuttigenerated.SetCollaborationRunAdoptionRequestObject{WorkspaceID: workspaceID, CollaborationRunID: "run-1"})
			if err != nil {
				t.Fatalf("SetCollaborationRunAdoption() error = %v", err)
			}
			if _, ok := adoptionResponse.(tuttigenerated.SetCollaborationRunAdoption400JSONResponse); !ok {
				t.Fatalf("SetCollaborationRunAdoption() response = %T, want 400 rejection", adoptionResponse)
			}

			cancelResponse, err := api.CancelCollaborationRun(ctx, tuttigenerated.CancelCollaborationRunRequestObject{WorkspaceID: workspaceID, CollaborationRunID: "run-1"})
			if err != nil {
				t.Fatalf("CancelCollaborationRun() error = %v", err)
			}
			if _, ok := cancelResponse.(tuttigenerated.CancelCollaborationRun400JSONResponse); !ok {
				t.Fatalf("CancelCollaborationRun() response = %T, want 400 rejection", cancelResponse)
			}
		})
	}
}

func TestAutomationRulesWriteGateKeepsReadsWorkingWhenFlagOff(t *testing.T) {
	t.Parallel()

	api := DaemonAPI{
		AutomationRuleService:   gateStubAutomationRuleService{},
		CollaborationRunService: gateStubCollaborationRunService{},
		PreferencesService:      gateTestPreferences(map[string]bool{}, nil),
	}
	rulesResponse, err := api.ListAutomationRules(context.Background(), tuttigenerated.ListAutomationRulesRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("ListAutomationRules() error = %v", err)
	}
	if _, ok := rulesResponse.(tuttigenerated.ListAutomationRules200JSONResponse); !ok {
		t.Fatalf("ListAutomationRules() response = %T, want 200 with writes gated", rulesResponse)
	}
	runsResponse, err := api.ListCollaborationRuns(context.Background(), tuttigenerated.ListCollaborationRunsRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("ListCollaborationRuns() error = %v", err)
	}
	if _, ok := runsResponse.(tuttigenerated.ListCollaborationRuns200JSONResponse); !ok {
		t.Fatalf("ListCollaborationRuns() response = %T, want 200 with writes gated", runsResponse)
	}
	overrideResponse, err := api.GetAgentSessionAutomationRuleOverride(context.Background(), tuttigenerated.GetAgentSessionAutomationRuleOverrideRequestObject{WorkspaceID: "ws-1", AgentSessionID: "session-1"})
	if err != nil {
		t.Fatalf("GetAgentSessionAutomationRuleOverride() error = %v", err)
	}
	if _, ok := overrideResponse.(tuttigenerated.GetAgentSessionAutomationRuleOverride200JSONResponse); !ok {
		t.Fatalf("GetAgentSessionAutomationRuleOverride() response = %T, want 200 with writes gated", overrideResponse)
	}
}

func TestAutomationRulesWriteGateAllowsWritesWhenFlagOn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// Nil services: reaching the 503 service-unavailable branch proves the
	// gate passed the request through to the handler.
	api := DaemonAPI{
		PreferencesService: gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}
	createResponse, err := api.CreateAutomationRule(ctx, tuttigenerated.CreateAutomationRuleRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("CreateAutomationRule() error = %v", err)
	}
	if _, ok := createResponse.(tuttigenerated.CreateAutomationRule503JSONResponse); !ok {
		t.Fatalf("CreateAutomationRule() response = %T, want 503 passthrough with flag on", createResponse)
	}
	collabCreateResponse, err := api.CreateCollaborationRun(ctx, tuttigenerated.CreateCollaborationRunRequestObject{WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("CreateCollaborationRun() error = %v", err)
	}
	if _, ok := collabCreateResponse.(tuttigenerated.CreateCollaborationRun503JSONResponse); !ok {
		t.Fatalf("CreateCollaborationRun() response = %T, want 503 passthrough with flag on", collabCreateResponse)
	}
}
