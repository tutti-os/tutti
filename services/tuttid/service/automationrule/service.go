// Package automationrule manages workspace automation rules and evaluates
// them against durable agent-session lifecycle reports. A triggered rule
// launches one new target-Agent session; the retired consult/fork/delegate/
// handoff action split no longer exists.
package automationrule

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

var ErrInvalidRuleInput = errors.New("invalid automation rule input")

// Store is the persistence surface implemented by the workspace SQLite store.
type Store interface {
	ListAutomationRules(context.Context, string) ([]automationrulebiz.Rule, error)
	GetAutomationRule(context.Context, string, string) (automationrulebiz.Rule, error)
	CreateAutomationRule(context.Context, automationrulebiz.Rule) error
	UpdateAutomationRule(context.Context, automationrulebiz.Rule) (automationrulebiz.Rule, error)
	DeleteAutomationRule(context.Context, string, string) error
	ListAutomationRulesByPlan(context.Context, string, string) ([]automationrulebiz.Rule, error)
	GetAutomationRuleSessionOverride(context.Context, string, string) (automationrulebiz.SessionOverride, bool, error)
	PutAutomationRuleSessionOverride(context.Context, automationrulebiz.SessionOverride) error
}

// AgentReferenceValidator lets the WorkspaceAgent service validate an opaque
// workspace-agent reference without coupling this package to its persistence
// implementation.
type AgentReferenceValidator interface {
	ValidateAutomationAgentReference(context.Context, string, string) error
}

// AgentTargetReader resolves built-in Harness targets so a rule can always
// select a built-in default Agent even when no WorkspaceAgent exists.
type AgentTargetReader interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type Publisher interface {
	PublishAutomationRulesChanged(workspaceID string)
}

// UsageLedger is the durable automation execution ledger. It answers the
// dedup and budget guards for one rule and source session, and accumulates
// the launched target session's recorded token usage.
type UsageLedger interface {
	AutomationRuleUsage(context.Context, string, string, string) (runs int, totalTokens int64, err error)
	AutomationRuleExecutionExists(context.Context, string, string, string, string) (bool, error)
	RecordAutomationTargetUsage(ctx context.Context, workspaceID string, targetSessionID string, totalTokens int64) error
}

type ExecutionInput struct {
	Rule            automationrulebiz.Rule
	WorkspaceID     string
	SourceSessionID string
	SourceAgentID   string
	// AutomationDepth is zero for a user-origin Session and increments for
	// every automatically launched Agent in a bounded rescue chain.
	AutomationDepth int
	TriggerID       string
	SourceCwd       string
}

type ExecutionResult struct {
	TargetSessionID string
}

// Executor owns the concrete session-launch mechanics. The daemon wiring
// implements it with agent.Service plus the durable execution ledger.
type Executor interface {
	ExecuteAutomationRule(context.Context, ExecutionInput) (ExecutionResult, error)
}

// SourceReader resolves the source session's working directory so the
// launched follow-up session starts in the same project. Source conversation
// content travels through the session mention, not through an inline
// transcript copy.
type SourceReader interface {
	AutomationSourceCwd(context.Context, string, string) (string, error)
}

type Service struct {
	Store     Store
	Agents    AgentReferenceValidator
	Targets   AgentTargetReader
	Publisher Publisher
	Usage     UsageLedger
	Executor  Executor
	Sources   SourceReader
	Now       func() time.Time
	NewID     func() string

	engine ruleEngine
}

type PutRuleInput struct {
	WorkspaceID            string
	RuleID                 string
	Name                   string
	Enabled                bool
	Trigger                automationrulebiz.Trigger
	SourceWorkspaceAgentID string
	Target                 automationrulebiz.Target
	Permissions            automationrulebiz.PermissionPolicy
	Budget                 automationrulebiz.Budget
	Prompt                 string
}

