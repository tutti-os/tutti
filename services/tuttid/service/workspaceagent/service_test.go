package workspaceagent

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type memoryAgentStore struct {
	agents map[string]workspaceagentbiz.Agent
}

func (*memoryAgentStore) key(workspaceID string, agentID string) string {
	return workspaceID + "\x00" + agentID
}

func (s *memoryAgentStore) PutWorkspaceAgent(_ context.Context, agent workspaceagentbiz.Agent) error {
	if s.agents == nil {
		s.agents = map[string]workspaceagentbiz.Agent{}
	}
	s.agents[s.key(agent.WorkspaceID, agent.ID)] = workspaceagentbiz.Clone(agent)
	return nil
}

func (s *memoryAgentStore) GetWorkspaceAgent(_ context.Context, workspaceID string, agentID string) (workspaceagentbiz.Agent, error) {
	agent, ok := s.agents[s.key(workspaceID, agentID)]
	if !ok {
		return workspaceagentbiz.Agent{}, workspacedata.ErrWorkspaceAgentNotFound
	}
	return workspaceagentbiz.Clone(agent), nil
}

func (s *memoryAgentStore) ListWorkspaceAgents(_ context.Context, workspaceID string) ([]workspaceagentbiz.Agent, error) {
	result := []workspaceagentbiz.Agent{}
	for _, agent := range s.agents {
		if agent.WorkspaceID == workspaceID {
			result = append(result, workspaceagentbiz.Clone(agent))
		}
	}
	return result, nil
}

func (s *memoryAgentStore) ListWorkspaceAgentsByModelPlan(_ context.Context, workspaceID string, planID string) ([]workspaceagentbiz.Agent, error) {
	result := []workspaceagentbiz.Agent{}
	for _, agent := range s.agents {
		usesPlan := agent.ModelPlanID == planID
		for _, fallback := range agent.ModelFallbacks {
			usesPlan = usesPlan || fallback.ModelPlanID == planID
		}
		if agent.WorkspaceID == workspaceID && usesPlan {
			result = append(result, workspaceagentbiz.Clone(agent))
		}
	}
	return result, nil
}

func (s *memoryAgentStore) DeleteWorkspaceAgent(_ context.Context, workspaceID string, agentID string) error {
	key := s.key(workspaceID, agentID)
	if _, ok := s.agents[key]; !ok {
		return workspacedata.ErrWorkspaceAgentNotFound
	}
	delete(s.agents, key)
	return nil
}

type staticTargets map[string]agenttargetbiz.Target

func (s staticTargets) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s[id]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

type staticPlans map[string]modelplanbiz.Plan

func (s staticPlans) GetModelPlan(_ context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error) {
	plan, ok := s[workspaceID+"\x00"+planID]
	if !ok {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanNotFound
	}
	return plan, nil
}

type recordingConfigurationPublisher struct {
	workspaceID   string
	agentTargetID string
	defaultModel  string
	resetModel    bool
}

func (p *recordingConfigurationPublisher) PublishAgentModelConfigurationChanged(_ context.Context, workspaceID string, agentTargetIDs []string, defaultModels map[string]string, resetModel bool) error {
	p.workspaceID = workspaceID
	p.resetModel = resetModel
	if len(agentTargetIDs) > 0 {
		p.agentTargetID = agentTargetIDs[0]
		p.defaultModel = defaultModels[p.agentTargetID]
	}
	return nil
}

func testWorkspaceAgentService() (*Service, *memoryAgentStore) {
	store := &memoryAgentStore{agents: map[string]workspaceagentbiz.Agent{}}
	return &Service{
		Store: store,
		Targets: staticTargets{
			"local:codex": {
				ID:            "local:codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				IconKey:       "codex",
				Enabled:       true,
				Source:        agenttargetbiz.SourceSystem,
			},
		},
		Plans: staticPlans{
			"ws\x00mp-one": {
				ID:           "mp-one",
				WorkspaceID:  "ws",
				Revision:     7,
				Protocol:     modelplanbiz.ProtocolOpenAI,
				Models:       []modelplanbiz.Model{{ID: "gpt-5", Name: "GPT-5"}},
				DefaultModel: "gpt-5",
				Enabled:      true,
			},
		},
		Now:   func() time.Time { return time.Unix(1700000000, 0).UTC() },
		NewID: func() string { return "one" },
	}, store
}

