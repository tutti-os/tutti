package automationrule

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

type memoryStore struct {
	mu        sync.Mutex
	rules     map[string]automationrulebiz.Rule
	overrides map[string]automationrulebiz.SessionOverride
}

func newMemoryStore() *memoryStore {
	return &memoryStore{rules: map[string]automationrulebiz.Rule{}, overrides: map[string]automationrulebiz.SessionOverride{}}
}

func storeKey(workspaceID string, id string) string { return workspaceID + "/" + id }

func (s *memoryStore) ListAutomationRules(_ context.Context, workspaceID string) ([]automationrulebiz.Rule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []automationrulebiz.Rule
	for _, rule := range s.rules {
		if rule.WorkspaceID == workspaceID {
			result = append(result, rule)
		}
	}
	return result, nil
}

func (s *memoryStore) GetAutomationRule(_ context.Context, workspaceID string, ruleID string) (automationrulebiz.Rule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rule, ok := s.rules[storeKey(workspaceID, ruleID)]
	if !ok {
		return automationrulebiz.Rule{}, sql.ErrNoRows
	}
	return rule, nil
}

func (s *memoryStore) CreateAutomationRule(_ context.Context, rule automationrulebiz.Rule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := storeKey(rule.WorkspaceID, rule.ID)
	if _, exists := s.rules[key]; exists {
		return errors.New("automation rule already exists")
	}
	s.rules[key] = rule
	return nil
}

func (s *memoryStore) UpdateAutomationRule(_ context.Context, rule automationrulebiz.Rule) (automationrulebiz.Rule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := storeKey(rule.WorkspaceID, rule.ID)
	existing, exists := s.rules[key]
	if !exists {
		return automationrulebiz.Rule{}, sql.ErrNoRows
	}
	rule.CreatedAt = existing.CreatedAt
	s.rules[key] = rule
	return rule, nil
}

func (s *memoryStore) DeleteAutomationRule(_ context.Context, workspaceID string, ruleID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := storeKey(workspaceID, ruleID)
	if _, ok := s.rules[key]; !ok {
		return sql.ErrNoRows
	}
	delete(s.rules, key)
	return nil
}

func (s *memoryStore) ListAutomationRulesByPlan(ctx context.Context, workspaceID string, planID string) ([]automationrulebiz.Rule, error) {
	rules, _ := s.ListAutomationRules(ctx, workspaceID)
	var result []automationrulebiz.Rule
	for _, rule := range rules {
		if rule.Target.ModelPlanID == planID {
			result = append(result, rule)
		}
	}
	return result, nil
}

func (s *memoryStore) GetAutomationRuleSessionOverride(_ context.Context, workspaceID string, sessionID string) (automationrulebiz.SessionOverride, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	override, ok := s.overrides[storeKey(workspaceID, sessionID)]
	if !ok {
		return automationrulebiz.SessionOverride{}, false, nil
	}
	return override, true, nil
}

func (s *memoryStore) PutAutomationRuleSessionOverride(_ context.Context, override automationrulebiz.SessionOverride) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.overrides[storeKey(override.WorkspaceID, override.AgentSessionID)] = override
	return nil
}

type staticPlans map[string]modelplanbiz.Plan

func (p staticPlans) GetModelPlan(_ context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error) {
	plan, ok := p[storeKey(workspaceID, planID)]
	if !ok {
		return modelplanbiz.Plan{}, sql.ErrNoRows
	}
	return plan, nil
}

type staticAgents map[string]bool

func (a staticAgents) ValidateAutomationAgentReference(_ context.Context, workspaceID string, agentID string) error {
	if !a[storeKey(workspaceID, agentID)] {
		return errors.New("agent unavailable")
	}
	return nil
}

type recordingExecutor struct {
	calls chan ExecutionInput
}

func (e recordingExecutor) ExecuteAutomationRule(_ context.Context, input ExecutionInput) (ExecutionResult, error) {
	e.calls <- input
	return ExecutionResult{RunID: "run-1"}, nil
}

type fixedResultExecutor struct {
	result ExecutionResult
}

func (e fixedResultExecutor) ExecuteAutomationRule(context.Context, ExecutionInput) (ExecutionResult, error) {
	return e.result, nil
}

type reviewOutcomeRecorder struct {
	outcomes chan ReviewOutcome
}

func (r reviewOutcomeRecorder) RecordAutomationReviewOutcome(_ context.Context, outcome ReviewOutcome) error {
	r.outcomes <- outcome
	return nil
}

