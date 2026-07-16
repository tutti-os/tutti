package modelplan

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type planConfigurationChange struct {
	workspaceID        string
	agentTargetIDs     []string
	defaultModels      map[string]string
	resetComposerModel bool
}

type recordingPlanConfigurationPublisher struct {
	changes []planConfigurationChange
}

func (p *recordingPlanConfigurationPublisher) PublishAgentModelConfigurationChanged(
	_ context.Context,
	workspaceID string,
	agentTargetIDs []string,
	defaultModels map[string]string,
	resetComposerModel bool,
) error {
	p.changes = append(p.changes, planConfigurationChange{
		workspaceID:        workspaceID,
		agentTargetIDs:     append([]string(nil), agentTargetIDs...),
		defaultModels:      clonePlanDefaultModels(defaultModels),
		resetComposerModel: resetComposerModel,
	})
	return nil
}

type currentPlanDefaultsResolver struct {
	store  *memoryPlanStore
	target string
}

func (r currentPlanDefaultsResolver) ResolveBoundAgentTargetDefaultModels(ctx context.Context, workspaceID string, planID string) (map[string]string, error) {
	plan, err := r.store.GetModelPlan(ctx, workspaceID, planID)
	if err != nil {
		return nil, err
	}
	model := plan.DefaultModel
	if !plan.Enabled {
		model = ""
	} else if model == "" && len(plan.Models) > 0 {
		model = plan.Models[0].ID
	}
	return map[string]string{r.target: model}, nil
}

func TestPlanMutationsPublishAffectedTargetDefaultsAndResetIntent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		Name:         "Plan",
		Protocol:     "openai",
		Models:       []modelplanbiz.Model{{ID: "model-a"}, {ID: "model-b"}},
		DefaultModel: "model-a",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}

	publisher := &recordingPlanConfigurationPublisher{}
	service.Bindings = currentPlanDefaultsResolver{store: store, target: "local:codex"}
	service.ConfigurationPublisher = publisher

	if _, err := service.UpdatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		PlanID:       created.ID,
		Name:         "Plan",
		Protocol:     "openai",
		Models:       []modelplanbiz.Model{{ID: "model-a"}, {ID: "model-b"}},
		DefaultModel: "model-b",
		Enabled:      true,
	}); err != nil {
		t.Fatalf("UpdatePlan(default) error = %v", err)
	}
	if _, err := service.UpdatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		PlanID:       created.ID,
		Name:         "Plan renamed",
		Protocol:     "openai",
		Models:       []modelplanbiz.Model{{ID: "model-a"}, {ID: "model-b"}},
		DefaultModel: "model-b",
		Enabled:      true,
	}); err != nil {
		t.Fatalf("UpdatePlan(rename) error = %v", err)
	}
	if _, err := service.SetPlanEnabled(ctx, "ws", created.ID, false); err != nil {
		t.Fatalf("SetPlanEnabled() error = %v", err)
	}
	if err := service.MarkFirstUse(ctx, "ws", created.ID, "local:codex", "session-1", "model-b"); err != nil {
		t.Fatalf("MarkFirstUse() error = %v", err)
	}

	if len(publisher.changes) != 3 {
		t.Fatalf("published changes = %#v, want three", publisher.changes)
	}
	for index, change := range publisher.changes {
		if change.workspaceID != "ws" || len(change.agentTargetIDs) != 1 || change.agentTargetIDs[0] != "local:codex" {
			t.Fatalf("change[%d] = %#v", index, change)
		}
	}
	if publisher.changes[0].defaultModels["local:codex"] != "model-b" || publisher.changes[1].defaultModels["local:codex"] != "model-b" {
		t.Fatalf("enabled plan defaults = %#v, want model-b", publisher.changes[:2])
	}
	if publisher.changes[2].defaultModels["local:codex"] != "" {
		t.Fatalf("disabled plan default = %#v, want provider-native empty model", publisher.changes[2])
	}
	if !publisher.changes[0].resetComposerModel {
		t.Fatal("default-model update did not request composer reset")
	}
	if publisher.changes[1].resetComposerModel {
		t.Fatal("name-only update requested composer reset")
	}
	if !publisher.changes[2].resetComposerModel {
		t.Fatal("enable-state update did not request composer reset")
	}
}

func TestDetectPublishesAffectedTargetConfiguration(t *testing.T) {
	t.Parallel()

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"model-a"}]}`))
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer fake.Close()

	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)
	service.HTTPClient = fake.Client()
	apiKey := "sk-test"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		Name:         "Plan",
		Protocol:     "openai",
		APIKey:       &apiKey,
		BaseURL:      fake.URL + "/v1",
		Models:       []modelplanbiz.Model{{ID: "model-a"}},
		DefaultModel: "model-a",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}
	publisher := &recordingPlanConfigurationPublisher{}
	service.Bindings = currentPlanDefaultsResolver{store: store, target: "local:codex"}
	service.ConfigurationPublisher = publisher

	if _, err := service.Detect(ctx, DetectInput{WorkspaceID: "ws", PlanID: created.ID}); err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if len(publisher.changes) != 1 || !publisher.changes[0].resetComposerModel || publisher.changes[0].defaultModels["local:codex"] != "model-a" {
		t.Fatalf("detection changes = %#v", publisher.changes)
	}
}

func clonePlanDefaultModels(defaultModels map[string]string) map[string]string {
	cloned := make(map[string]string, len(defaultModels))
	for agentTargetID, model := range defaultModels {
		cloned[agentTargetID] = model
	}
	return cloned
}
