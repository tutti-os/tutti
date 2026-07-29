package modelpolicy

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type memoryPolicyStore struct {
	mu          sync.Mutex
	policies    map[string]modelpolicybiz.Policy
	overrides   map[string]modelpolicybiz.SessionOverride
	acceptances map[string]modelpolicybiz.Acceptance
}

func newMemoryPolicyStore() *memoryPolicyStore {
	return &memoryPolicyStore{
		policies:    map[string]modelpolicybiz.Policy{},
		overrides:   map[string]modelpolicybiz.SessionOverride{},
		acceptances: map[string]modelpolicybiz.Acceptance{},
	}
}

func (*memoryPolicyStore) key(workspaceID string, id string) string { return workspaceID + "/" + id }

func (s *memoryPolicyStore) ListModelPolicies(_ context.Context, workspaceID string) ([]modelpolicybiz.Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var policies []modelpolicybiz.Policy
	for _, policy := range s.policies {
		if policy.WorkspaceID == workspaceID {
			policies = append(policies, policy)
		}
	}
	return policies, nil
}

func (s *memoryPolicyStore) GetModelPolicy(_ context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	policy, ok := s.policies[s.key(workspaceID, policyID)]
	if !ok {
		return modelpolicybiz.Policy{}, workspacedata.ErrModelPolicyNotFound
	}
	return policy, nil
}

func (s *memoryPolicyStore) PutModelPolicy(_ context.Context, policy modelpolicybiz.Policy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.policies[s.key(policy.WorkspaceID, policy.ID)] = policy
	return nil
}

func (s *memoryPolicyStore) DeleteModelPolicy(_ context.Context, workspaceID string, policyID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(workspaceID, policyID)
	if _, ok := s.policies[key]; !ok {
		return workspacedata.ErrModelPolicyNotFound
	}
	delete(s.policies, key)
	return nil
}

func (s *memoryPolicyStore) ListModelPoliciesByPlan(_ context.Context, workspaceID string, planID string) ([]modelpolicybiz.Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var policies []modelpolicybiz.Policy
	for _, policy := range s.policies {
		if policy.WorkspaceID != workspaceID {
			continue
		}
		if policy.Execution.ModelPlanID == planID || policy.Planning.ModelPlanID == planID || policy.Review.ModelPlanID == planID {
			policies = append(policies, policy)
		}
	}
	return policies, nil
}

func (s *memoryPolicyStore) GetModelPolicySessionOverride(_ context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.SessionOverride, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	override, ok := s.overrides[s.key(workspaceID, agentSessionID)]
	if !ok {
		return modelpolicybiz.SessionOverride{}, sql.ErrNoRows
	}
	return override, nil
}

func (s *memoryPolicyStore) PutModelPolicySessionOverride(_ context.Context, override modelpolicybiz.SessionOverride) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.overrides[s.key(override.WorkspaceID, override.AgentSessionID)] = override
	return nil
}

func (s *memoryPolicyStore) GetAgentSessionAcceptance(_ context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	acceptance, ok := s.acceptances[s.key(workspaceID, agentSessionID)]
	if !ok {
		return modelpolicybiz.Acceptance{}, sql.ErrNoRows
	}
	return acceptance, nil
}

func (s *memoryPolicyStore) PutAgentSessionAcceptance(_ context.Context, acceptance modelpolicybiz.Acceptance) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(acceptance.WorkspaceID, acceptance.AgentSessionID)
	// Mirror the SQLite write boundary: user_accepted is terminal and never
	// downgraded by concurrent automation writes.
	if existing, ok := s.acceptances[key]; ok && existing.State == modelpolicybiz.AcceptanceUserAccepted {
		return nil
	}
	s.acceptances[key] = acceptance
	return nil
}

type staticBindings struct{ binding modelbindingbiz.Binding }

func (s staticBindings) GetAgentModelBinding(context.Context, string, string) (modelbindingbiz.Binding, error) {
	return s.binding, nil
}

type recordingRunner struct {
	mu     sync.Mutex
	inputs []ReviewConsultInput
	result ReviewConsultResult
	err    error
	done   chan struct{}
}

