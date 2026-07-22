package automationrule

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
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

type staticAgents map[string]bool

func (a staticAgents) ValidateAutomationAgentReference(_ context.Context, workspaceID string, agentID string) error {
	if !a[storeKey(workspaceID, agentID)] {
		return errors.New("agent unavailable")
	}
	return nil
}

type staticTargets map[string]agenttargetbiz.Target

func (t staticTargets) GetAgentTarget(_ context.Context, targetID string) (agenttargetbiz.Target, error) {
	target, ok := t[targetID]
	if !ok {
		return agenttargetbiz.Target{}, errors.New("agent target not found")
	}
	return target, nil
}

type recordingExecutor struct {
	calls chan ExecutionInput
}

func (e recordingExecutor) ExecuteAutomationRule(_ context.Context, input ExecutionInput) (ExecutionResult, error) {
	e.calls <- input
	return ExecutionResult{TargetSessionID: "target-1"}, nil
}

type staticUsage struct {
	runs     int
	tokens   int64
	exists   bool
	recorded chan recordedUsage
}

type recordedUsage struct {
	workspaceID     string
	targetSessionID string
	totalTokens     int64
}

func (u staticUsage) AutomationRuleUsage(context.Context, string, string, string) (int, int64, error) {
	return u.runs, u.tokens, nil
}

func (u staticUsage) AutomationRuleExecutionExists(context.Context, string, string, string, string) (bool, error) {
	return u.exists, nil
}

func (u staticUsage) RecordAutomationTargetUsage(_ context.Context, workspaceID string, targetSessionID string, totalTokens int64) error {
	if u.recorded != nil {
		u.recorded <- recordedUsage{workspaceID: workspaceID, targetSessionID: targetSessionID, totalTokens: totalTokens}
	}
	return nil
}

func launchRule(t *testing.T, id string, trigger automationrulebiz.Trigger, targetAgentID string) automationrulebiz.Rule {
	t.Helper()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:          id,
		WorkspaceID: "ws",
		Name:        "Follow up",
		Enabled:     true,
		Trigger:     trigger,
		Target:      automationrulebiz.Target{WorkspaceAgentID: targetAgentID},
	})
	if err != nil {
		t.Fatal(err)
	}
	return rule
}

func TestCreateRuleValidatesWorkspaceAgentReferences(t *testing.T) {
	service := &Service{
		Store:  newMemoryStore(),
		Agents: staticAgents{storeKey("ws", "workspace-agent:source"): true, storeKey("ws", "workspace-agent:target"): true},
		NewID:  func() string { return "rule-1" },
	}
	rule, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID:            "ws",
		Name:                   "Follow up",
		SourceWorkspaceAgentID: "workspace-agent:source",
		Target:                 automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	})
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	if rule.Target.Kind != automationrulebiz.TargetAgent {
		t.Fatalf("CreateRule() target kind = %q", rule.Target.Kind)
	}

	if _, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Unknown target",
		Target:      automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:missing"},
	}); !errors.Is(err, ErrInvalidRuleInput) {
		t.Fatalf("CreateRule(unknown agent) error = %v", err)
	}
}

func TestCreateRuleValidatesBuiltinHarnessTargets(t *testing.T) {
	service := &Service{
		Store: newMemoryStore(),
		Targets: staticTargets{
			"local:claude-code": {ID: "local:claude-code", Name: "Claude Code", Provider: "claude-code", Enabled: true},
			"local:disabled":    {ID: "local:disabled", Name: "Disabled", Provider: "codex", Enabled: false},
		},
		NewID: func() string { return "rule-1" },
	}
	if _, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Escalate to built-in",
		Target:      automationrulebiz.Target{WorkspaceAgentID: "local:claude-code"},
	}); err != nil {
		t.Fatalf("CreateRule(builtin) error = %v", err)
	}
	if _, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Disabled built-in",
		Target:      automationrulebiz.Target{WorkspaceAgentID: "local:disabled"},
	}); !errors.Is(err, ErrInvalidRuleInput) {
		t.Fatalf("CreateRule(disabled builtin) error = %v", err)
	}
	if _, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws",
		Name:        "Unknown built-in",
		Target:      automationrulebiz.Target{WorkspaceAgentID: "local:missing"},
	}); !errors.Is(err, ErrInvalidRuleInput) {
		t.Fatalf("CreateRule(missing builtin) error = %v", err)
	}
}