func (s *Service) ListRules(ctx context.Context, workspaceID string) ([]automationrulebiz.Rule, error) {
	if s == nil || s.Store == nil {
		return nil, errors.New("automation rule store is unavailable")
	}
	rules, err := s.Store.ListAutomationRules(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	if rules == nil {
		return []automationrulebiz.Rule{}, nil
	}
	return rules, nil
}

func (s *Service) GetRule(ctx context.Context, workspaceID string, ruleID string) (automationrulebiz.Rule, error) {
	if s == nil || s.Store == nil {
		return automationrulebiz.Rule{}, errors.New("automation rule store is unavailable")
	}
	return s.Store.GetAutomationRule(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(ruleID))
}

func (s *Service) CreateRule(ctx context.Context, input PutRuleInput) (automationrulebiz.Rule, error) {
	if s == nil || s.Store == nil {
		return automationrulebiz.Rule{}, errors.New("automation rule store is unavailable")
	}
	now := s.now()
	if strings.TrimSpace(input.RuleID) != "" {
		return automationrulebiz.Rule{}, fmt.Errorf("%w: create must not specify a rule id", ErrInvalidRuleInput)
	}
	rule, err := normalizeRule(input, s.newID(), now, now)
	if err != nil {
		return automationrulebiz.Rule{}, err
	}
	if err := s.validateReferences(ctx, rule); err != nil {
		return automationrulebiz.Rule{}, err
	}
	if err := s.Store.CreateAutomationRule(ctx, rule); err != nil {
		return automationrulebiz.Rule{}, err
	}
	s.publish(rule.WorkspaceID)
	return rule, nil
}

func (s *Service) UpdateRule(ctx context.Context, input PutRuleInput) (automationrulebiz.Rule, error) {
	if s == nil || s.Store == nil {
		return automationrulebiz.Rule{}, errors.New("automation rule store is unavailable")
	}
	ruleID := strings.TrimSpace(input.RuleID)
	if ruleID == "" {
		return automationrulebiz.Rule{}, fmt.Errorf("%w: update requires a rule id", ErrInvalidRuleInput)
	}
	rule, err := normalizeRule(input, ruleID, time.Time{}, s.now())
	if err != nil {
		return automationrulebiz.Rule{}, err
	}
	if err := s.validateReferences(ctx, rule); err != nil {
		return automationrulebiz.Rule{}, err
	}
	updated, err := s.Store.UpdateAutomationRule(ctx, rule)
	if err != nil {
		return automationrulebiz.Rule{}, err
	}
	s.publish(updated.WorkspaceID)
	return updated, nil
}

func normalizeRule(input PutRuleInput, ruleID string, createdAt time.Time, updatedAt time.Time) (automationrulebiz.Rule, error) {
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID:                     ruleID,
		WorkspaceID:            input.WorkspaceID,
		Name:                   input.Name,
		Enabled:                input.Enabled,
		Trigger:                input.Trigger,
		SourceWorkspaceAgentID: input.SourceWorkspaceAgentID,
		Target:                 input.Target,
		Permissions:            input.Permissions,
		Budget:                 input.Budget,
		Prompt:                 input.Prompt,
		CreatedAt:              createdAt,
		UpdatedAt:              updatedAt,
	})
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("%w: %w", ErrInvalidRuleInput, err)
	}
	return rule, nil
}