func (r *recordingRunner) RunPolicyReviewConsult(_ context.Context, input ReviewConsultInput) (ReviewConsultResult, error) {
	r.mu.Lock()
	r.inputs = append(r.inputs, input)
	r.mu.Unlock()
	if r.done != nil {
		defer func() { r.done <- struct{}{} }()
	}
	return r.result, r.err
}

type staticBudget struct {
	runs   int
	tokens int64
}

func (s staticBudget) SumPolicyReviewUsage(context.Context, string, string) (int, int64, error) {
	return s.runs, s.tokens, nil
}

type erroringBudget struct{ err error }

func (b erroringBudget) SumPolicyReviewUsage(context.Context, string, string) (int, int64, error) {
	return 0, 0, b.err
}

func newPolicyTestService(store *memoryPolicyStore) *Service {
	return &Service{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(1700000000000).UTC() },
		NewID: func() string { return "pol-fixed" },
	}
}

func settledCompletedInput(turnID string) canonical.ReportSessionStateInput {
	completed := "completed"
	return canonical.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "local:codex",
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &turnID,
				Phase:        "settled",
				Outcome:      &completed,
			},
		},
	}
}

func seedReviewPolicy(t *testing.T, service *Service) modelpolicybiz.Policy {
	t.Helper()
	policy, err := service.PutPolicy(context.Background(), PutPolicyInput{
		WorkspaceID: "ws",
		Name:        "Careful",
		Execution:   modelpolicybiz.PlanModelRef{ModelPlanID: "mp-1", Model: "exec-model"},
		Review:      modelpolicybiz.PlanModelRef{ModelPlanID: "mp-1", Model: "review-model"},
		ReviewRule:  modelpolicybiz.ReviewRule{Enabled: true, MaxRunsPerSession: 2},
	})
	if err != nil {
		t.Fatalf("PutPolicy() error = %v", err)
	}
	return policy
}

func TestPutPolicyValidatesReviewRule(t *testing.T) {
	t.Parallel()

	service := newPolicyTestService(newMemoryPolicyStore())
	_, err := service.PutPolicy(context.Background(), PutPolicyInput{
		WorkspaceID: "ws",
		Name:        "Broken",
		ReviewRule:  modelpolicybiz.ReviewRule{Enabled: true},
	})
	if !errors.Is(err, ErrInvalidPolicyInput) {
		t.Fatalf("PutPolicy(review without model) error = %v, want ErrInvalidPolicyInput", err)
	}
}

func TestReviewRuleRunsAndMarksAutoChecked(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPolicyStore()
	service := newPolicyTestService(store)
	policy := seedReviewPolicy(t, service)
	runner := &recordingRunner{
		result: ReviewConsultResult{RunID: "run-1", ResultText: "Looks solid.\nVERDICT: PASS"},
		done:   make(chan struct{}, 1),
	}
	service.ConfigureReviewAutomation(
		staticBindings{binding: modelbindingbiz.Binding{ModelPolicyID: policy.ID}},
		nil,
		runner,
		staticBudget{},
	)

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-1"), canonical.ReportSessionStateReply{})
	select {
	case <-runner.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("review runner was not invoked")
	}
	waitFor(t, func() bool {
		acceptance, ok, _ := service.GetAcceptance(ctx, "ws", "session-1")
		return ok && acceptance.State == modelpolicybiz.AcceptanceAutoChecked && acceptance.ReviewRunID == "run-1"
	})
	if len(runner.inputs) != 1 || runner.inputs[0].ModelPlanID != "mp-1" || runner.inputs[0].Model != "review-model" {
		t.Fatalf("runner inputs = %#v", runner.inputs)
	}
	if !strings.Contains(runner.inputs[0].TriggerReason, "review_rule:on_task_complete") {
		t.Fatalf("trigger reason = %q", runner.inputs[0].TriggerReason)
	}

	// Same turn id does not re-trigger.
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-1"), canonical.ReportSessionStateReply{})
	time.Sleep(50 * time.Millisecond)
	if len(runner.inputs) != 1 {
		t.Fatalf("same turn should not re-trigger: %#v", runner.inputs)
	}
}

