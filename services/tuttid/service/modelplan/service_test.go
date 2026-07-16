package modelplan

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type memoryPlanStore struct {
	mu    sync.Mutex
	plans map[string]modelplanbiz.Plan
}

func newMemoryPlanStore() *memoryPlanStore {
	return &memoryPlanStore{plans: map[string]modelplanbiz.Plan{}}
}

func (*memoryPlanStore) key(workspaceID string, planID string) string {
	return workspaceID + "/" + planID
}

func (s *memoryPlanStore) ListModelPlans(_ context.Context, workspaceID string) ([]modelplanbiz.Plan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var plans []modelplanbiz.Plan
	for _, plan := range s.plans {
		if plan.WorkspaceID == workspaceID {
			plans = append(plans, plan)
		}
	}
	return plans, nil
}

func (s *memoryPlanStore) GetModelPlan(_ context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plan, ok := s.plans[s.key(workspaceID, planID)]
	if !ok {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanNotFound
	}
	return plan, nil
}

func (s *memoryPlanStore) PutModelPlan(_ context.Context, plan modelplanbiz.Plan) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plans[s.key(plan.WorkspaceID, plan.ID)] = plan
	return nil
}

func (s *memoryPlanStore) DeleteModelPlan(_ context.Context, workspaceID string, planID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(workspaceID, planID)
	if _, ok := s.plans[key]; !ok {
		return workspacedata.ErrModelPlanNotFound
	}
	delete(s.plans, key)
	return nil
}

type staticReferences struct {
	references []modelplanbiz.Reference
}

type fakeNativeSubscriptionProbe struct {
	input  NativeSubscriptionProbeInput
	result NativeSubscriptionProbeResult
	err    error
}

func (f *fakeNativeSubscriptionProbe) ProbeNativeSubscription(
	_ context.Context,
	input NativeSubscriptionProbeInput,
) (NativeSubscriptionProbeResult, error) {
	f.input = input
	return f.result, f.err
}

func (s staticReferences) ListModelPlanReferences(context.Context, string, string) ([]modelplanbiz.Reference, error) {
	return s.references, nil
}

func newTestService(store workspacedata.ModelPlansStore) *Service {
	counter := 0
	return &Service{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(1700000000000).UTC() },
		NewID: func() string {
			counter++
			return "mp-" + strings.Repeat("x", counter)
		},
	}
}