func TestServiceCreateAndResolve(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	publisher := &recordingConfigurationPublisher{}
	service.Publisher = publisher
	view, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 " Builder ",
		Purpose:              "Implement safely",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		Instructions:         " Keep changes focused. ",
		Skills:               []string{"go", " go "},
		Tools:                []string{"git"},
		Permissions:          []string{"workspace-write"},
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if view.Agent.ID != "workspace-agent:one" || view.Agent.Revision != 1 || view.Agent.Name != "Builder" {
		t.Fatalf("Create() agent = %#v", view.Agent)
	}
	if !view.Harness.Available || view.Harness.Provider != "codex" || view.Harness.IconKey != "codex" {
		t.Fatalf("Create() harness = %#v", view.Harness)
	}
	if publisher.workspaceID != "ws" || publisher.agentTargetID != view.Agent.ID || publisher.defaultModel != "gpt-5" || !publisher.resetModel {
		t.Fatalf("Create() configuration event = %#v", publisher)
	}

	resolved, err := service.Resolve(context.Background(), "ws", view.Agent.ID)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.Agent.Revision != 1 || resolved.HarnessTarget.ID != "local:codex" {
		t.Fatalf("Resolve() identity = %#v", resolved)
	}
	if resolved.ModelPlan == nil || resolved.ModelPlan.Revision != 7 || resolved.EffectiveModel != "gpt-5" {
		t.Fatalf("Resolve() model configuration = %#v", resolved)
	}
	if resolved.Agent.Instructions != "Keep changes focused." || len(resolved.Agent.Skills) != 1 {
		t.Fatalf("Resolve() Agent configuration = %#v", resolved.Agent)
	}
}

func TestServiceUpdateReplacesAndIncrementsRevision(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		DefaultModel:         "gpt-5",
		Skills:               []string{"go"},
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	updated, err := service.Update(context.Background(), PutInput{
		WorkspaceID:          "ws",
		AgentID:              created.Agent.ID,
		Name:                 "Builder v2",
		HarnessAgentTargetID: "local:codex",
		Enabled:              false,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Agent.Revision != 2 || updated.Agent.ModelPlanID != "" || updated.Agent.DefaultModel != "" {
		t.Fatalf("Update() replacement = %#v", updated.Agent)
	}
	if updated.Agent.Skills == nil || len(updated.Agent.Skills) != 0 || updated.Agent.Enabled {
		t.Fatalf("Update() lists/enabled = %#v", updated.Agent)
	}
	if _, err := service.Resolve(context.Background(), "ws", created.Agent.ID); !errors.Is(err, ErrAgentDisabled) {
		t.Fatalf("Resolve() disabled error = %v", err)
	}
}

func TestServiceUpdateInvalidatesWithoutResetWhenModelSelectionIsUnchanged(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		DefaultModel:         "gpt-5",
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	publisher := &recordingConfigurationPublisher{}
	service.Publisher = publisher
	_, err = service.Update(context.Background(), PutInput{
		WorkspaceID:          "ws",
		AgentID:              created.Agent.ID,
		Name:                 "Renamed Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		DefaultModel:         "gpt-5",
		Instructions:         "New instructions",
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if publisher.agentTargetID != created.Agent.ID || publisher.resetModel {
		t.Fatalf("Update() configuration event = %#v, want invalidate without model reset", publisher)
	}
}

func TestServiceRejectsHarnessPlanProtocolMismatch(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	service.Plans = staticPlans{
		"ws\x00mp-anthropic": {
			ID:          "mp-anthropic",
			WorkspaceID: "ws",
			Protocol:    modelplanbiz.ProtocolAnthropic,
			Enabled:     true,
		},
	}
	_, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Wrong",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-anthropic",
		Enabled:              true,
	})
	if !errors.Is(err, ErrHarnessPlanProtocolMismatch) {
		t.Fatalf("Create() error = %v, want protocol mismatch", err)
	}
}

func TestServiceRejectsEnabledAgentWithDisabledRuntimeDependencies(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	service.Targets = staticTargets{
		"local:codex": {
			ID:            "local:codex",
			Provider:      "codex",
			LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
			Name:          "Codex",
			Enabled:       false,
			Source:        agenttargetbiz.SourceSystem,
		},
	}
	_, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Unavailable harness",
		HarnessAgentTargetID: "local:codex",
		Enabled:              true,
	})
	if !errors.Is(err, ErrHarnessDisabled) {
		t.Fatalf("Create() disabled harness error = %v", err)
	}

	service, _ = testWorkspaceAgentService()
	service.Plans = staticPlans{
		"ws\x00mp-one": {
			ID:          "mp-one",
			WorkspaceID: "ws",
			Protocol:    modelplanbiz.ProtocolOpenAI,
			Enabled:     false,
		},
	}
	_, err = service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Unavailable plan",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		Enabled:              true,
	})
	if !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("Create() disabled plan error = %v", err)
	}
}

