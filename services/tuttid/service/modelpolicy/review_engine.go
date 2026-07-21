package modelpolicy

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
)

// BindingSource resolves the agent target binding that carries the default
// policy for a session's target.
type BindingSource interface {
	GetAgentModelBinding(ctx context.Context, workspaceID string, agentTargetID string) (modelbindingbiz.Binding, error)
}

// SessionTargetResolver resolves a session's agent target id when the state
// report does not carry it.
type SessionTargetResolver interface {
	ResolveSessionAgentTarget(workspaceID string, agentSessionID string) (agentTargetID string, ok bool)
}

// ReviewConsultInput describes one policy-triggered review call.
type ReviewConsultInput struct {
	WorkspaceID   string
	SourceSession string
	ModelPlanID   string
	Model         string
	Question      string
	TriggerReason string
	MaxTokens     int
}

// ReviewConsultResult is the review outcome the engine interprets.
type ReviewConsultResult struct {
	RunID       string
	ResultText  string
	Failed      bool
	TotalTokens int64
}

// ReviewConsultRunner executes the review as a policy-triggered collaboration
// consult run so it lands in the same accounting and timeline as manual
// consults.
type ReviewConsultRunner interface {
	RunPolicyReviewConsult(ctx context.Context, input ReviewConsultInput) (ReviewConsultResult, error)
}

// ReviewBudgetReader reports how much policy-triggered review the session has
// already consumed.
type ReviewBudgetReader interface {
	SumPolicyReviewUsage(ctx context.Context, workspaceID string, sourceSessionID string) (runs int, totalTokens int64, err error)
}

type reviewEngine struct {
	mu       sync.Mutex
	inFlight map[string]struct{}
	lastTurn map[string]string
}

// ConfigureReviewAutomation wires the optional review automation inputs.
func (s *Service) ConfigureReviewAutomation(bindings BindingSource, sessions SessionTargetResolver, runner ReviewConsultRunner, budget ReviewBudgetReader) {
	s.Bindings = bindings
	s.Sessions = sessions
	s.Runner = runner
	s.Budget = budget
}