func TestCreateAndUpdatePlanResetsVerificationOnCredentialChange(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)

	apiKey := "sk-one"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		Name:         "OpenAI Official",
		TemplateKind: "official_subscription",
		Protocol:     "openai",
		APIKey:       &apiKey,
		BaseURL:      "https://api.openai.com/v1",
		Models:       []modelplanbiz.Model{{ID: "gpt-test"}},
		DefaultModel: "gpt-test",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}
	if !created.HasAPIKey || created.Status != modelplanbiz.StatusUndetected {
		t.Fatalf("CreatePlan() = %#v, want hasApiKey && undetected", created)
	}
	if created.Revision != 1 {
		t.Fatalf("CreatePlan() revision = %d, want 1", created.Revision)
	}

	// Simulate a passed detection plus first use.
	stored, _ := store.GetModelPlan(ctx, "ws", created.ID)
	now := time.UnixMilli(1700000000000).UTC()
	for _, stage := range []modelplanbiz.DetectionStage{modelplanbiz.StageNetwork, modelplanbiz.StageAuth, modelplanbiz.StageModelDiscovery, modelplanbiz.StageInference} {
		stored.Detection.Stages = append(stored.Detection.Stages, modelplanbiz.StageResult{Stage: stage, Status: modelplanbiz.StagePassed, CheckedAt: now})
	}
	if err := store.PutModelPlan(ctx, stored); err != nil {
		t.Fatalf("seed detection error = %v", err)
	}
	if err := service.MarkFirstUse(ctx, "ws", created.ID, "local:codex", "session-1", "gpt-test"); err != nil {
		t.Fatalf("MarkFirstUse() error = %v", err)
	}
	afterFirstUse, err := service.GetPlan(ctx, "ws", created.ID)
	if err != nil {
		t.Fatalf("GetPlan() error = %v", err)
	}
	if afterFirstUse.Status != modelplanbiz.StatusReady {
		t.Fatalf("plan status after first use = %q, want ready", afterFirstUse.Status)
	}
	if afterFirstUse.FirstUse.AgentTargetID != "local:codex" {
		t.Fatalf("first use target = %q", afterFirstUse.FirstUse.AgentTargetID)
	}
	if afterFirstUse.Revision != 2 {
		t.Fatalf("revision after first use = %d, want 2", afterFirstUse.Revision)
	}

	// Renaming without credential change keeps verification state.
	renamed, err := service.UpdatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		PlanID:       created.ID,
		Name:         "OpenAI Renamed",
		TemplateKind: "official_subscription",
		Protocol:     "openai",
		BaseURL:      "https://api.openai.com/v1",
		Models:       []modelplanbiz.Model{{ID: "gpt-test"}},
		DefaultModel: "gpt-test",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("UpdatePlan(rename) error = %v", err)
	}
	if renamed.Status != modelplanbiz.StatusReady || !renamed.HasAPIKey {
		t.Fatalf("UpdatePlan(rename) status = %q hasApiKey = %v, want ready/true", renamed.Status, renamed.HasAPIKey)
	}
	if renamed.Revision != 3 {
		t.Fatalf("UpdatePlan(rename) revision = %d, want 3", renamed.Revision)
	}

	// Changing the credential resets detection and first use.
	newKey := "sk-two"
	rotated, err := service.UpdatePlan(ctx, PutPlanInput{
		WorkspaceID:  "ws",
		PlanID:       created.ID,
		Name:         "OpenAI Renamed",
		TemplateKind: "official_subscription",
		Protocol:     "openai",
		APIKey:       &newKey,
		BaseURL:      "https://api.openai.com/v1",
		Models:       []modelplanbiz.Model{{ID: "gpt-test"}},
		DefaultModel: "gpt-test",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("UpdatePlan(rotate) error = %v", err)
	}
	if rotated.Status != modelplanbiz.StatusUndetected {
		t.Fatalf("UpdatePlan(rotate) status = %q, want undetected", rotated.Status)
	}
	if rotated.FirstUse.Status != modelplanbiz.FirstUsePending {
		t.Fatalf("UpdatePlan(rotate) first use = %q, want pending", rotated.FirstUse.Status)
	}
	if rotated.Revision != 4 {
		t.Fatalf("UpdatePlan(rotate) revision = %d, want 4", rotated.Revision)
	}
}

func TestMarkFirstUseFailureReturnsPlanToAgentRuntimeDetectionNode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)
	apiKey := "sk-one"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID: "ws", Name: "Plan", TemplateKind: "custom", Protocol: "openai",
		APIKey: &apiKey, BaseURL: "https://api.example.com/v1",
		Models: []modelplanbiz.Model{{ID: "model-1"}}, DefaultModel: "model-1", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := store.GetModelPlan(ctx, "ws", created.ID)
	for _, stage := range []modelplanbiz.DetectionStage{modelplanbiz.StageNetwork, modelplanbiz.StageAuth, modelplanbiz.StageModelDiscovery, modelplanbiz.StageInference} {
		stored.Detection.Stages = append(stored.Detection.Stages, modelplanbiz.StageResult{Stage: stage, Status: modelplanbiz.StagePassed})
	}
	stored.Detection.Stages = append(stored.Detection.Stages, modelplanbiz.StageResult{Stage: modelplanbiz.StageAgentRuntime, Status: modelplanbiz.StagePending})
	if err := store.PutModelPlan(ctx, stored); err != nil {
		t.Fatal(err)
	}
	if err := service.MarkFirstUseFailure(ctx, "ws", created.ID, "local:codex", "session-failed", "model-1"); err != nil {
		t.Fatalf("MarkFirstUseFailure() error = %v", err)
	}
	failed, err := service.GetPlan(ctx, "ws", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != modelplanbiz.StatusDetectionFailed || failed.FirstUse.Status != modelplanbiz.FirstUsePending {
		t.Fatalf("failed first use plan = %#v", failed)
	}
	runtimeStage, ok := failed.Detection.StageOutcome(modelplanbiz.StageAgentRuntime)
	if !ok || runtimeStage.Status != modelplanbiz.StageFailed || runtimeStage.FailureReason != FailureAgentRuntime || runtimeStage.Remedy != RemedyRetryAgentRuntime {
		t.Fatalf("agent runtime stage = %#v", runtimeStage)
	}
	if err := service.MarkFirstUse(ctx, "ws", created.ID, "local:codex", "session-retry", "model-1"); err != nil {
		t.Fatalf("MarkFirstUse(retry) error = %v", err)
	}
	ready, _ := service.GetPlan(ctx, "ws", created.ID)
	if ready.Status != modelplanbiz.StatusReady {
		t.Fatalf("retry status = %q, want ready", ready.Status)
	}
}