func TestReviewFailVerdictKeepsAgentClaimed(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPolicyStore()
	service := newPolicyTestService(store)
	policy := seedReviewPolicy(t, service)
	runner := &recordingRunner{
		result: ReviewConsultResult{RunID: "run-2", ResultText: "Problems found.\nVERDICT: FAIL"},
		done:   make(chan struct{}, 1),
	}
	service.ConfigureReviewAutomation(staticBindings{binding: modelbindingbiz.Binding{ModelPolicyID: policy.ID}}, nil, runner, staticBudget{})

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-9"), canonical.ReportSessionStateReply{})
	select {
	case <-runner.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("review runner was not invoked")
	}
	waitFor(t, func() bool {
		acceptance, ok, _ := service.GetAcceptance(ctx, "ws", "session-1")
		return ok && acceptance.State == modelpolicybiz.AcceptanceAgentClaimed
	})
}

func TestReviewBudgetExhaustedSkipsRun(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	policy := seedReviewPolicy(t, service)
	runner := &recordingRunner{result: ReviewConsultResult{RunID: "run-3", ResultText: "VERDICT: PASS"}}
	service.ConfigureReviewAutomation(staticBindings{binding: modelbindingbiz.Binding{ModelPolicyID: policy.ID}}, nil, runner, staticBudget{runs: 2})

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-2"), canonical.ReportSessionStateReply{})
	time.Sleep(100 * time.Millisecond)
	if len(runner.inputs) != 0 {
		t.Fatalf("budget-exhausted review should not run: %#v", runner.inputs)
	}
}

func TestReviewBudgetReadErrorFailsClosed(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	policy := seedReviewPolicy(t, service)
	runner := &recordingRunner{result: ReviewConsultResult{RunID: "run-x", ResultText: "VERDICT: PASS"}}
	service.ConfigureReviewAutomation(
		staticBindings{binding: modelbindingbiz.Binding{ModelPolicyID: policy.ID}},
		nil,
		runner,
		erroringBudget{err: errors.New("usage store down")},
	)

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-budget-err"), canonical.ReportSessionStateReply{})
	time.Sleep(100 * time.Millisecond)
	if len(runner.inputs) != 0 {
		t.Fatalf("budget read error must fail closed and skip the billable review: %#v", runner.inputs)
	}
	// The agent's completion claim is still recorded even though the review was
	// skipped.
	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceAgentClaimed {
		t.Fatalf("acceptance = %#v ok=%v err=%v, want agent_claimed", acceptance, ok, err)
	}
}

func TestSessionOverrideDisablesAutomation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	policy := seedReviewPolicy(t, service)
	runner := &recordingRunner{result: ReviewConsultResult{ResultText: "VERDICT: PASS"}}
	service.ConfigureReviewAutomation(staticBindings{binding: modelbindingbiz.Binding{ModelPolicyID: policy.ID}}, nil, runner, staticBudget{})

	if _, err := service.SetSessionOverride(ctx, modelpolicybiz.SessionOverride{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		Disabled:       true,
	}); err != nil {
		t.Fatalf("SetSessionOverride() error = %v", err)
	}
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-3"), canonical.ReportSessionStateReply{})
	time.Sleep(100 * time.Millisecond)
	if len(runner.inputs) != 0 {
		t.Fatalf("disabled session should not review: %#v", runner.inputs)
	}
	// The claim itself is still recorded.
	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceAgentClaimed {
		t.Fatalf("acceptance = %#v ok=%v err=%v", acceptance, ok, err)
	}
}

func TestUserAcceptanceIsSticky(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	if _, err := service.MarkUserAccepted(ctx, "ws", "session-1"); err != nil {
		t.Fatalf("MarkUserAccepted() error = %v", err)
	}
	// A later completed turn without automation keeps user_accepted.
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-4"), canonical.ReportSessionStateReply{})
	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("acceptance = %#v ok=%v err=%v", acceptance, ok, err)
	}
}

