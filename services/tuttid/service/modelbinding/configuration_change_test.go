package modelbinding

import (
	"context"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type bindingConfigurationChange struct {
	workspaceID        string
	agentTargetIDs     []string
	defaultModels      map[string]string
	resetComposerModel bool
}

type recordingBindingConfigurationPublisher struct {
	changes []bindingConfigurationChange
}

func (p *recordingBindingConfigurationPublisher) PublishAgentModelConfigurationChanged(
	_ context.Context,
	workspaceID string,
	agentTargetIDs []string,
	defaultModels map[string]string,
	resetComposerModel bool,
) error {
	p.changes = append(p.changes, bindingConfigurationChange{
		workspaceID:        workspaceID,
		agentTargetIDs:     append([]string(nil), agentTargetIDs...),
		defaultModels:      cloneDefaultModels(defaultModels),
		resetComposerModel: resetComposerModel,
	})
	return nil
}

func TestSetBindingPublishesEffectiveDefaultForWriteAndClear(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryBindingStore()
	service := newBindingTestService(store)
	service.Plans = staticPlans{plans: map[string]modelplanbiz.Plan{
		"mp-1": {
			ID:           "mp-1",
			WorkspaceID:  "ws",
			Name:         "Plan One",
			Protocol:     modelplanbiz.ProtocolOpenAI,
			Models:       []modelplanbiz.Model{{ID: "model-a"}, {ID: "model-b"}},
			DefaultModel: "model-b",
			Enabled:      true,
		},
	}}
	publisher := &recordingBindingConfigurationPublisher{}
	service.ConfigurationPublisher = publisher

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-missing",
	}); err == nil {
		t.Fatal("SetBinding(missing plan) error = nil")
	}
	if len(publisher.changes) != 0 {
		t.Fatalf("failed write published %d changes, want 0", len(publisher.changes))
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-1",
	}); err != nil {
		t.Fatalf("SetBinding() error = %v", err)
	}
	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-1",
		DefaultModel:  "model-a",
	}); err != nil {
		t.Fatalf("SetBinding(explicit default) error = %v", err)
	}

	resolved, err := service.ResolveBoundAgentTargetDefaultModels(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() error = %v", err)
	}
	if resolved["local:codex"] != "model-a" {
		t.Fatalf("resolved defaults = %#v, want local:codex=model-a", resolved)
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
	}); err != nil {
		t.Fatalf("SetBinding(clear) error = %v", err)
	}

	if len(publisher.changes) != 3 {
		t.Fatalf("published changes = %#v, want two writes and clear", publisher.changes)
	}
	write := publisher.changes[0]
	if write.workspaceID != "ws" || len(write.agentTargetIDs) != 1 || write.agentTargetIDs[0] != "local:codex" || write.defaultModels["local:codex"] != "model-b" || !write.resetComposerModel {
		t.Fatalf("write change = %#v", write)
	}
	explicit := publisher.changes[1]
	if explicit.defaultModels["local:codex"] != "model-a" || !explicit.resetComposerModel {
		t.Fatalf("explicit-default change = %#v", explicit)
	}
	clear := publisher.changes[2]
	if clear.defaultModels["local:codex"] != "" || !clear.resetComposerModel {
		t.Fatalf("clear change = %#v", clear)
	}
}

func TestSetBindingPublishesProviderNativeDefaultForProtocolMismatch(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryBindingStore()
	service := newBindingTestService(store)
	service.Plans = staticPlans{plans: map[string]modelplanbiz.Plan{
		"mp-1": {
			ID:          "mp-1",
			WorkspaceID: "ws",
			Protocol:    modelplanbiz.ProtocolOpenAI,
			Models:      []modelplanbiz.Model{{ID: "model-a"}},
			Enabled:     true,
		},
	}}
	service.Targets = staticTargets{targets: map[string]agenttargetbiz.Target{
		"local:codex": {
			ID:       "local:codex",
			Name:     "Codex",
			Provider: "claude-code",
		},
	}}
	publisher := &recordingBindingConfigurationPublisher{}
	service.ConfigurationPublisher = publisher

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-1",
	}); err != nil {
		t.Fatalf("SetBinding() error = %v", err)
	}
	if len(publisher.changes) != 1 || publisher.changes[0].defaultModels["local:codex"] != "" {
		t.Fatalf("protocol-mismatch change = %#v, want provider-native empty model", publisher.changes)
	}

	resolved, err := service.ResolveBoundAgentTargetDefaultModels(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ResolveBoundAgentTargetDefaultModels() error = %v", err)
	}
	if resolved["local:codex"] != "" {
		t.Fatalf("resolved defaults = %#v, want provider-native empty model", resolved)
	}
}

func cloneDefaultModels(defaultModels map[string]string) map[string]string {
	cloned := make(map[string]string, len(defaultModels))
	for agentTargetID, model := range defaultModels {
		cloned[agentTargetID] = model
	}
	return cloned
}