func TestDuplicatePlanProducesDisabledUnverifiedCopy(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)

	apiKey := "sk-dup"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID: "ws",
		Name:        "Relay",
		Protocol:    "anthropic",
		APIKey:      &apiKey,
		BaseURL:     "https://relay.example/v1",
		Enabled:     true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}
	copyPlan, err := service.DuplicatePlan(ctx, "ws", created.ID, "")
	if err != nil {
		t.Fatalf("DuplicatePlan() error = %v", err)
	}
	if copyPlan.ID == created.ID {
		t.Fatalf("DuplicatePlan() reused id %q", copyPlan.ID)
	}
	if copyPlan.Enabled {
		t.Fatalf("DuplicatePlan() enabled = true, want false")
	}
	if copyPlan.Name != "Relay copy" {
		t.Fatalf("DuplicatePlan() name = %q", copyPlan.Name)
	}
	if !copyPlan.HasAPIKey {
		t.Fatalf("DuplicatePlan() should clone the credential")
	}
	if copyPlan.Status != modelplanbiz.StatusDisabled {
		t.Fatalf("DuplicatePlan() status = %q, want disabled", copyPlan.Status)
	}
}

func TestDeletePlanBlockedWhileReferenced(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPlanStore()
	service := newTestService(store)
	service.References = staticReferences{references: []modelplanbiz.Reference{
		{Kind: modelplanbiz.ReferenceAgentTarget, ID: "local:codex", Role: "default"},
	}}

	apiKey := "sk-ref"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID: "ws",
		Name:        "Referenced",
		Protocol:    "openai",
		APIKey:      &apiKey,
		Enabled:     true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}
	if err := service.DeletePlan(ctx, "ws", created.ID); !errors.Is(err, ErrPlanReferenced) {
		t.Fatalf("DeletePlan() error = %v, want ErrPlanReferenced", err)
	}

	service.References = staticReferences{}
	if err := service.DeletePlan(ctx, "ws", created.ID); err != nil {
		t.Fatalf("DeletePlan() after unbind error = %v", err)
	}
}