// ObserveAgentSessionState implements the agent activity session-state
// observer: a turn settling with a completed outcome is "the agent claims the
// task is done". The engine records the claim on the acceptance ladder and,
// when the effective policy's fixed review rule allows, runs the automated
// review asynchronously. Automated review can raise the ladder to
// auto_checked only; user acceptance stays a user action.
func (s *Service) ObserveAgentSessionState(ctx context.Context, input canonical.ReportSessionStateInput, _ canonical.ReportSessionStateReply) {
	if s == nil || s.Store == nil {
		return
	}
	lifecycle := input.State.TurnLifecycle
	if lifecycle == nil || strings.TrimSpace(lifecycle.Phase) != "settled" || lifecycle.Outcome == nil || strings.TrimSpace(*lifecycle.Outcome) != "completed" {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	sessionKey := workspaceID + "/" + agentSessionID
	turnID := ""
	if lifecycle.ActiveTurnID != nil {
		turnID = strings.TrimSpace(*lifecycle.ActiveTurnID)
	}

	s.engine.mu.Lock()
	if s.engine.lastTurn == nil {
		s.engine.lastTurn = map[string]string{}
	}
	if turnID != "" && s.engine.lastTurn[sessionKey] == turnID {
		s.engine.mu.Unlock()
		return
	}
	if turnID != "" {
		s.engine.lastTurn[sessionKey] = turnID
	}
	s.engine.mu.Unlock()

	// The agent claimed completion: record the first rung unless the user has
	// already accepted this exact state of work.
	if existing, ok, err := s.GetAcceptance(ctx, workspaceID, agentSessionID); err == nil {
		if !ok || existing.State != modelpolicybiz.AcceptanceUserAccepted {
			_ = s.Store.PutAgentSessionAcceptance(ctx, modelpolicybiz.Acceptance{
				WorkspaceID:    workspaceID,
				AgentSessionID: agentSessionID,
				State:          modelpolicybiz.AcceptanceAgentClaimed,
				UpdatedAt:      s.now(),
			})
		}
	}

	policy, ok := s.resolveEffectivePolicy(ctx, workspaceID, agentSessionID, strings.TrimSpace(input.State.AgentTargetID))
	if !ok || !policy.ReviewRule.Enabled {
		return
	}
	if s.Runner == nil {
		return
	}

	s.engine.mu.Lock()
	if s.engine.inFlight == nil {
		s.engine.inFlight = map[string]struct{}{}
	}
	if _, busy := s.engine.inFlight[sessionKey]; busy {
		s.engine.mu.Unlock()
		return
	}
	s.engine.inFlight[sessionKey] = struct{}{}
	s.engine.mu.Unlock()

	// The review is a real model call; never block the activity report path.
	go func() {
		defer func() {
			s.engine.mu.Lock()
			delete(s.engine.inFlight, sessionKey)
			s.engine.mu.Unlock()
		}()
		reviewCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		s.runReview(reviewCtx, workspaceID, agentSessionID, policy)
	}()
}

func (s *Service) resolveEffectivePolicy(ctx context.Context, workspaceID string, agentSessionID string, agentTargetID string) (modelpolicybiz.Policy, bool) {
	override, hasOverride, err := s.GetSessionOverride(ctx, workspaceID, agentSessionID)
	if err != nil {
		return modelpolicybiz.Policy{}, false
	}
	if hasOverride && override.Disabled {
		return modelpolicybiz.Policy{}, false
	}
	policyID := ""
	if hasOverride && override.ModelPolicyID != "" {
		policyID = override.ModelPolicyID
	} else {
		if agentTargetID == "" && s.Sessions != nil {
			if resolved, ok := s.Sessions.ResolveSessionAgentTarget(workspaceID, agentSessionID); ok {
				agentTargetID = resolved
			}
		}
		if agentTargetID == "" || s.Bindings == nil {
			return modelpolicybiz.Policy{}, false
		}
		binding, err := s.Bindings.GetAgentModelBinding(ctx, workspaceID, agentTargetID)
		if err != nil || strings.TrimSpace(binding.ModelPolicyID) == "" {
			return modelpolicybiz.Policy{}, false
		}
		policyID = binding.ModelPolicyID
	}
	policy, err := s.Store.GetModelPolicy(ctx, workspaceID, policyID)
	if err != nil {
		return modelpolicybiz.Policy{}, false
	}
	return policy, true
}

func (s *Service) runReview(ctx context.Context, workspaceID string, agentSessionID string, policy modelpolicybiz.Policy) {
	if s.Budget != nil {
		runs, totalTokens, err := s.Budget.SumPolicyReviewUsage(ctx, workspaceID, agentSessionID)
		if err != nil {
			// Fail closed: without trustworthy usage accounting the per-session
			// run/token budget cannot be enforced, so never start a billable
			// review that could spend unmetered tokens.
			slog.Warn("model policy review budget read failed; skipping automated review",
				"event", "model_policy.review_budget_read_failed",
				"workspace_id", workspaceID,
				"agent_session_id", agentSessionID,
				"policy_id", policy.ID,
				"error", err,
			)
			return
		}
		if runs >= policy.ReviewRule.EffectiveMaxRuns() || totalTokens >= policy.ReviewRule.EffectiveMaxTotalTokens() {
			slog.Info("model policy review budget exhausted; skipping automated review",
				"event", "model_policy.review_budget_exhausted",
				"workspace_id", workspaceID,
				"agent_session_id", agentSessionID,
				"policy_id", policy.ID,
				"runs", runs,
				"total_tokens", totalTokens,
			)
			return
		}
	}
	result, err := s.Runner.RunPolicyReviewConsult(ctx, ReviewConsultInput{
		WorkspaceID:   workspaceID,
		SourceSession: agentSessionID,
		ModelPlanID:   policy.Review.ModelPlanID,
		Model:         policy.Review.Model,
		Question: "Review the work this coding agent session just claimed to complete. " +
			"Judge whether the claimed outcome is plausible and internally consistent. " +
			"Answer with your findings, then end with exactly one final line: VERDICT: PASS or VERDICT: FAIL.",
		TriggerReason: "review_rule:" + string(policy.ReviewRule.Trigger),
		MaxTokens:     2048,
	})
	if err != nil || result.Failed {
		slog.Warn("model policy automated review failed",
			"event", "model_policy.review_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"policy_id", policy.ID,
			"error", err,
		)
		return
	}
	if !reviewVerdictPassed(result.ResultText) {
		// A failing review keeps the ladder at agent_claimed; the run itself
		// is visible in the collaboration timeline for the user to inspect.
		return
	}
	if existing, ok, err := s.GetAcceptance(ctx, workspaceID, agentSessionID); err == nil {
		if ok && existing.State == modelpolicybiz.AcceptanceUserAccepted {
			return
		}
	}
	_ = s.Store.PutAgentSessionAcceptance(ctx, modelpolicybiz.Acceptance{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		State:          modelpolicybiz.AcceptanceAutoChecked,
		ReviewRunID:    result.RunID,
		UpdatedAt:      s.now(),
	})
}

// reviewVerdictPassed parses the required final verdict line. Missing or
// malformed verdicts count as not passed.
func reviewVerdictPassed(resultText string) bool {
	lines := strings.Split(strings.TrimSpace(resultText), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.ToUpper(strings.TrimSpace(lines[index]))
		if line == "" {
			continue
		}
		if strings.Contains(line, "VERDICT:") {
			return strings.Contains(line, "PASS") && !strings.Contains(line, "FAIL")
		}
		return false
	}
	return false
}