type staticUsage struct {
	runs   int
	tokens int64
	exists bool
}

func (u staticUsage) AutomationRuleUsage(context.Context, string, string, string) (int, int64, error) {
	return u.runs, u.tokens, nil
}

func (u staticUsage) AutomationRuleExecutionExists(context.Context, string, string, string, string) (bool, error) {
	return u.exists, nil
}

func TestCreateRuleValidatesModelCapabilities(t *testing.T) {
	store := newMemoryStore()
	service := &Service{
		Store: store,
		Plans: staticPlans{storeKey("ws", "plan-1"): {
			ID:           "plan-1",
			WorkspaceID:  "ws",
			Enabled:      true,
			DefaultModel: "reasoner",
			Models:       []modelplanbiz.Model{{ID: "reasoner", Capabilities: []string{"reasoning"}}},
		}},
		NewID: func() string { return "rule-1" },
	}
	rule, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Review completed work",
		Enabled:     true,
		Action:      automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{
			ModelPlanID:          "plan-1",
			RequiredCapabilities: []string{"reasoning"},
		},
	})
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	if rule.ID != "rule-1" || rule.Target.Kind != automationrulebiz.TargetModel {
		t.Fatalf("CreateRule() = %#v", rule)
	}

	_, err = service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Needs vision",
		Action:      automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{
			ModelPlanID:          "plan-1",
			RequiredCapabilities: []string{"vision"},
		},
	})
	if !errors.Is(err, ErrInvalidRuleInput) {
		t.Fatalf("CreateRule() missing capability error = %v", err)
	}
}

func TestCreateRuleValidatesAgentReferences(t *testing.T) {
	service := &Service{
		Store:  newMemoryStore(),
		Agents: staticAgents{storeKey("ws", "workspace-agent:source"): true, storeKey("ws", "workspace-agent:target"): true},
		NewID:  func() string { return "rule-1" },
	}
	_, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID:            "ws",
		Name:                   "Delegate",
		Action:                 automationrulebiz.ActionDelegate,
		SourceWorkspaceAgentID: "workspace-agent:source",
		Target:                 automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	})
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
}

func TestUpdateRulePreservesCreatedAtAndRequiresExistingRule(t *testing.T) {
	t.Parallel()

	store := newMemoryStore()
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	updatedAt := createdAt.Add(time.Minute)
	now := createdAt
	service := &Service{
		Store: store,
		Plans: staticPlans{storeKey("ws", "plan-1"): {
			ID: "plan-1", WorkspaceID: "ws", Enabled: true,
			DefaultModel: "reasoner", Models: []modelplanbiz.Model{{ID: "reasoner"}},
		}},
		Now:   func() time.Time { return now },
		NewID: func() string { return "rule-1" },
	}
	created, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", Name: "Before", Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	})
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	now = updatedAt
	updated, err := service.UpdateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", RuleID: created.ID, Name: "After", Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	})
	if err != nil {
		t.Fatalf("UpdateRule() error = %v", err)
	}
	if updated.Name != "After" || !updated.CreatedAt.Equal(createdAt) || !updated.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("UpdateRule() = %#v", updated)
	}
	if _, err := service.UpdateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", RuleID: "missing", Name: "Missing", Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("UpdateRule(missing) error = %v, want not found", err)
	}
}