func TestDetectStagesAgainstFakeOpenAIProvider(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorized := r.Header.Get("Authorization") == "Bearer sk-good"
		switch r.URL.Path {
		case "/v1/models":
			if !authorized {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"fake-mini","display_name":"Fake Mini"}]}`))
		case "/v1/chat/completions":
			if !authorized {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":4,"completion_tokens":1}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer fake.Close()

	store := newMemoryPlanStore()
	service := newTestService(store)
	service.HTTPClient = fake.Client()

	apiKey := "sk-good"
	created, err := service.CreatePlan(ctx, PutPlanInput{
		WorkspaceID: "ws",
		Name:        "Fake",
		Protocol:    "openai",
		APIKey:      &apiKey,
		BaseURL:     fake.URL + "/v1",
		Models:      []modelplanbiz.Model{{ID: "fake-mini"}},
		Enabled:     true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}

	result, err := service.Detect(ctx, DetectInput{WorkspaceID: "ws", PlanID: created.ID})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	assertStage(t, result.Detection, modelplanbiz.StageNetwork, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageAuth, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageModelDiscovery, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageInference, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageAgentRuntime, modelplanbiz.StagePending)
	if len(result.DiscoveredModels) != 1 || result.DiscoveredModels[0].ID != "fake-mini" {
		t.Fatalf("Detect() discovered = %#v", result.DiscoveredModels)
	}

	persisted, err := service.GetPlan(ctx, "ws", created.ID)
	if err != nil {
		t.Fatalf("GetPlan() error = %v", err)
	}
	if persisted.Status != modelplanbiz.StatusPendingFirstUse {
		t.Fatalf("plan status after detection = %q, want pending_first_use", persisted.Status)
	}

	// Wrong key: network passes, auth fails, later stages do not run.
	badKey := "sk-bad"
	badResult, err := service.Detect(ctx, DetectInput{WorkspaceID: "ws", PlanID: created.ID, APIKey: &badKey})
	if err != nil {
		t.Fatalf("Detect(bad key) error = %v", err)
	}
	assertStage(t, badResult.Detection, modelplanbiz.StageNetwork, modelplanbiz.StagePassed)
	assertStage(t, badResult.Detection, modelplanbiz.StageAuth, modelplanbiz.StageFailed)
	assertStage(t, badResult.Detection, modelplanbiz.StageModelDiscovery, modelplanbiz.StageSkipped)
	assertStage(t, badResult.Detection, modelplanbiz.StageInference, modelplanbiz.StageSkipped)
	authStage, _ := badResult.Detection.StageOutcome(modelplanbiz.StageAuth)
	if authStage.FailureReason != FailureUnauthorized || authStage.Remedy != RemedyCheckAPIKey {
		t.Fatalf("auth stage = %#v, want unauthorized/check_api_key", authStage)
	}
}

func TestDetectOfficialSubscriptionUsesNativeProviderProbe(t *testing.T) {
	t.Parallel()

	probe := &fakeNativeSubscriptionProbe{result: NativeSubscriptionProbeResult{
		RuntimeAvailable:   true,
		Authenticated:      true,
		DiscoveredModels:   []modelplanbiz.Model{{ID: "gpt-native", Name: "GPT Native"}},
		InferenceAttempted: true,
		InferencePassed:    true,
		InferenceModel:     "gpt-native",
	}}
	service := newTestService(newMemoryPlanStore())
	service.NativeSubscriptionProbe = probe

	result, err := service.Detect(context.Background(), DetectInput{
		WorkspaceID:  "ws",
		TemplateKind: string(modelplanbiz.TemplateOfficialSubscription),
		Protocol:     string(modelplanbiz.ProtocolOpenAI),
	})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if probe.input.WorkspaceID != "ws" || probe.input.Protocol != modelplanbiz.ProtocolOpenAI {
		t.Fatalf("probe input = %#v", probe.input)
	}
	for _, stage := range []modelplanbiz.DetectionStage{
		modelplanbiz.StageNetwork,
		modelplanbiz.StageAuth,
		modelplanbiz.StageModelDiscovery,
		modelplanbiz.StageInference,
	} {
		assertStage(t, result.Detection, stage, modelplanbiz.StagePassed)
	}
	assertStage(t, result.Detection, modelplanbiz.StageAgentRuntime, modelplanbiz.StagePending)
	if result.Detection.Model != "gpt-native" || len(result.DiscoveredModels) != 1 || result.DiscoveredModels[0].ID != "gpt-native" {
		t.Fatalf("Detect() = %#v", result)
	}
}

func TestDetectStoredOfficialSubscriptionPersistsNativeLoginFailure(t *testing.T) {
	t.Parallel()

	store := newMemoryPlanStore()
	service := newTestService(store)
	service.NativeSubscriptionProbe = &fakeNativeSubscriptionProbe{result: NativeSubscriptionProbeResult{
		RuntimeAvailable: true,
		Authenticated:    false,
		AuthDetail:       "authentication required",
	}}
	created, err := service.CreatePlan(context.Background(), PutPlanInput{
		WorkspaceID:  "ws",
		Name:         "Codex subscription",
		TemplateKind: string(modelplanbiz.TemplateOfficialSubscription),
		Protocol:     string(modelplanbiz.ProtocolOpenAI),
		Models:       []modelplanbiz.Model{{ID: "gpt-native"}},
		DefaultModel: "gpt-native",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("CreatePlan() error = %v", err)
	}

	result, err := service.Detect(context.Background(), DetectInput{
		WorkspaceID: "ws",
		PlanID:      created.ID,
	})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	assertStage(t, result.Detection, modelplanbiz.StageNetwork, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageAuth, modelplanbiz.StageFailed)
	assertStage(t, result.Detection, modelplanbiz.StageModelDiscovery, modelplanbiz.StageSkipped)
	assertStage(t, result.Detection, modelplanbiz.StageInference, modelplanbiz.StageSkipped)
	auth, _ := result.Detection.StageOutcome(modelplanbiz.StageAuth)
	if auth.FailureReason != FailureProviderAuth || auth.Remedy != RemedyLoginProvider {
		t.Fatalf("auth stage = %#v", auth)
	}
	persisted, err := service.GetPlan(context.Background(), "ws", created.ID)
	if err != nil {
		t.Fatalf("GetPlan() error = %v", err)
	}
	if persisted.Status != modelplanbiz.StatusDetectionFailed || persisted.HasAPIKey || persisted.BaseURL != "" {
		t.Fatalf("persisted plan = %#v", persisted)
	}
}

func TestDetectAnthropicProtocolWithoutCatalogFallsBackToInference(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/messages":
			if r.Header.Get("x-api-key") != "sk-anthropic" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":9,"output_tokens":1}}`))
		default:
			// No model catalog endpoint at this relay.
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer fake.Close()

	store := newMemoryPlanStore()
	service := newTestService(store)
	service.HTTPClient = fake.Client()

	apiKey := "sk-anthropic"
	result, err := service.Detect(ctx, DetectInput{
		WorkspaceID: "ws",
		Protocol:    "anthropic",
		BaseURL:     fake.URL + "/v1",
		APIKey:      &apiKey,
		Models:      []modelplanbiz.Model{{ID: "claude-fake"}},
		Model:       "claude-fake",
	})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	assertStage(t, result.Detection, modelplanbiz.StageNetwork, modelplanbiz.StagePassed)
	// Catalog 404 + manual models: discovery is skipped and inference proves
	// the credential.
	assertStage(t, result.Detection, modelplanbiz.StageModelDiscovery, modelplanbiz.StageSkipped)
	assertStage(t, result.Detection, modelplanbiz.StageAuth, modelplanbiz.StagePassed)
	assertStage(t, result.Detection, modelplanbiz.StageInference, modelplanbiz.StagePassed)
}