func (s *Service) DeleteRule(ctx context.Context, workspaceID string, ruleID string) error {
	if s == nil || s.Store == nil {
		return errors.New("automation rule store is unavailable")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if err := s.Store.DeleteAutomationRule(ctx, workspaceID, strings.TrimSpace(ruleID)); err != nil {
		return err
	}
	s.publish(workspaceID)
	return nil
}

func (s *Service) SetSessionOverride(ctx context.Context, override automationrulebiz.SessionOverride) (automationrulebiz.SessionOverride, error) {
	if s == nil || s.Store == nil {
		return automationrulebiz.SessionOverride{}, errors.New("automation rule store is unavailable")
	}
	normalized, err := automationrulebiz.NormalizeSessionOverride(override)
	if err != nil {
		return automationrulebiz.SessionOverride{}, fmt.Errorf("%w: %w", ErrInvalidRuleInput, err)
	}
	for _, ruleID := range normalized.RuleIDs {
		if _, err := s.Store.GetAutomationRule(ctx, normalized.WorkspaceID, ruleID); err != nil {
			return automationrulebiz.SessionOverride{}, err
		}
	}
	normalized.UpdatedAt = s.now()
	if err := s.Store.PutAutomationRuleSessionOverride(ctx, normalized); err != nil {
		return automationrulebiz.SessionOverride{}, err
	}
	return normalized, nil
}

func (s *Service) GetSessionOverride(ctx context.Context, workspaceID string, agentSessionID string) (automationrulebiz.SessionOverride, bool, error) {
	if s == nil || s.Store == nil {
		return automationrulebiz.SessionOverride{}, false, errors.New("automation rule store is unavailable")
	}
	return s.Store.GetAutomationRuleSessionOverride(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
}

func (s *Service) validateReferences(ctx context.Context, rule automationrulebiz.Rule) error {
	if source := strings.TrimSpace(rule.SourceWorkspaceAgentID); source != "" {
		if s.Agents == nil {
			return fmt.Errorf("%w: workspace agent validator is unavailable", ErrInvalidRuleInput)
		}
		if err := s.Agents.ValidateAutomationAgentReference(ctx, rule.WorkspaceID, source); err != nil {
			return fmt.Errorf("%w: invalid source workspace agent: %w", ErrInvalidRuleInput, err)
		}
	}
	targetID := strings.TrimSpace(rule.Target.WorkspaceAgentID)
	if strings.HasPrefix(targetID, workspaceagentbiz.IDPrefix) {
		if s.Agents == nil {
			return fmt.Errorf("%w: workspace agent validator is unavailable", ErrInvalidRuleInput)
		}
		if err := s.Agents.ValidateAutomationAgentReference(ctx, rule.WorkspaceID, targetID); err != nil {
			return fmt.Errorf("%w: invalid target workspace agent: %w", ErrInvalidRuleInput, err)
		}
		return nil
	}
	if s.Targets == nil {
		return fmt.Errorf("%w: agent target reader is unavailable", ErrInvalidRuleInput)
	}
	target, err := s.Targets.GetAgentTarget(ctx, targetID)
	if err != nil {
		return fmt.Errorf("%w: invalid target agent: %w", ErrInvalidRuleInput, err)
	}
	if !target.Enabled {
		return fmt.Errorf("%w: target agent is disabled", ErrInvalidRuleInput)
	}
	return nil
}

// ListModelPlanReferences implements the model-plan deletion guard for the
// composite reference resolver. Automation rules can no longer reference a
// plan — Normalize rejects plan targets on write and the automation_rules_v2
// migration cleared the stored plan columns — so this reports an empty list
// and exists for contract stability with the other plan consumers.
func (s *Service) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	if s == nil || s.Store == nil {
		return nil, errors.New("automation rule store is unavailable")
	}
	rules, err := s.Store.ListAutomationRulesByPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	references := make([]modelplanbiz.Reference, 0, len(rules))
	for _, rule := range rules {
		references = append(references, modelplanbiz.Reference{
			Kind: modelplanbiz.ReferenceAutomationRule,
			ID:   rule.ID,
			Name: rule.Name,
			Role: "automation",
		})
	}
	return references, nil
}

func (s *Service) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s != nil && s.NewID != nil {
		return s.NewID()
	}
	data := make([]byte, 12)
	_, _ = rand.Read(data)
	return "automation-rule:" + base64.RawURLEncoding.EncodeToString(data)
}

func (s *Service) publish(workspaceID string) {
	if s != nil && s.Publisher != nil {
		s.Publisher.PublishAutomationRulesChanged(strings.TrimSpace(workspaceID))
	}
}

type ruleEngine struct {
	mu        sync.Mutex
	inFlight  map[string]struct{}
	seen      map[string]struct{}
	seenOrder []string
}

const maxRememberedAutomationExecutions = 8192

// Rescue chains may cross several purpose-built Agents, but must remain
// finite even when a broad failure rule targets an Agent that fails in the
// same way. Depth counts automatically launched Sessions.
const maxAutomationRescueDepth = 3

