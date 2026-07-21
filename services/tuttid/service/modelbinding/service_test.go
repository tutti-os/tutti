package modelbinding

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type memoryBindingStore struct {
	mu       sync.Mutex
	bindings map[string]modelbindingbiz.Binding
}

func newMemoryBindingStore() *memoryBindingStore {
	return &memoryBindingStore{bindings: map[string]modelbindingbiz.Binding{}}
}

func (*memoryBindingStore) key(workspaceID string, agentTargetID string) string {
	return workspaceID + "/" + agentTargetID
}

func (s *memoryBindingStore) ListAgentModelBindings(_ context.Context, workspaceID string) ([]modelbindingbiz.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var bindings []modelbindingbiz.Binding
	for _, binding := range s.bindings {
		if binding.WorkspaceID == workspaceID {
			bindings = append(bindings, binding)
		}
	}
	return bindings, nil
}

func (s *memoryBindingStore) ListAgentModelBindingsByPlan(_ context.Context, workspaceID string, planID string) ([]modelbindingbiz.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var bindings []modelbindingbiz.Binding
	for _, binding := range s.bindings {
		if binding.WorkspaceID == workspaceID && binding.ModelPlanID == planID {
			bindings = append(bindings, binding)
		}
	}
	return bindings, nil
}

func (s *memoryBindingStore) GetAgentModelBinding(_ context.Context, workspaceID string, agentTargetID string) (modelbindingbiz.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[s.key(workspaceID, agentTargetID)]
	if !ok {
		return modelbindingbiz.Binding{}, workspacedata.ErrAgentModelBindingNotFound
	}
	return binding, nil
}

func (s *memoryBindingStore) PutAgentModelBinding(_ context.Context, binding modelbindingbiz.Binding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bindings[s.key(binding.WorkspaceID, binding.AgentTargetID)] = binding
	return nil
}

func (s *memoryBindingStore) DeleteAgentModelBinding(_ context.Context, workspaceID string, agentTargetID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(workspaceID, agentTargetID)
	if _, ok := s.bindings[key]; !ok {
		return workspacedata.ErrAgentModelBindingNotFound
	}
	delete(s.bindings, key)
	return nil
}

type staticPlans struct {
	plans map[string]modelplanbiz.Plan
}

func (staticPlans) ListModelPlans(context.Context, string) ([]modelplanbiz.Plan, error) {
	return nil, nil
}

func (s staticPlans) GetModelPlan(_ context.Context, _ string, planID string) (modelplanbiz.Plan, error) {
	plan, ok := s.plans[planID]
	if !ok {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanNotFound
	}
	return plan, nil
}

func (staticPlans) PutModelPlan(context.Context, modelplanbiz.Plan) error { return nil }
func (staticPlans) DeleteModelPlan(context.Context, string, string) error {
	return nil
}

type staticTargets struct {
	targets map[string]agenttargetbiz.Target
}

func (s staticTargets) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s.targets[id]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

func newBindingTestService(store *memoryBindingStore) *Service {
	return &Service{
		Store: store,
		Plans: staticPlans{plans: map[string]modelplanbiz.Plan{
			"mp-1": {
				ID:          "mp-1",
				WorkspaceID: "ws",
				Name:        "Plan One",
				Protocol:    modelplanbiz.ProtocolOpenAI,
				Models:      []modelplanbiz.Model{{ID: "model-a", Name: "Model A"}},
			},
		}},
		Targets: staticTargets{targets: map[string]agenttargetbiz.Target{
			"local:codex":    {ID: "local:codex", Provider: "codex", Name: "Codex"},
			"local:claude":   {ID: "local:claude", Provider: "claude-code", Name: "Claude Code"},
			"local:opencode": {ID: "local:opencode", Provider: "opencode", Name: "OpenCode"},
		}},
		Now: func() time.Time { return time.UnixMilli(1700000000000).UTC() },
	}
}

func TestSetBindingValidatesPlanAndModel(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryBindingStore()
	service := newBindingTestService(store)

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-missing",
	}); !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("SetBinding(missing plan) error = %v, want ErrPlanNotUsable", err)
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-1",
		DefaultModel:  "model-unknown",
	}); !errors.Is(err, ErrModelNotInPlan) {
		t.Fatalf("SetBinding(unknown model) error = %v, want ErrModelNotInPlan", err)
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:missing",
		ModelPlanID:   "mp-1",
	}); !errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
		t.Fatalf("SetBinding(missing target) error = %v, want ErrAgentTargetNotFound", err)
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:claude",
		ModelPlanID:   "mp-1",
	}); !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("SetBinding(protocol mismatch) error = %v, want ErrPlanNotUsable", err)
	}

	if _, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:opencode",
		ModelPlanID:   "mp-1",
	}); !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("SetBinding(unsupported provider) error = %v, want ErrPlanNotUsable", err)
	}

	binding, err := service.SetBinding(ctx, SetBindingInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		ModelPlanID:   "mp-1",
		DefaultModel:  "model-a",
	})
	if err != nil {
		t.Fatalf("SetBinding() error = %v", err)
	}
	if binding.ModelPlanID != "mp-1" || binding.DefaultModel != "model-a" {
		t.Fatalf("SetBinding() = %#v", binding)
	}

	references, err := service.ListModelPlanReferences(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 1 || references[0].Kind != modelplanbiz.ReferenceAgentTarget || references[0].ID != "local:codex" || references[0].Name != "Codex" {
		t.Fatalf("ListModelPlanReferences() = %#v", references)
	}

	// Clearing removes the binding and the reference.
	if _, err := service.SetBinding(ctx, SetBindingInput{WorkspaceID: "ws", AgentTargetID: "local:codex"}); err != nil {
		t.Fatalf("SetBinding(clear) error = %v", err)
	}
	references, err = service.ListModelPlanReferences(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences(after clear) error = %v", err)
	}
	if len(references) != 0 {
		t.Fatalf("references after clear = %#v", references)
	}
}