func TestUserAcceptanceStaysStickyUnderConcurrentAutomation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newMemoryPolicyStore()
	service := newPolicyTestService(store)
	if _, err := service.MarkUserAccepted(ctx, "ws", "session-1"); err != nil {
		t.Fatalf("MarkUserAccepted() error = %v", err)
	}

	// Concurrent automation writes (claim + auto-check) must never downgrade
	// the user_accepted rung once it has been reached.
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = store.PutAgentSessionAcceptance(ctx, modelpolicybiz.Acceptance{
				WorkspaceID:    "ws",
				AgentSessionID: "session-1",
				State:          modelpolicybiz.AcceptanceAgentClaimed,
				UpdatedAt:      service.now(),
			})
			_ = store.PutAgentSessionAcceptance(ctx, modelpolicybiz.Acceptance{
				WorkspaceID:    "ws",
				AgentSessionID: "session-1",
				State:          modelpolicybiz.AcceptanceAutoChecked,
				ReviewRunID:    "run-x",
				UpdatedAt:      service.now(),
			})
		}()
	}
	wg.Wait()

	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("acceptance = %#v ok=%v err=%v, want sticky user_accepted", acceptance, ok, err)
	}
}

func TestPolicyPlanReferences(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	seedReviewPolicy(t, service)
	references, err := service.ListModelPlanReferences(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 1 || references[0].Kind != "model_policy" || references[0].Name != "Careful" {
		t.Fatalf("references = %#v", references)
	}
}

type staticBindingReferences struct {
	bindings []modelbindingbiz.Binding
	err      error
}

func (s staticBindingReferences) ListAgentModelBindingsByModelPolicy(context.Context, string, string) ([]modelbindingbiz.Binding, error) {
	return s.bindings, s.err
}

func TestDeletePolicyFailsClosedWithoutReferenceReader(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	policy := seedReviewPolicy(t, service)
	// BindingReferences intentionally left nil: deletion must refuse rather than
	// proceed without being able to check references.
	if err := service.DeletePolicy(ctx, "ws", policy.ID); !errors.Is(err, ErrPolicyReferenceCheckUnavailable) {
		t.Fatalf("DeletePolicy(no reference reader) error = %v, want ErrPolicyReferenceCheckUnavailable", err)
	}
	if _, err := service.GetPolicy(ctx, "ws", policy.ID); err != nil {
		t.Fatalf("policy must survive a fail-closed deletion: %v", err)
	}
}

func TestDeletePolicyBlockedWhileBindingReferences(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	policy := seedReviewPolicy(t, service)

	// A live binding reference blocks deletion so it cannot recreate a dangling
	// binding link.
	service.BindingReferences = staticBindingReferences{bindings: []modelbindingbiz.Binding{
		{WorkspaceID: "ws", AgentTargetID: "local:codex", ModelPolicyID: policy.ID},
	}}
	if err := service.DeletePolicy(ctx, "ws", policy.ID); !errors.Is(err, ErrPolicyReferenced) {
		t.Fatalf("DeletePolicy(referenced) error = %v, want ErrPolicyReferenced", err)
	}
	if _, err := service.GetPolicy(ctx, "ws", policy.ID); err != nil {
		t.Fatalf("policy must survive a blocked deletion: %v", err)
	}

	// A reference-check error is propagated (deletion does not proceed).
	service.BindingReferences = staticBindingReferences{err: errors.New("binding store down")}
	if err := service.DeletePolicy(ctx, "ws", policy.ID); err == nil {
		t.Fatalf("DeletePolicy must propagate the reference-check error")
	}
	if _, err := service.GetPolicy(ctx, "ws", policy.ID); err != nil {
		t.Fatalf("policy must survive a failed reference check: %v", err)
	}

	// With no references, deletion proceeds.
	service.BindingReferences = staticBindingReferences{}
	if err := service.DeletePolicy(ctx, "ws", policy.ID); err != nil {
		t.Fatalf("DeletePolicy(unreferenced) error = %v", err)
	}
	if _, err := service.GetPolicy(ctx, "ws", policy.ID); !errors.Is(err, workspacedata.ErrModelPolicyNotFound) {
		t.Fatalf("policy should be deleted: %v", err)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within timeout")
}
