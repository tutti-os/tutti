package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
)

type stubAutomationRuleService struct {
	rules       []automationrulebiz.Rule
	rule        automationrulebiz.Rule
	override    automationrulebiz.SessionOverride
	hasOverride bool
	err         error
	putInput    automationruleservice.PutRuleInput
	setOverride automationrulebiz.SessionOverride
	getCalls    int
	updateCalls int
}

func (s *stubAutomationRuleService) ListRules(context.Context, string) ([]automationrulebiz.Rule, error) {
	return s.rules, s.err
}

func (s *stubAutomationRuleService) GetRule(context.Context, string, string) (automationrulebiz.Rule, error) {
	s.getCalls++
	return s.rule, s.err
}

func (s *stubAutomationRuleService) CreateRule(_ context.Context, input automationruleservice.PutRuleInput) (automationrulebiz.Rule, error) {
	s.putInput = input
	return s.rule, s.err
}

func (s *stubAutomationRuleService) UpdateRule(_ context.Context, input automationruleservice.PutRuleInput) (automationrulebiz.Rule, error) {
	s.updateCalls++
	s.putInput = input
	return s.rule, s.err
}

func TestUpdateAutomationRuleDelegatesExistenceCheckToService(t *testing.T) {
	service := &stubAutomationRuleService{err: workspacedata.ErrAutomationRuleNotFound}
	api := DaemonAPI{
		AutomationRuleService: service,
		PreferencesService:    gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}
	response, err := api.UpdateAutomationRule(context.Background(), tuttigenerated.UpdateAutomationRuleRequestObject{
		WorkspaceID: "ws", AutomationRuleID: "automation-rule:missing",
		Body: &tuttigenerated.PutAutomationRuleRequest{
			Name: "Missing", Trigger: tuttigenerated.AutomationRuleTriggerOnTaskComplete,
			Target:      tuttigenerated.AutomationRuleTarget{Kind: tuttigenerated.AutomationRuleTargetKindAgent, WorkspaceAgentId: stringPointer("workspace-agent:target")},
			Permissions: tuttigenerated.AutomationRulePermissions{},
			Budget:      tuttigenerated.AutomationRuleBudget{},
		},
	})
	if err != nil {
		t.Fatalf("UpdateAutomationRule() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.UpdateAutomationRule404JSONResponse); !ok {
		t.Fatalf("UpdateAutomationRule() response = %T", response)
	}
	if service.getCalls != 0 || service.updateCalls != 1 {
		t.Fatalf("service calls get=%d update=%d, want 0/1", service.getCalls, service.updateCalls)
	}
}

func (s *stubAutomationRuleService) DeleteRule(context.Context, string, string) error { return s.err }

func (s *stubAutomationRuleService) GetSessionOverride(context.Context, string, string) (automationrulebiz.SessionOverride, bool, error) {
	return s.override, s.hasOverride, s.err
}

func (s *stubAutomationRuleService) SetSessionOverride(_ context.Context, override automationrulebiz.SessionOverride) (automationrulebiz.SessionOverride, error) {
	s.setOverride = override
	return s.override, s.err
}

func testAutomationRule() automationrulebiz.Rule {
	now := time.Unix(1_700_000_000, 0).UTC()
	return automationrulebiz.Rule{
		ID: "automation-rule:one", WorkspaceID: "ws", Name: "Launch follow-up", Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskComplete,
		Target: automationrulebiz.Target{
			Kind: automationrulebiz.TargetAgent, WorkspaceAgentID: "workspace-agent:reviewer",
		},
		Permissions: automationrulebiz.PermissionPolicy{PermissionModeID: "workspace-write", AllowedTools: []string{"terminal"}},
		Budget:      automationrulebiz.Budget{MaxRunsPerSession: 2, MaxTotalTokensPerSession: 40_000},
		Prompt:      "Check correctness", CreatedAt: now, UpdatedAt: now,
	}
}

func TestCreateAutomationRuleMapsRequestAndProjection(t *testing.T) {
	service := &stubAutomationRuleService{rule: testAutomationRule()}
	api := DaemonAPI{
		AutomationRuleService: service,
		PreferencesService:    gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}
	response, err := api.CreateAutomationRule(context.Background(), tuttigenerated.CreateAutomationRuleRequestObject{
		WorkspaceID: "ws",
		Body: &tuttigenerated.PutAutomationRuleRequest{
			Name: "Launch follow-up", Enabled: true,
			Trigger: tuttigenerated.AutomationRuleTriggerOnTaskComplete,
			Target: tuttigenerated.AutomationRuleTarget{
				Kind: tuttigenerated.AutomationRuleTargetKindAgent, WorkspaceAgentId: stringPointer("workspace-agent:reviewer"),
			},
			Permissions: tuttigenerated.AutomationRulePermissions{PermissionModeId: stringPointer("workspace-write"), AllowedTools: []string{"terminal"}},
			Budget:      tuttigenerated.AutomationRuleBudget{MaxRunsPerSession: 2, MaxTotalTokensPerSession: 40_000},
			Prompt:      "Check correctness",
		},
	})
	if err != nil {
		t.Fatalf("CreateAutomationRule() error = %v", err)
	}
	created, ok := response.(tuttigenerated.CreateAutomationRule201JSONResponse)
	if !ok {
		t.Fatalf("CreateAutomationRule() response = %T", response)
	}
	if created.Id != "automation-rule:one" || created.Target.WorkspaceAgentId == nil || *created.Target.WorkspaceAgentId != "workspace-agent:reviewer" {
		t.Fatalf("CreateAutomationRule() projection = %#v", created)
	}
	if service.putInput.Target.WorkspaceAgentID != "workspace-agent:reviewer" || service.putInput.Permissions.PermissionModeID != "workspace-write" {
		t.Fatalf("CreateAutomationRule() input = %#v", service.putInput)
	}
}

func TestGetAutomationRuleReturnsSpecificNotFoundCode(t *testing.T) {
	api := DaemonAPI{
		AutomationRuleService: &stubAutomationRuleService{err: workspacedata.ErrAutomationRuleNotFound},
		PreferencesService:    gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}
	response, err := api.GetAutomationRule(context.Background(), tuttigenerated.GetAutomationRuleRequestObject{
		WorkspaceID: "ws", AutomationRuleID: "automation-rule:missing",
	})
	if err != nil {
		t.Fatalf("GetAutomationRule() error = %v", err)
	}
	notFound, ok := response.(tuttigenerated.GetAutomationRule404JSONResponse)
	if !ok {
		t.Fatalf("GetAutomationRule() response = %T", response)
	}
	if notFound.Error.Code != tuttigenerated.AutomationRuleNotFound {
		t.Fatalf("GetAutomationRule() code = %q", notFound.Error.Code)
	}
}

func TestSetAgentSessionAutomationRuleOverrideMapsRuleSelection(t *testing.T) {
	now := time.Unix(1_700_000_100, 0).UTC()
	service := &stubAutomationRuleService{override: automationrulebiz.SessionOverride{
		WorkspaceID: "ws", AgentSessionID: "session-1", RuleIDs: []string{"rule-1"}, UpdatedAt: now,
	}}
	api := DaemonAPI{
		AutomationRuleService: service,
		PreferencesService:    gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}
	response, err := api.SetAgentSessionAutomationRuleOverride(context.Background(), tuttigenerated.SetAgentSessionAutomationRuleOverrideRequestObject{
		WorkspaceID: "ws", AgentSessionID: "session-1",
		Body: &tuttigenerated.SetAgentSessionAutomationRuleOverrideRequest{RuleIds: []string{"rule-1"}},
	})
	if err != nil {
		t.Fatalf("SetAgentSessionAutomationRuleOverride() error = %v", err)
	}
	updated, ok := response.(tuttigenerated.SetAgentSessionAutomationRuleOverride200JSONResponse)
	if !ok || len(updated.RuleIds) != 1 || updated.RuleIds[0] != "rule-1" || updated.UpdatedAt == nil {
		t.Fatalf("SetAgentSessionAutomationRuleOverride() response = %#v (%T)", response, response)
	}
	if len(service.setOverride.RuleIDs) != 1 || service.setOverride.RuleIDs[0] != "rule-1" {
		t.Fatalf("SetAgentSessionAutomationRuleOverride() input = %#v", service.setOverride)
	}
}

func TestAutomationRuleRoutesAreRegistered(t *testing.T) {
	service := &stubAutomationRuleService{rules: []automationrulebiz.Rule{testAutomationRule()}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AutomationRuleService: service,
		PreferencesService:    gateTestPreferences(map[string]bool{AutomationRulesFeatureFlag: true}, nil),
	}))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/workspaces/ws/automation-rules", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
	}
}

func TestGeneratedModelPlanIncludesRevision(t *testing.T) {
	generated := generatedModelPlan(modelplanbiz.PublicPlan{Revision: 7, Models: []modelplanbiz.Model{}})
	if generated.Revision != 7 {
		t.Fatalf("generatedModelPlan() revision = %d, want 7", generated.Revision)
	}
}