func TestUpdateRulePreservesCreatedAtAndRequiresExistingRule(t *testing.T) {
	t.Parallel()

	store := newMemoryStore()
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	updatedAt := createdAt.Add(time.Minute)
	now := createdAt
	service := &Service{
		Store:  store,
		Agents: staticAgents{storeKey("ws", "workspace-agent:target"): true},
		Now:    func() time.Time { return now },
		NewID:  func() string { return "rule-1" },
	}
	created, err := service.CreateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", Name: "Before",
		Target: automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	})
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	now = updatedAt
	updated, err := service.UpdateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", RuleID: created.ID, Name: "After",
		Target: automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	})
	if err != nil {
		t.Fatalf("UpdateRule() error = %v", err)
	}
	if updated.Name != "After" || !updated.CreatedAt.Equal(createdAt) || !updated.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("UpdateRule() = %#v", updated)
	}
	if _, err := service.UpdateRule(context.Background(), PutRuleInput{
		WorkspaceID: "ws", RuleID: "missing", Name: "Missing",
		Target: automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:target"},
	}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("UpdateRule(missing) error = %v, want not found", err)
	}
}

func TestObserveAgentSessionStateRunsOncePerRuleAndTurn(t *testing.T) {
	store := newMemoryStore()
	rule := launchRule(t, "rule-1", automationrulebiz.TriggerOnTaskComplete, "workspace-agent:target")
	rule.SourceWorkspaceAgentID = "workspace-agent:source"
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 2)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome := "completed"
	turnID := "turn-1"
	input := canonical.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		AgentTargetID:  "workspace-agent:source",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			AgentTargetID: "workspace-agent:source",
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}
	service.ObserveAgentSessionState(context.Background(), input, canonical.ReportSessionStateReply{})
	service.ObserveAgentSessionState(context.Background(), input, canonical.ReportSessionStateReply{})
	select {
	case call := <-calls:
		if call.Rule.ID != "rule-1" || call.SourceAgentID != "workspace-agent:source" || call.TriggerID != "turn-1" {
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

func TestObserveAgentSessionStateRunsBoundedFailureRescueRule(t *testing.T) {
	store := newMemoryStore()
	_ = store.CreateAutomationRule(context.Background(), launchRule(t, "rule-rescue", automationrulebiz.TriggerOnTaskFailed, "workspace-agent:stronger"))
	calls := make(chan ExecutionInput, 1)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome, turnID := "failed", "turn-failed"
	service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, canonical.ReportSessionStateReply{})
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

func TestObserveAgentSessionStateHonorsBudget(t *testing.T) {
	store := newMemoryStore()
	rule := launchRule(t, "rule-1", automationrulebiz.TriggerOnTaskComplete, "workspace-agent:target")
	rule.Budget = automationrulebiz.Budget{MaxRunsPerSession: 1}
	_ = store.CreateAutomationRule(context.Background(), rule)
	calls := make(chan ExecutionInput, 1)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{runs: 1}}
	outcome, turnID := "completed", "turn-1"
	service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-budget",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, canonical.ReportSessionStateReply{})
	select {
	case call := <-calls:
		t.Fatalf("unexpected execution = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestAutomationOriginCompletionNeverRecursesAndRecordsTargetUsage(t *testing.T) {
	store := newMemoryStore()
	_ = store.CreateAutomationRule(context.Background(), launchRule(t, "rule-1", automationrulebiz.TriggerOnTaskComplete, "workspace-agent:target"))
	calls := make(chan ExecutionInput, 1)
	recorded := make(chan recordedUsage, 1)
	service := &Service{
		Store:    store,
		Executor: recordingExecutor{calls: calls},
		Usage:    staticUsage{recorded: recorded},
	}
	outcome, turnID := "completed", "turn-1"
	service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "automation-target-session",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			RuntimeContext: map[string]any{
				"automation": map[string]any{"ruleId": "rule-1", "sourceSessionId": "session-src", "depth": 1},
				"usage": map[string]any{
					"inputTokens":  float64(1200),
					"outputTokens": float64(300),
				},
			},
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
		},
	}, canonical.ReportSessionStateReply{})
	select {
	case usage := <-recorded:
		if usage.workspaceID != "ws" || usage.targetSessionID != "automation-target-session" || usage.totalTokens != 1500 {
			t.Fatalf("recorded usage = %#v", usage)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for target usage settlement")
	}
	select {
	case call := <-calls:
		t.Fatalf("automation-origin completion triggered rule = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestObserveAgentSessionStateAllowsOnlyBoundedFailureRescueChains(t *testing.T) {
	store := newMemoryStore()
	_ = store.CreateAutomationRule(context.Background(), launchRule(t, "rule-rescue", automationrulebiz.TriggerOnTaskFailed, "workspace-agent:stronger"))
	calls := make(chan ExecutionInput, 2)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome := "failed"

	report := func(sessionID, turnID string, depth int) {
		service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
			WorkspaceID: "ws", AgentSessionID: sessionID,
			State: canonical.WorkspaceAgentSessionStateUpdate{
				RuntimeContext: map[string]any{"automation": map[string]any{
					"ruleId": "parent", "depth": depth,
				}},
				TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
					ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome,
				},
			},
		}, canonical.ReportSessionStateReply{})
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

func TestListModelPlanReferencesUsesAutomationRuleKind(t *testing.T) {
	store := newMemoryStore()
	// A legacy plan-referencing rule can only exist as a pre-migration row;
	// simulate one directly to keep the deletion guard covered.
	store.rules[storeKey("ws", "rule-legacy")] = automationrulebiz.Rule{
		ID: "rule-legacy", WorkspaceID: "ws", Name: "Legacy consult",
		Target: automationrulebiz.Target{ModelPlanID: "plan-1"},
	}
	references, err := (&Service{Store: store}).ListModelPlanReferences(context.Background(), "ws", "plan-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences() error = %v", err)
	}
	if len(references) != 1 || references[0].ID != "rule-legacy" {
		t.Fatalf("ListModelPlanReferences() = %#v", references)
	}
}

func TestObserveAgentSessionStateSkipsPersistedExecution(t *testing.T) {
	store := newMemoryStore()
	_ = store.CreateAutomationRule(context.Background(), launchRule(t, "rule-1", automationrulebiz.TriggerOnTaskComplete, "workspace-agent:target"))
	calls := make(chan ExecutionInput, 1)
	service := &Service{
		Store:    store,
		Executor: recordingExecutor{calls: calls},
		Usage:    staticUsage{exists: true},
	}
	outcome, turnID := "completed", "turn-1"
	state := canonical.WorkspaceAgentSessionStateUpdate{
		TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{ActiveTurnID: &turnID, Phase: "settled", Outcome: &outcome},
	}
	service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID: "ws", AgentSessionID: "session-1", State: state,
	}, canonical.ReportSessionStateReply{})
	select {
	case call := <-calls:
		t.Fatalf("unexpected duplicate execution = %#v", call)
	case <-time.After(75 * time.Millisecond):
	}
}

func TestAutomationUsageTotalTokensReadsCumulativeAndLastCounters(t *testing.T) {
	t.Parallel()

	if total := automationUsageTotalTokens(map[string]any{"usage": map[string]any{
		"inputTokens":      float64(100),
		"outputTokens":     float64(50),
		"cacheReadTokens":  float64(25),
		"cacheWriteTokens": float64(5),
	}}); total != 180 {
		t.Fatalf("cumulative usage total = %d, want 180", total)
	}
	if total := automationUsageTotalTokens(map[string]any{"usage": map[string]any{
		"last": map[string]any{"input_tokens": float64(10), "output_tokens": float64(4)},
	}}); total != 14 {
		t.Fatalf("last usage total = %d, want 14", total)
	}
	if total := automationUsageTotalTokens(nil); total != 0 {
		t.Fatalf("empty usage total = %d, want 0", total)
	}
}