func TestServiceResolveUsesExplicitFallbackForNewSession(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	plans := service.Plans.(staticPlans)
	plans["ws\x00mp-fallback"] = modelplanbiz.Plan{
		ID:           "mp-fallback",
		WorkspaceID:  "ws",
		Revision:     3,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		Models:       []modelplanbiz.Model{{ID: "gpt-fallback", Name: "GPT Fallback"}},
		DefaultModel: "gpt-fallback",
		Enabled:      true,
	}
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Resilient Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		ModelFallbacks: []workspaceagentbiz.ModelRef{{
			ModelPlanID: "mp-fallback",
		}},
		Enabled: true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	primary := plans["ws\x00mp-one"]
	primary.Enabled = false
	plans["ws\x00mp-one"] = primary

	resolved, err := service.Resolve(context.Background(), "ws", created.Agent.ID)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.ModelPlan == nil || resolved.ModelPlan.ID != "mp-fallback" || resolved.EffectiveModel != "gpt-fallback" {
		t.Fatalf("Resolve() = %#v, want explicit fallback", resolved)
	}
	references, err := service.ListModelPlanReferences(context.Background(), "ws", "mp-fallback")
	if err != nil || len(references) != 1 || references[0].Role != "fallback" {
		t.Fatalf("ListModelPlanReferences(fallback) = %#v, %v", references, err)
	}
}

func TestServiceGetKeepsMissingHarnessRepairable(t *testing.T) {
	service, store := testWorkspaceAgentService()
	now := time.Unix(1700000000, 0).UTC()
	if err := store.PutWorkspaceAgent(context.Background(), workspaceagentbiz.Agent{
		ID:                   "workspace-agent:missing",
		WorkspaceID:          "ws",
		Name:                 "Repair me",
		HarnessAgentTargetID: "local:gone",
		Enabled:              true,
		Source:               workspaceagentbiz.SourceUser,
		Revision:             1,
		CreatedAt:            now,
		UpdatedAt:            now,
	}); err != nil {
		t.Fatalf("PutWorkspaceAgent() error = %v", err)
	}
	view, err := service.Get(context.Background(), "ws", "workspace-agent:missing")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if view.Harness.Available || view.Harness.AgentTargetID != "local:gone" {
		t.Fatalf("Get() harness = %#v", view.Harness)
	}
	if _, err := service.Resolve(context.Background(), "ws", "workspace-agent:missing"); !errors.Is(err, ErrHarnessUnavailable) {
		t.Fatalf("Resolve() error = %v, want harness unavailable", err)
	}
}

func TestServiceListsWorkspaceAgentModelPlanReferences(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	references, err := service.ListModelPlanReferences(context.Background(), "ws", "mp-one")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 1 || references[0].Kind != modelplanbiz.ReferenceWorkspaceAgent || references[0].ID != created.Agent.ID {
		t.Fatalf("ListModelPlanReferences() = %#v", references)
	}
}

func TestServiceResolvesWorkspaceAgentDefaultsForPlanChangeEvents(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Builder",
		HarnessAgentTargetID: "local:codex",
		ModelPlanID:          "mp-one",
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	defaults, err := service.ResolveBoundAgentTargetDefaultModels(context.Background(), "ws", "mp-one")
	if err != nil {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() error = %v", err)
	}
	if defaults[created.Agent.ID] != "gpt-5" {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() = %#v", defaults)
	}
}

func TestServiceValidatesAutomationAgentReferenceStrictly(t *testing.T) {
	service, _ := testWorkspaceAgentService()
	created, err := service.Create(context.Background(), PutInput{
		WorkspaceID:          "ws",
		Name:                 "Reviewer",
		HarnessAgentTargetID: "local:codex",
		Enabled:              true,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := service.ValidateAutomationAgentReference(context.Background(), "ws", created.Agent.ID); err != nil {
		t.Fatalf("ValidateAutomationAgentReference() error = %v", err)
	}
	_, err = service.Update(context.Background(), PutInput{
		WorkspaceID:          "ws",
		AgentID:              created.Agent.ID,
		Name:                 "Reviewer",
		HarnessAgentTargetID: "local:codex",
		Enabled:              false,
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if err := service.ValidateAutomationAgentReference(context.Background(), "ws", created.Agent.ID); !errors.Is(err, ErrAgentDisabled) {
		t.Fatalf("ValidateAutomationAgentReference() error = %v, want ErrAgentDisabled", err)
	}
}

func TestPutCapabilitySelectionDistinguishesAutomaticAndExplicitNone(t *testing.T) {
	falseValue := false
	trueValue := true

	automatic := PutInput{
		CapabilitiesExplicit: &falseValue,
		Skills:               []string{"reviewer"},
		Tools:                []string{"connector:github"},
	}
	if putCapabilitiesExplicit(automatic, true) {
		t.Fatal("explicit false should restore automatic selection")
	}
	if skills, tools := putCapabilitySelections(automatic, false); len(skills) != 0 || len(tools) != 0 {
		t.Fatalf("automatic selections = %#v/%#v, want empty", skills, tools)
	}

	explicitNone := PutInput{CapabilitiesExplicit: &trueValue}
	if !putCapabilitiesExplicit(explicitNone, false) {
		t.Fatal("explicit true should preserve an empty allowlist")
	}

	legacy := PutInput{Skills: []string{"reviewer"}}
	if !putCapabilitiesExplicit(legacy, false) {
		t.Fatal("legacy non-empty selection should remain explicit")
	}
}