func TestCompleteReturnsTextAndUsage(t *testing.T) {
	t.Parallel()

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"advice text"}}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":6}}}`))
	}))
	defer fake.Close()

	service := newTestService(newMemoryPlanStore())
	service.HTTPClient = fake.Client()
	result, err := service.Complete(context.Background(), CompletionRequest{
		Protocol: modelplanbiz.ProtocolOpenAI,
		BaseURL:  fake.URL + "/v1",
		APIKey:   "sk",
		Model:    "fake-mini",
		Prompt:   "hello",
	})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if result.Text != "advice text" {
		t.Fatalf("Complete() text = %q", result.Text)
	}
	if result.Usage.InputTokens != 10 || result.Usage.OutputTokens != 3 || result.Usage.CacheReadTokens != 6 || result.Usage.CacheWriteTokens != 0 {
		t.Fatalf("Complete() usage = %#v", result.Usage)
	}
}

func TestDecodeAnthropicCompletionPreservesCacheUsage(t *testing.T) {
	t.Parallel()

	text, usage, err := decodeCompletionText(modelplanbiz.ProtocolAnthropic, []byte(`{
		"content":[{"type":"text","text":"reviewed"}],
		"usage":{
			"input_tokens":12,
			"output_tokens":4,
			"cache_read_input_tokens":20,
			"cache_creation_input_tokens":5
		}
	}`))
	if err != nil {
		t.Fatalf("decodeCompletionText() error = %v", err)
	}
	if text != "reviewed" || usage.InputTokens != 12 || usage.OutputTokens != 4 || usage.CacheReadTokens != 20 || usage.CacheWriteTokens != 5 {
		t.Fatalf("decoded completion = %q %#v", text, usage)
	}
}

func assertStage(t *testing.T, snapshot modelplanbiz.DetectionSnapshot, stage modelplanbiz.DetectionStage, want modelplanbiz.StageStatus) {
	t.Helper()
	result, ok := snapshot.StageOutcome(stage)
	if !ok {
		t.Fatalf("stage %q missing from snapshot %#v", stage, snapshot)
	}
	if result.Status != want {
		t.Fatalf("stage %q status = %q, want %q (result %#v)", stage, result.Status, want, result)
	}
}
