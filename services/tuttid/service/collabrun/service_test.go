package collabrun

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type memoryRunStore struct {
	mu   sync.Mutex
	runs map[string]collabrunbiz.Run
}

func newMemoryRunStore() *memoryRunStore {
	return &memoryRunStore{runs: map[string]collabrunbiz.Run{}}
}

func (*memoryRunStore) key(workspaceID string, runID string) string {
	return workspaceID + "/" + runID
}

func (s *memoryRunStore) GetCollaborationRun(_ context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[s.key(workspaceID, runID)]
	if !ok {
		return collabrunbiz.Run{}, workspacedata.ErrCollaborationRunNotFound
	}
	return run, nil
}

func (s *memoryRunStore) ListCollaborationRuns(_ context.Context, workspaceID string, sourceSessionID string, limit int) ([]collabrunbiz.Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var runs []collabrunbiz.Run
	for _, run := range s.runs {
		if run.WorkspaceID != workspaceID {
			continue
		}
		if sourceSessionID != "" && run.SourceSessionID != sourceSessionID {
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		if !runs[i].CreatedAt.Equal(runs[j].CreatedAt) {
			return runs[i].CreatedAt.After(runs[j].CreatedAt)
		}
		return runs[i].ID > runs[j].ID
	})
	if limit > 0 && len(runs) > limit {
		runs = runs[:limit]
	}
	return runs, nil
}

func (s *memoryRunStore) PutCollaborationRun(_ context.Context, run collabrunbiz.Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runs[s.key(run.WorkspaceID, run.ID)] = run
	return nil
}

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

type recordingPublisher struct {
	mu   sync.Mutex
	runs []collabrunbiz.Run
}

func (p *recordingPublisher) PublishCollaborationRunUpdated(_ string, run collabrunbiz.Run) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.runs = append(p.runs, run)
}

func (p *recordingPublisher) published() []collabrunbiz.Run {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]collabrunbiz.Run(nil), p.runs...)
}