func TestObserveAgentSessionStateRunsOncePerRuleAndTurn(t *testing.T) {
	store := newMemoryStore()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:                     "rule-1",
		WorkspaceID:            "ws",
		Name:                   "Delegate",
		Enabled:                true,
		Action:                 automationrulebiz.ActionDelegate,
		SourceWorkspaceAgentID: "workspace-agent:source",
		Target:                 automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 2)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome := "completed"
	turnID := "turn-1"
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		AgentTargetID:  "workspace-agent:source",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "workspace-agent:source",
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}
	service.ObserveAgentSessionState(context.Background(), input, agentsessionstore.ReportSessionStateReply{})
	service.ObserveAgentSessionState(context.Background(), input, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		if call.Rule.ID != "rule-1" || call.SourceAgentID != "workspace-agent:source" {
			t.Fatalf("execution call = %#v", call)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for automation execution")
	}
	select {
	case duplicate := <-calls:
		t.Fatalf("duplicate execution = %#v", duplicate)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFixedReviewAutomationRecordsValidatedAcceptanceOutcome(t *testing.T) {
	store := newMemoryStore()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:          "rule-review",
		WorkspaceID: "ws",
		Name:        "Review completed work",
		Enabled:     true,
		Action:      automationrulebiz.ActionConsult,
		Target:      automationrulebiz.Target{ModelPlanID: "plan-review"},
		Prompt:      "Review the work and end with exactly VERDICT: PASS or VERDICT: FAIL.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAutomationRule(context.Background(), rule); err != nil {
		t.Fatal(err)
	}
	outcomes := make(chan ReviewOutcome, 1)
	service := &Service{
		Store:          store,
		Executor:       fixedResultExecutor{result: ExecutionResult{RunID: "review-run-1", ResultText: "No issues.\nVERDICT: PASS"}},
		Usage:          staticUsage{},
		ReviewOutcomes: reviewOutcomeRecorder{outcomes: outcomes},
	}
	outcome, turnID := "completed", "turn-review"
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-review",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, agentsessionstore.ReportSessionStateReply{})
	select {
	case recorded := <-outcomes:
		if !recorded.Passed || !recorded.VerdictValid || recorded.ReviewRunID != "review-run-1" || recorded.SourceSessionID != "session-review" {
			t.Fatalf("review outcome = %#v", recorded)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for fixed review outcome")
	}
}

func TestObserveAgentSessionStateRunsBoundedFailureRescueRule(t *testing.T) {
	store := newMemoryStore()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:          "rule-rescue",
		WorkspaceID: "ws",
		Name:        "Escalate failed work",
		Enabled:     true,
		Trigger:     automationrulebiz.TriggerOnTaskFailed,
		Action:      automationrulebiz.ActionDelegate,
		Target:      automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:stronger"},
		Budget:      automationrulebiz.Budget{MaxRunsPerSession: 1, MaxTotalTokensPerSession: 20_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 1)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome, turnID := "failed", "turn-failed"
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		if call.Rule.Trigger != automationrulebiz.TriggerOnTaskFailed || call.Rule.Target.WorkspaceAgentID != "workspace-agent:stronger" {
			t.Fatalf("failure rescue call = %#v", call)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for failure rescue automation")
	}
}

func TestAutomationRuleMatchesSourceSupportsOnlyDeterministicLegacyAlias(t *testing.T) {
	t.Parallel()

	legacyAgentID := workspaceagentbiz.LegacyBindingID("ws", "local:codex")
	tests := []struct {
		name       string
		workspace  string
		configured string
		session    string
		want       bool
	}{
		{name: "unscoped", workspace: "ws", want: true},
		{name: "exact workspace agent", workspace: "ws", configured: "workspace-agent:writer", session: "workspace-agent:writer", want: true},
		{name: "migrated legacy raw harness", workspace: "ws", configured: legacyAgentID, session: "local:codex", want: true},
		{name: "legacy alias is workspace scoped", workspace: "other", configured: legacyAgentID, session: "local:codex", want: false},
		{name: "ordinary agent rejects raw harness", workspace: "ws", configured: "workspace-agent:writer", session: "local:codex", want: false},
		{name: "legacy agent rejects another harness", workspace: "ws", configured: legacyAgentID, session: "local:claude-code", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := automationRuleMatchesSource(test.workspace, test.configured, test.session); got != test.want {
				t.Fatalf("automationRuleMatchesSource() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestObserveAgentSessionStateHonorsBudgetAndAutomationOrigin(t *testing.T) {
	store := newMemoryStore()
	rule, _ := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "rule-1", WorkspaceID: "ws", Name: "Consult", Enabled: true,
		Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
		Budget: automationrulebiz.Budget{MaxRunsPerSession: 1},
	})
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 1)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{runs: 1}}
	outcome, turnID := "completed", "turn-1"
	state := agentsessionstore.WorkspaceAgentSessionStateUpdate{
		TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
	}
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{WorkspaceID: "ws", AgentSessionID: "session-budget", State: state}, agentsessionstore.ReportSessionStateReply{})
	state.RuntimeContext = map[string]any{"automation": map[string]any{"ruleId": "parent"}}
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{WorkspaceID: "ws", AgentSessionID: "session-origin", State: state}, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		t.Fatalf("unexpected execution = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestObserveAgentSessionStateAllowsOnlyBoundedFailureRescueChains(t *testing.T) {
	store := newMemoryStore()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "rule-rescue", WorkspaceID: "ws", Name: "Escalate", Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskFailed,
		Action:  automationrulebiz.ActionDelegate,
		Target:  automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:stronger"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 2)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome := "failed"

	report := func(sessionID, turnID string, depth int) {
		service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
			WorkspaceID: "ws", AgentSessionID: sessionID,
			State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
				RuntimeContext: map[string]any{"automation": map[string]any{
					"ruleId": "parent", "depth": depth,
				}},
				TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{
					ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome,
				},
			},
		}, agentsessionstore.ReportSessionStateReply{})
	}

	report("rescue-level-1", "failed-1", 1)
	select {
	case call := <-calls:
		if call.AutomationDepth != 1 {
			t.Fatalf("AutomationDepth = %d, want 1", call.AutomationDepth)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for nested failure rescue")
	}

	report("rescue-level-3", "failed-3", maxAutomationRescueDepth)
	select {
	case call := <-calls:
		t.Fatalf("unexpected over-depth rescue = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestAutomationOriginCompletionRunsOnlyFixedAcceptanceReview(t *testing.T) {
	store := newMemoryStore()
	review, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:          "rule-review",
		WorkspaceID: "ws",
		Name:        "Review rescued work",
		Enabled:     true,
		Trigger:     automationrulebiz.TriggerOnTaskComplete,
		Action:      automationrulebiz.ActionConsult,
		Target:      automationrulebiz.Target{Kind: automationrulebiz.TargetModel, ModelPlanID: "plan-review"},
		Prompt:      "End with VERDICT: PASS or VERDICT: FAIL",
	})
	if err != nil {
		t.Fatal(err)
	}
	ordinary, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:          "rule-ordinary",
		WorkspaceID: "ws",
		Name:        "Ordinary completion",
		Enabled:     true,
		Trigger:     automationrulebiz.TriggerOnTaskComplete,
		Action:      automationrulebiz.ActionConsult,
		Target:      automationrulebiz.Target{Kind: automationrulebiz.TargetModel, ModelPlanID: "plan-summary"},
		Prompt:      "Summarize the result",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.CreateAutomationRule(context.Background(), ordinary)
	_ = store.CreateAutomationRule(context.Background(), review)
	calls := make(chan ExecutionInput, 2)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome, turnID := "completed", "turn-rescued"
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "rescue-session",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			RuntimeContext: map[string]any{"automation": map[string]any{"ruleId": "rescue", "depth": 1}},
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome,
			},
		},
	}, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		if call.Rule.ID != "rule-review" {
			t.Fatalf("automation-origin completion ran %q, want fixed review", call.Rule.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for rescued-work review")
	}
	select {
	case call := <-calls:
		t.Fatalf("unexpected recursive completion automation = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestListModelPlanReferencesUsesAutomationRuleKind(t *testing.T) {
	store := newMemoryStore()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "rule-1", WorkspaceID: "ws", Name: "Review", Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAutomationRule(context.Background(), rule); err != nil {
		t.Fatal(err)
	}
	references, err := (&Service{Store: store}).ListModelPlanReferences(context.Background(), "ws", "plan-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 1 || references[0].Kind != modelplanbiz.ReferenceAutomationRule || references[0].ID != "rule-1" {
		t.Fatalf("ListModelPlanReferences() = %#v", references)
	}
}

func TestObserveAgentSessionStateSkipsPersistedExecution(t *testing.T) {
	store := newMemoryStore()
	rule, _ := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "rule-1", WorkspaceID: "ws", Name: "Consult", Enabled: true,
		Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	})
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 1)
	service := &Service{
		Store:    store,
		Executor: recordingExecutor{calls: calls},
		Usage:    staticUsage{exists: true},
	}
	outcome, turnID := "completed", "turn-1"
	state := agentsessionstore.WorkspaceAgentSessionStateUpdate{
		TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
	}
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-1", State: state,
	}, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		t.Fatalf("unexpected duplicate execution = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestObserveAgentSessionStateCapsConsultOutputToRemainingTokenBudget(t *testing.T) {
	store := newMemoryStore()
	rule, _ := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "rule-1", WorkspaceID: "ws", Name: "Consult", Enabled: true,
		Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
		Budget: automationrulebiz.Budget{MaxTotalTokensPerSession: 100},
	})
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 1)
	service := &Service{
		Store:    store,
		Executor: recordingExecutor{calls: calls},
		Usage:    staticUsage{tokens: 40},
	}
	outcome, turnID := "completed", "turn-1"
	service.ObserveAgentSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, agentsessionstore.ReportSessionStateReply{})
	select {
	case call := <-calls:
		if call.MaxOutputTokens != 60 {
			t.Fatalf("MaxOutputTokens = %d, want 60", call.MaxOutputTokens)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for automation execution")
	}
}