// ObserveAgentSessionState evaluates completed- and failed-turn rules and
// settles the recorded token usage of automation-origin target sessions.
// Concrete launches run asynchronously so activity persistence is never
// blocked by automation.
func (s *Service) ObserveAgentSessionState(ctx context.Context, input canonical.ReportSessionStateInput, _ canonical.ReportSessionStateReply) {
	if s == nil || s.Store == nil || s.Executor == nil {
		return
	}
	trigger, ok := automationTriggerFromState(input.State)
	if !ok {
		return
	}
	// Automation rules are defined over root Sessions. Child sessions (for
	// example codex collab threads) report their own settled turns through
	// the same state pipeline, and the root's canonical settlement arrives
	// separately via the projection's root-turn observation.
	if automationStateIsChildSession(input.State) {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || sessionID == "" {
		return
	}
	automationDepth, automationOrigin := automationOriginDepth(input.State.RuntimeContext)
	if automationOrigin {
		s.recordTargetUsage(ctx, workspaceID, sessionID, input.State.RuntimeContext)
		// Automation-origin completions never trigger further completion
		// rules; only bounded failure rescue may continue the chain.
		if trigger == automationrulebiz.TriggerOnTaskComplete {
			return
		}
		if automationDepth >= maxAutomationRescueDepth {
			return
		}
	}
	sourceAgentID := strings.TrimSpace(input.State.AgentTargetID)
	if sourceAgentID == "" {
		sourceAgentID = strings.TrimSpace(input.AgentTargetID)
	}
	rules, err := s.effectiveRules(ctx, workspaceID, sessionID)
	if err != nil {
		slog.Warn("automation rule evaluation failed", "event", "automation_rule.evaluate_failed", "workspace_id", workspaceID, "agent_session_id", sessionID, "error", err)
		return
	}
	turnID := settledTurnID(input.State)
	for _, rule := range rules {
		if !rule.Enabled || rule.Trigger != trigger {
			continue
		}
		if !automationRuleMatchesSource(workspaceID, rule.SourceWorkspaceAgentID, sourceAgentID) {
			continue
		}
		key := workspaceID + "/" + sessionID + "/" + rule.ID + "/" + turnID
		if !s.claimRuleRun(key) {
			continue
		}
		go s.runRule(key, workspaceID, sessionID, sourceAgentID, automationDepth, turnID, rule)
	}
}

// recordTargetUsage settles the launched session's recorded token counters
// into the execution ledger so the per-source-session token budget keeps
// counting real usage after CollaborationRun bookkeeping was retired for
// automation.
func (s *Service) recordTargetUsage(ctx context.Context, workspaceID string, targetSessionID string, runtimeContext map[string]any) {
	if s.Usage == nil {
		return
	}
	totalTokens := automationUsageTotalTokens(runtimeContext)
	if totalTokens <= 0 {
		return
	}
	if err := s.Usage.RecordAutomationTargetUsage(ctx, workspaceID, targetSessionID, totalTokens); err != nil {
		slog.Warn("automation target usage settlement failed",
			"event", "automation_rule.target_usage_settle_failed",
			"workspace_id", workspaceID,
			"agent_session_id", targetSessionID,
			"error", err)
	}
}

func automationUsageTotalTokens(runtimeContext map[string]any) int64 {
	usage, _ := runtimeContext["usage"].(map[string]any)
	if len(usage) == 0 {
		return 0
	}
	total := usageCounterTotal(usage)
	if total == 0 {
		if last, ok := usage["last"].(map[string]any); ok {
			total = usageCounterTotal(last)
		}
	}
	return total
}

func usageCounterTotal(payload map[string]any) int64 {
	return usageInt64(payload, "inputTokens", "input_tokens") +
		usageInt64(payload, "outputTokens", "output_tokens") +
		usageInt64(payload, "cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens") +
		usageInt64(payload, "cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens")
}

func usageInt64(payload map[string]any, keys ...string) int64 {
	for _, key := range keys {
		switch value := payload[key].(type) {
		case int:
			return int64(value)
		case int32:
			return int64(value)
		case int64:
			return value
		case float64:
			return int64(value)
		}
	}
	return 0
}

func automationRuleMatchesSource(workspaceID string, configuredSourceAgentID string, sessionSourceAgentID string) bool {
	configuredSourceAgentID = strings.TrimSpace(configuredSourceAgentID)
	sessionSourceAgentID = strings.TrimSpace(sessionSourceAgentID)
	if configuredSourceAgentID == "" || configuredSourceAgentID == sessionSourceAgentID {
		return true
	}
	// Sessions created before workspace_agents_v1 retain the raw Harness target
	// id in their durable activity. Only deterministic migrated Agent ids get
	// this alias; an ordinary WorkspaceAgent can never be impersonated by a raw
	// Harness id.
	if !strings.HasPrefix(configuredSourceAgentID, workspaceagentbiz.IDPrefix+"legacy:") ||
		strings.HasPrefix(sessionSourceAgentID, workspaceagentbiz.IDPrefix) {
		return false
	}
	return configuredSourceAgentID == workspaceagentbiz.LegacyBindingID(workspaceID, sessionSourceAgentID)
}

func (s *Service) effectiveRules(ctx context.Context, workspaceID string, sessionID string) ([]automationrulebiz.Rule, error) {
	rules, err := s.Store.ListAutomationRules(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	override, ok, err := s.GetSessionOverride(ctx, workspaceID, sessionID)
	if err != nil {
		return nil, err
	}
	if !ok || len(override.RuleIDs) == 0 {
		if ok && override.Disabled {
			return nil, nil
		}
		return rules, nil
	}
	if override.Disabled {
		return nil, nil
	}
	selected := make(map[string]struct{}, len(override.RuleIDs))
	for _, ruleID := range override.RuleIDs {
		selected[ruleID] = struct{}{}
	}
	filtered := make([]automationrulebiz.Rule, 0, len(selected))
	for _, rule := range rules {
		if _, ok := selected[rule.ID]; ok {
			filtered = append(filtered, rule)
		}
	}
	return filtered, nil
}

func (s *Service) claimRuleRun(key string) bool {
	s.engine.mu.Lock()
	defer s.engine.mu.Unlock()
	if s.engine.seen == nil {
		s.engine.seen = make(map[string]struct{})
	}
	if s.engine.inFlight == nil {
		s.engine.inFlight = make(map[string]struct{})
	}
	if _, ok := s.engine.seen[key]; ok {
		return false
	}
	if _, ok := s.engine.inFlight[key]; ok {
		return false
	}
	s.engine.inFlight[key] = struct{}{}
	return true
}

func (s *Service) runRule(key string, workspaceID string, sessionID string, sourceAgentID string, automationDepth int, triggerID string, rule automationrulebiz.Rule) {
	defer func() {
		s.engine.mu.Lock()
		delete(s.engine.inFlight, key)
		s.engine.seen[key] = struct{}{}
		s.engine.seenOrder = append(s.engine.seenOrder, key)
		if overflow := len(s.engine.seenOrder) - maxRememberedAutomationExecutions; overflow > 0 {
			for _, expired := range s.engine.seenOrder[:overflow] {
				delete(s.engine.seen, expired)
			}
			s.engine.seenOrder = append([]string(nil), s.engine.seenOrder[overflow:]...)
		}
		s.engine.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if s.Usage != nil {
		exists, err := s.Usage.AutomationRuleExecutionExists(ctx, workspaceID, sessionID, rule.ID, triggerID)
		if err != nil {
			slog.Warn("automation rule execution lookup failed", "event", "automation_rule.execution_lookup_failed", "rule_id", rule.ID, "error", err)
			return
		}
		if exists {
			return
		}
		runs, tokens, err := s.Usage.AutomationRuleUsage(ctx, workspaceID, sessionID, rule.ID)
		if err != nil {
			slog.Warn("automation rule usage lookup failed", "event", "automation_rule.usage_failed", "rule_id", rule.ID, "error", err)
			return
		}
		if runs >= rule.Budget.EffectiveMaxRuns() || tokens >= rule.Budget.EffectiveMaxTotalTokens() {
			slog.Info("automation rule budget exhausted", "event", "automation_rule.budget_exhausted", "rule_id", rule.ID, "runs", runs, "total_tokens", tokens)
			return
		}
	}
	cwd := ""
	if s.Sources != nil {
		var err error
		cwd, err = s.Sources.AutomationSourceCwd(ctx, workspaceID, sessionID)
		if err != nil {
			slog.Warn("automation rule source lookup failed", "event", "automation_rule.source_failed", "rule_id", rule.ID, "error", err)
			return
		}
	}
	if _, err := s.Executor.ExecuteAutomationRule(ctx, ExecutionInput{
		Rule:            rule,
		WorkspaceID:     workspaceID,
		SourceSessionID: sessionID,
		SourceAgentID:   sourceAgentID,
		AutomationDepth: automationDepth,
		TriggerID:       triggerID,
		SourceCwd:       cwd,
	}); err != nil {
		slog.Warn("automation rule execution failed", "event", "automation_rule.execute_failed", "rule_id", rule.ID, "error", err)
	}
}

func automationStateIsChildSession(state canonical.WorkspaceAgentSessionStateUpdate) bool {
	if strings.EqualFold(strings.TrimSpace(state.Kind), "child") {
		return true
	}
	return strings.TrimSpace(state.ParentAgentSessionID) != ""
}

func automationTriggerFromState(state canonical.WorkspaceAgentSessionStateUpdate) (automationrulebiz.Trigger, bool) {
	outcome := ""
	if state.TurnLifecycle != nil && strings.TrimSpace(state.TurnLifecycle.Phase) == "settled" && state.TurnLifecycle.Outcome != nil {
		outcome = strings.TrimSpace(*state.TurnLifecycle.Outcome)
	}
	if outcome == "" && state.Turn != nil && strings.TrimSpace(state.Turn.Phase) == "settled" {
		outcome = strings.TrimSpace(state.Turn.Outcome)
	}
	switch outcome {
	case "completed":
		return automationrulebiz.TriggerOnTaskComplete, true
	case "failed", "interrupted":
		return automationrulebiz.TriggerOnTaskFailed, true
	default:
		return "", false
	}
}

func settledTurnID(state canonical.WorkspaceAgentSessionStateUpdate) string {
	if state.Turn != nil && strings.TrimSpace(state.Turn.TurnID) != "" {
		return strings.TrimSpace(state.Turn.TurnID)
	}
	if state.TurnLifecycle != nil && state.TurnLifecycle.ActiveTurnID != nil && strings.TrimSpace(*state.TurnLifecycle.ActiveTurnID) != "" {
		return strings.TrimSpace(*state.TurnLifecycle.ActiveTurnID)
	}
	// The persistence report timestamp is stable for duplicate delivery and is
	// safer than treating every turnless settled patch as a new completion.
	return fmt.Sprintf("occurred:%d", state.OccurredAtUnixMS)
}

func automationOriginDepth(runtimeContext map[string]any) (int, bool) {
	if len(runtimeContext) == 0 {
		return 0, false
	}
	if value, ok := runtimeContext["automationRuleId"].(string); ok && strings.TrimSpace(value) != "" {
		return 1, true
	}
	if origin, ok := runtimeContext["automation"].(map[string]any); ok {
		value, _ := origin["ruleId"].(string)
		if strings.TrimSpace(value) == "" {
			return 0, false
		}
		if depth := nonNegativeAutomationDepth(origin["depth"]); depth > 0 {
			return depth, true
		}
		return 1, true
	}
	return 0, false
}

func nonNegativeAutomationDepth(value any) int {
	switch typed := value.(type) {
	case int:
		if typed >= 0 {
			return typed
		}
	case int64:
		if typed >= 0 && typed <= int64(^uint(0)>>1) {
			return int(typed)
		}
	case float64:
		if typed >= 0 && typed == float64(int(typed)) {
			return int(typed)
		}
	}
	return 0
}