func seedConsultPlan(t *testing.T, plans *memoryPlanStore, baseURL string) modelplanbiz.Plan {
	t.Helper()
	plan, err := modelplanbiz.Normalize(modelplanbiz.Plan{
		ID:           "mp-consult",
		WorkspaceID:  "ws",
		Name:         "Consult Plan",
		Protocol:     modelplanbiz.ProtocolOpenAI,
		APIKey:       "sk-consult-secret",
		BaseURL:      baseURL,
		Models:       []modelplanbiz.Model{{ID: "fake-mini"}},
		DefaultModel: "fake-mini",
		Enabled:      true,
	})
	if err != nil {
		t.Fatalf("Normalize plan error = %v", err)
	}
	if err := plans.PutModelPlan(context.Background(), plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	return plan
}

func newTestService(store *memoryRunStore, plans *memoryPlanStore, client *http.Client, publisher *recordingPublisher) *Service {
	counter := 0
	completer := &modelplanservice.Service{
		Store:      plans,
		HTTPClient: client,
	}
	return &Service{
		Store:     store,
		Plans:     plans,
		Completer: completer,
		Publisher: publisher,
		Now:       func() time.Time { return time.UnixMilli(1700000000000).UTC() },
		NewID: func() string {
			counter++
			return fmt.Sprintf("cr-%d", counter)
		},
	}
}

func newFakeOpenAIServer(t *testing.T) *httptest.Server {
	t.Helper()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer sk-consult-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"advice: split the migration"}}],"usage":{"prompt_tokens":42,"completion_tokens":7}}`))
	}))
	t.Cleanup(fake.Close)
	return fake
}

func TestStartConsultSuccessRecordsResultUsageAndEvents(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := newFakeOpenAIServer(t)
	store := newMemoryRunStore()
	plans := newMemoryPlanStore()
	publisher := &recordingPublisher{}
	seedConsultPlan(t, plans, fake.URL+"/v1")
	service := newTestService(store, plans, fake.Client(), publisher)

	run, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "Should we split the migration?",
		ContextText:     "The table has two writers.",
		TriggerSource:   "agent",
		TriggerReason:   "second_opinion",
	})
	if err != nil {
		t.Fatalf("StartConsult() error = %v", err)
	}
	if run.Status != collabrunbiz.StatusCompleted {
		t.Fatalf("run status = %q, want completed (failure %q)", run.Status, run.FailureReason)
	}
	if run.ResultText != "advice: split the migration" {
		t.Fatalf("run result = %q", run.ResultText)
	}
	if run.Usage.InputTokens != 42 || run.Usage.OutputTokens != 7 {
		t.Fatalf("run usage = %#v", run.Usage)
	}
	if run.Model != "fake-mini" {
		t.Fatalf("run model = %q, want plan default", run.Model)
	}
	if run.Adoption != collabrunbiz.AdoptionPending {
		t.Fatalf("run adoption = %q, want pending", run.Adoption)
	}
	if run.ContextScope != "full" {
		t.Fatalf("run context scope = %q, want full", run.ContextScope)
	}
	if !strings.Contains(run.Prompt, "The table has two writers.") || !strings.Contains(run.Prompt, "Should we split the migration?") {
		t.Fatalf("run prompt = %q, want context + question", run.Prompt)
	}
	if strings.Contains(run.Prompt, "sk-consult-secret") || strings.Contains(run.ResultText, "sk-consult-secret") {
		t.Fatalf("credential leaked into run record")
	}

	published := publisher.published()
	if len(published) != 2 {
		t.Fatalf("published events = %d, want 2 (running + completed)", len(published))
	}
	if published[0].Status != collabrunbiz.StatusRunning || published[1].Status != collabrunbiz.StatusCompleted {
		t.Fatalf("published statuses = %q/%q, want running/completed", published[0].Status, published[1].Status)
	}

	stored, err := store.GetCollaborationRun(ctx, "ws", run.ID)
	if err != nil {
		t.Fatalf("GetCollaborationRun() error = %v", err)
	}
	if stored.Status != collabrunbiz.StatusCompleted || stored.ResultText != run.ResultText {
		t.Fatalf("stored run = %#v", stored)
	}
}

func TestStartConsultFailureRecordsSanitizedFailureReason(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := newFakeOpenAIServer(t)
	store := newMemoryRunStore()
	plans := newMemoryPlanStore()
	publisher := &recordingPublisher{}
	plan := seedConsultPlan(t, plans, fake.URL+"/v1")
	plan.APIKey = "sk-wrong-secret"
	if err := plans.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	service := newTestService(store, plans, fake.Client(), publisher)

	run, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "Should we split the migration?",
		TriggerSource:   "user",
	})
	if err != nil {
		t.Fatalf("StartConsult() error = %v, want failed run with nil error", err)
	}
	if run.Status != collabrunbiz.StatusFailed {
		t.Fatalf("run status = %q, want failed", run.Status)
	}
	if run.FailureReason != "unauthorized" {
		t.Fatalf("run failure reason = %q, want unauthorized", run.FailureReason)
	}
	if strings.Contains(run.FailureReason, "sk-wrong-secret") {
		t.Fatalf("credential leaked into failure reason %q", run.FailureReason)
	}
	if run.ResultText != "" {
		t.Fatalf("failed run result = %q, want empty", run.ResultText)
	}
	published := publisher.published()
	if len(published) != 2 || published[1].Status != collabrunbiz.StatusFailed {
		t.Fatalf("published events = %#v, want running then failed", published)
	}
}

func TestStartConsultEnforcesPerSessionLimit(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := newFakeOpenAIServer(t)
	store := newMemoryRunStore()
	plans := newMemoryPlanStore()
	seedConsultPlan(t, plans, fake.URL+"/v1")
	service := newTestService(store, plans, fake.Client(), &recordingPublisher{})
	service.MaxConsultRunsPerSourceSession = 1

	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "first",
		TriggerSource:   "user",
	}); err != nil {
		t.Fatalf("StartConsult(first) error = %v", err)
	}
	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "second",
		TriggerSource:   "user",
	}); !errors.Is(err, ErrConsultLimitReached) {
		t.Fatalf("StartConsult(second) error = %v, want ErrConsultLimitReached", err)
	}
	// Another source session is unaffected.
	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-2",
		ModelPlanID:     "mp-consult",
		Question:        "third",
		TriggerSource:   "user",
	}); err != nil {
		t.Fatalf("StartConsult(other session) error = %v", err)
	}
}

func TestStartConsultValidatesPlanAndModel(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := newFakeOpenAIServer(t)
	store := newMemoryRunStore()
	plans := newMemoryPlanStore()
	plan := seedConsultPlan(t, plans, fake.URL+"/v1")
	service := newTestService(store, plans, fake.Client(), &recordingPublisher{})

	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-missing",
		Question:        "q",
		TriggerSource:   "user",
	}); !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("StartConsult(missing plan) error = %v, want ErrPlanNotUsable", err)
	}

	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Model:           "not-in-plan",
		Question:        "q",
		TriggerSource:   "user",
	}); !errors.Is(err, ErrModelNotInPlan) {
		t.Fatalf("StartConsult(foreign model) error = %v, want ErrModelNotInPlan", err)
	}

	plan.Enabled = false
	if err := plans.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	if _, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "q",
		TriggerSource:   "user",
	}); !errors.Is(err, ErrPlanNotUsable) {
		t.Fatalf("StartConsult(disabled plan) error = %v, want ErrPlanNotUsable", err)
	}
}

func TestRecordRunStoresCompletedRecordPerMode(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryRunStore()
	publisher := &recordingPublisher{}
	service := newTestService(store, newMemoryPlanStore(), nil, publisher)

	fork, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:         "ws",
		Mode:                "fork",
		SourceSessionID:     "session-1",
		TargetSessionID:     "session-2",
		TargetAgentTargetID: "local:codex",
		ModelPlanID:         "mp-consult",
		Model:               "fake-mini",
		ContextScope:        "full",
		TriggerSource:       "user",
	})
	if err != nil {
		t.Fatalf("RecordRun(fork) error = %v", err)
	}
	if fork.Status != collabrunbiz.StatusCompleted || fork.DurationMs != 0 {
		t.Fatalf("fork run = %#v, want completed with zero duration", fork)
	}
	if fork.Adoption != collabrunbiz.AdoptionNotApplicable {
		t.Fatalf("fork adoption = %q, want not_applicable", fork.Adoption)
	}

	handoff, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:     "ws",
		Mode:            "handoff",
		SourceSessionID: "session-1",
		TargetSessionID: "session-3",
		TriggerSource:   "agent",
	})
	if err != nil {
		t.Fatalf("RecordRun(handoff) error = %v", err)
	}
	if handoff.Adoption != collabrunbiz.AdoptionNotApplicable {
		t.Fatalf("handoff adoption = %q, want not_applicable", handoff.Adoption)
	}

	delegate, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:     "ws",
		Mode:            "delegate",
		SourceSessionID: "session-1",
		TargetSessionID: "session-4",
		TriggerSource:   "policy",
	})
	if err != nil {
		t.Fatalf("RecordRun(delegate) error = %v", err)
	}
	if delegate.Adoption != collabrunbiz.AdoptionPending {
		t.Fatalf("delegate adoption = %q, want pending", delegate.Adoption)
	}

	if _, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:   "ws",
		Mode:          "consult",
		TriggerSource: "user",
	}); !errors.Is(err, ErrInvalidRunInput) {
		t.Fatalf("RecordRun(consult) error = %v, want ErrInvalidRunInput", err)
	}

	if published := publisher.published(); len(published) != 3 {
		t.Fatalf("published events = %d, want 3", len(published))
	}
}

func TestSetAdoptionValidatesTransitions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fake := newFakeOpenAIServer(t)
	store := newMemoryRunStore()
	plans := newMemoryPlanStore()
	publisher := &recordingPublisher{}
	seedConsultPlan(t, plans, fake.URL+"/v1")
	service := newTestService(store, plans, fake.Client(), publisher)

	consult, err := service.StartConsult(ctx, StartConsultInput{
		WorkspaceID:     "ws",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-consult",
		Question:        "q",
		TriggerSource:   "user",
	})
	if err != nil {
		t.Fatalf("StartConsult() error = %v", err)
	}

	adopted, err := service.SetAdoption(ctx, "ws", consult.ID, "adopted")
	if err != nil {
		t.Fatalf("SetAdoption(adopted) error = %v", err)
	}
	if adopted.Adoption != collabrunbiz.AdoptionAdopted {
		t.Fatalf("adoption = %q, want adopted", adopted.Adoption)
	}

	if _, err := service.SetAdoption(ctx, "ws", consult.ID, "not_applicable"); !errors.Is(err, ErrInvalidAdoption) {
		t.Fatalf("SetAdoption(not_applicable) error = %v, want ErrInvalidAdoption", err)
	}
	if _, err := service.SetAdoption(ctx, "ws", consult.ID, "maybe"); !errors.Is(err, ErrInvalidAdoption) {
		t.Fatalf("SetAdoption(maybe) error = %v, want ErrInvalidAdoption", err)
	}
	if _, err := service.SetAdoption(ctx, "ws", "cr-missing", "adopted"); !errors.Is(err, workspacedata.ErrCollaborationRunNotFound) {
		t.Fatalf("SetAdoption(missing run) error = %v, want not found", err)
	}

	fork, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:     "ws",
		Mode:            "fork",
		SourceSessionID: "session-1",
		TargetSessionID: "session-2",
		TriggerSource:   "user",
	})
	if err != nil {
		t.Fatalf("RecordRun(fork) error = %v", err)
	}
	if _, err := service.SetAdoption(ctx, "ws", fork.ID, "adopted"); !errors.Is(err, ErrInvalidAdoption) {
		t.Fatalf("SetAdoption(fork) error = %v, want ErrInvalidAdoption", err)
	}
}

func TestCancelConsultSettlesRunningRun(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryRunStore()
	publisher := &recordingPublisher{}
	service := newTestService(store, newMemoryPlanStore(), nil, publisher)

	running, err := collabrunbiz.Normalize(collabrunbiz.Run{
		ID:              "cr-running",
		WorkspaceID:     "ws",
		Mode:            collabrunbiz.ModeConsult,
		TriggerSource:   collabrunbiz.TriggerUser,
		SourceSessionID: "session-1",
		Status:          collabrunbiz.StatusRunning,
		StartedAt:       time.UnixMilli(1700000000000).UTC(),
		CreatedAt:       time.UnixMilli(1700000000000).UTC(),
		UpdatedAt:       time.UnixMilli(1700000000000).UTC(),
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if err := store.PutCollaborationRun(ctx, running); err != nil {
		t.Fatalf("PutCollaborationRun() error = %v", err)
	}

	canceled, err := service.CancelConsult(ctx, "ws", "cr-running")
	if err != nil {
		t.Fatalf("CancelConsult() error = %v", err)
	}
	if canceled.Status != collabrunbiz.StatusCanceled || canceled.FailureReason != "canceled" {
		t.Fatalf("canceled run = %#v", canceled)
	}
	if published := publisher.published(); len(published) != 1 || published[0].Status != collabrunbiz.StatusCanceled {
		t.Fatalf("published events = %#v, want one canceled", published)
	}

	// Cancel is idempotent on settled runs.
	again, err := service.CancelConsult(ctx, "ws", "cr-running")
	if err != nil {
		t.Fatalf("CancelConsult(again) error = %v", err)
	}
	if again.Status != collabrunbiz.StatusCanceled {
		t.Fatalf("second cancel status = %q", again.Status)
	}
	if published := publisher.published(); len(published) != 1 {
		t.Fatalf("second cancel published extra events: %d", len(published))
	}

	fork, err := service.RecordRun(ctx, RecordRunInput{
		WorkspaceID:     "ws",
		Mode:            "fork",
		SourceSessionID: "session-1",
		TargetSessionID: "session-2",
		TriggerSource:   "user",
	})
	if err != nil {
		t.Fatalf("RecordRun(fork) error = %v", err)
	}
	if _, err := service.CancelConsult(ctx, "ws", fork.ID); !errors.Is(err, ErrInvalidRunInput) {
		t.Fatalf("CancelConsult(fork) error = %v, want ErrInvalidRunInput", err)
	}
}
