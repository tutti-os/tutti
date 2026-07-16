package modelpolicy

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
	s.acceptances[s.key(acceptance.WorkspaceID, acceptance.AgentSessionID)] = acceptance
	return nil
}

type staticBindings struct{ binding modelbindingbiz.Binding }

func (s staticBindings) GetAgentModelBinding(context.Context, string, string) (modelbindingbiz.Binding, error) {
	return s.binding, nil
}

type panicBindings struct{}

func (panicBindings) GetAgentModelBinding(context.Context, string, string) (modelbindingbiz.Binding, error) {
	panic("legacy policy binding must not be resolved without an explicit compatibility runner")
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

func newPolicyTestService(store *memoryPolicyStore) *Service {
	return &Service{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(1700000000000).UTC() },
		NewID: func() string { return "pol-fixed" },
	}
}

func settledCompletedInput(turnID string) agentsessionstore.ReportSessionStateInput {
	completed := "completed"
	return agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "local:codex",
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{
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

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-1"), agentsessionstore.ReportSessionStateReply{})
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
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-1"), agentsessionstore.ReportSessionStateReply{})
	time.Sleep(50 * time.Millisecond)
	if len(runner.inputs) != 1 {
		t.Fatalf("same turn should not re-trigger: %#v", runner.inputs)
	}
}

func TestCompletedTurnWithoutLegacyRunnerOnlyRecordsAcceptance(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPolicyTestService(newMemoryPolicyStore())
	service.Bindings = panicBindings{}
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-no-legacy-runner"), agentsessionstore.ReportSessionStateReply{})
	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceAgentClaimed {
		t.Fatalf("acceptance = %#v ok=%v err=%v", acceptance, ok, err)
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

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-9"), agentsessionstore.ReportSessionStateReply{})
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

	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-2"), agentsessionstore.ReportSessionStateReply{})
	time.Sleep(100 * time.Millisecond)
	if len(runner.inputs) != 0 {
		t.Fatalf("budget-exhausted review should not run: %#v", runner.inputs)
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
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-3"), agentsessionstore.ReportSessionStateReply{})
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
	service.ObserveAgentSessionState(ctx, settledCompletedInput("turn-4"), agentsessionstore.ReportSessionStateReply{})
	acceptance, ok, err := service.GetAcceptance(ctx, "ws", "session-1")
	if err != nil || !ok || acceptance.State != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("acceptance = %#v ok=%v err=%v", acceptance, ok, err)
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
