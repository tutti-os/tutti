// Package collabrun orchestrates collaboration runs: daemon-side model
// consults executed against a workspace model access plan, plus recorded
// fork, delegate, and handoff runs linked to sessions the GUI creates through
// the existing session-create path.
package collabrun

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

// DefaultMaxConsultRunsPerSourceSession caps consult runs per source session
// so a runaway agent cannot burn a plan's budget from one conversation.
const DefaultMaxConsultRunsPerSourceSession = 20

// consultSystemPrompt frames the advisor role: advice only, no tools, and no
// change of task ownership.
const consultSystemPrompt = "You are an advisor. Provide your best recommendation. " +
	"You cannot execute tools; reply with analysis and advice only."

var (
	ErrInvalidRunInput     = errors.New("invalid collaboration run input")
	ErrPlanNotUsable       = errors.New("model plan is not usable for consult")
	ErrModelNotInPlan      = errors.New("model is not part of the referenced plan")
	ErrConsultLimitReached = errors.New("consult run limit reached for source session")
	ErrInvalidAdoption     = errors.New("invalid collaboration run adoption transition")
	ErrRunNotRetryable     = errors.New("collaboration run is not retryable")
)

// Completer performs one minimal single-turn completion against a plan
// protocol endpoint. *modelplanservice.Service satisfies it.
type Completer interface {
	Complete(ctx context.Context, request modelplanservice.CompletionRequest) (modelplanservice.CompletionResult, error)
}

// Publisher broadcasts collaboration run changes on the business event stream.
type Publisher interface {
	PublishCollaborationRunUpdated(workspaceID string, run collabrunbiz.Run)
}

// Timeline reports collaboration runs into the source session timeline. It is
// optional and implemented later by the agent service.
type Timeline interface {
	ReportCollaborationTimeline(ctx context.Context, run collabrunbiz.Run)
}

// TargetSessionCanceller stops the active turn for a non-consult
// collaboration target. The agent service is adapted to this narrow surface
// in wiring so this package does not own agent-session business rules.
type TargetSessionCanceller interface {
	CancelTargetSession(ctx context.Context, workspaceID string, agentSessionID string) error
}

// TargetSessionLauncher starts one daemon-owned fork, delegate, or handoff
// session after its running collaboration record is durable.
type TargetSessionLauncher interface {
	LaunchCollaborationTarget(ctx context.Context, input TargetSessionLaunchInput) error
}

// TerminalRunObserver receives durable terminal CollaborationRuns. It is an
// optional accounting hook; failures never roll back the already-persisted
// collaboration lifecycle and idempotent observers may see the same run
// again after later adoption updates.
type TerminalRunObserver interface {
	RecordCollaborationRun(context.Context, collabrunbiz.Run) error
}

type Service struct {
	Store            workspacedata.CollaborationRunsStore
	Plans            workspacedata.ModelPlansStore
	Completer        Completer
	Publisher        Publisher
	Timeline         Timeline
	Canceller        TargetSessionCanceller
	Launcher         TargetSessionLauncher
	TerminalObserver TerminalRunObserver
	// MaxConsultRunsPerSourceSession defaults to
	// DefaultMaxConsultRunsPerSourceSession when zero.
	MaxConsultRunsPerSourceSession int
	Now                            func() time.Time
	NewID                          func() string

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	runMu   sync.Mutex
}

type StartConsultInput struct {
	WorkspaceID     string
	SourceSessionID string
	ModelPlanID     string
	// Model defaults to the plan default model when empty.
	Model         string
	Question      string
	ContextText   string
	TriggerSource string
	TriggerReason string
	MaxTokens     int
	RetryOfRunID  string
	Attempt       int
}

// StartConsult executes one synchronous advisory completion against a plan
// and records both lifecycle transitions. Pre-flight failures return an
// error; completion failures return the persisted failed run with nil error.
func (s *Service) StartConsult(ctx context.Context, input StartConsultInput) (collabrunbiz.Run, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sourceSessionID := strings.TrimSpace(input.SourceSessionID)
	question := strings.TrimSpace(input.Question)
	if question == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: question is required", ErrInvalidRunInput)
	}
	if sourceSessionID == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: source session id is required", ErrInvalidRunInput)
	}

	plan, err := s.Plans.GetModelPlan(ctx, workspaceID, strings.TrimSpace(input.ModelPlanID))
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
			return collabrunbiz.Run{}, fmt.Errorf("%w: plan not found", ErrPlanNotUsable)
		}
		return collabrunbiz.Run{}, err
	}
	if !plan.Enabled {
		return collabrunbiz.Run{}, fmt.Errorf("%w: plan is disabled", ErrPlanNotUsable)
	}
	model := strings.TrimSpace(input.Model)
	if model == "" {
		model = plan.DefaultModel
	}
	if model == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: model is required and the plan has no default model", ErrInvalidRunInput)
	}
	if len(plan.Models) > 0 && !modelplanbiz.ModelsContain(plan.Models, model) {
		return collabrunbiz.Run{}, ErrModelNotInPlan
	}

	if err := s.checkConsultLimit(ctx, workspaceID, sourceSessionID); err != nil {
		return collabrunbiz.Run{}, err
	}

	contextText := strings.TrimSpace(input.ContextText)
	prompt := question
	if contextText != "" {
		prompt = contextText + "\n\n" + question
	}
	now := s.now()
	run := collabrunbiz.Run{
		ID:              s.newID(),
		WorkspaceID:     workspaceID,
		Mode:            collabrunbiz.ModeConsult,
		TriggerSource:   collabrunbiz.TriggerSource(strings.TrimSpace(input.TriggerSource)),
		TriggerReason:   input.TriggerReason,
		SourceSessionID: sourceSessionID,
		ModelPlanID:     plan.ID,
		Model:           model,
		ContextScope:    consultContextScope(input.ContextText),
		Prompt:          prompt,
		RequestText:     question,
		ContextText:     contextText,
		RetryOfRunID:    input.RetryOfRunID,
		Attempt:         input.Attempt,
		Status:          collabrunbiz.StatusRunning,
		StartedAt:       now,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	run, err = collabrunbiz.Normalize(run)
	if err != nil {
		return collabrunbiz.Run{}, fmt.Errorf("%w: %w", ErrInvalidRunInput, err)
	}
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.notify(ctx, run)

	consultCtx, cancel := context.WithCancel(ctx)
	s.registerCancel(run.ID, cancel)
	result, completeErr := s.Completer.Complete(consultCtx, modelplanservice.CompletionRequest{
		Protocol:  plan.Protocol,
		BaseURL:   plan.BaseURL,
		APIKey:    plan.APIKey,
		Model:     model,
		System:    consultSystemPrompt,
		Prompt:    prompt,
		MaxTokens: input.MaxTokens,
	})
	s.unregisterCancel(run.ID)
	cancel()

	settled := s.now()
	run.CompletedAt = settled
	run.UpdatedAt = settled
	run.DurationMs = result.LatencyMs
	if run.DurationMs == 0 {
		run.DurationMs = settled.Sub(run.StartedAt).Milliseconds()
	}
	if completeErr != nil {
		// A concurrent CancelConsult may already have settled the run as
		// canceled; that record wins over the induced completion failure.
		if stored, getErr := s.Store.GetCollaborationRun(ctx, workspaceID, run.ID); getErr == nil &&
			stored.Status == collabrunbiz.StatusCanceled {
			return stored, nil
		}
		run.Status = collabrunbiz.StatusFailed
		run.FailureReason = sanitizeFailureReason(completeErr)
		run.FailureStage = "provider_completion"
	} else {
		run.Status = collabrunbiz.StatusCompleted
		run.ResultText = result.Text
		run.Usage = collabrunbiz.Usage{
			InputTokens:      result.Usage.InputTokens,
			OutputTokens:     result.Usage.OutputTokens,
			CacheReadTokens:  result.Usage.CacheReadTokens,
			CacheWriteTokens: result.Usage.CacheWriteTokens,
		}
		run.FailureStage = ""
	}
	s.estimateRunCost(ctx, &run)
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.notify(ctx, run)
	return run, nil
}

type RecordRunInput struct {
	WorkspaceID string
	// Mode must be fork, delegate, or handoff; consults execute through
	// StartConsult instead.
	Mode                string
	SourceSessionID     string
	TargetSessionID     string
	TargetAgentTargetID string
	ModelPlanID         string
	Model               string
	ContextScope        string
	Prompt              string
	RequestText         string
	ContextText         string
	RetryOfRunID        string
	Attempt             int
	TriggerSource       string
	TriggerReason       string
}

// RecordRun stores one running fork, delegate, or handoff record. Callers
// create this record before launching the target session so even an immediate
// target completion cannot race ahead of durable collaboration tracking.
func (s *Service) RecordRun(ctx context.Context, input RecordRunInput) (collabrunbiz.Run, error) {
	mode := collabrunbiz.Mode(strings.TrimSpace(input.Mode))
	if mode == collabrunbiz.ModeConsult || !collabrunbiz.IsMode(string(mode)) {
		return collabrunbiz.Run{}, fmt.Errorf("%w: mode must be fork, delegate, or handoff", ErrInvalidRunInput)
	}
	if strings.TrimSpace(input.TargetSessionID) == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: target session id is required", ErrInvalidRunInput)
	}
	now := s.now()
	run := collabrunbiz.Run{
		ID:                  s.newID(),
		WorkspaceID:         input.WorkspaceID,
		Mode:                mode,
		TriggerSource:       collabrunbiz.TriggerSource(strings.TrimSpace(input.TriggerSource)),
		TriggerReason:       input.TriggerReason,
		SourceSessionID:     input.SourceSessionID,
		TargetSessionID:     input.TargetSessionID,
		TargetAgentTargetID: input.TargetAgentTargetID,
		ModelPlanID:         input.ModelPlanID,
		Model:               input.Model,
		ContextScope:        input.ContextScope,
		Prompt:              input.Prompt,
		RequestText:         input.RequestText,
		ContextText:         input.ContextText,
		RetryOfRunID:        input.RetryOfRunID,
		Attempt:             input.Attempt,
		Status:              collabrunbiz.StatusRunning,
		StartedAt:           now,
		CreatedAt:           now,
		UpdatedAt:           now,
	}
	run, err := collabrunbiz.Normalize(run)
	if err != nil {
		return collabrunbiz.Run{}, fmt.Errorf("%w: %w", ErrInvalidRunInput, err)
	}
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.notify(ctx, run)
	return run, nil
}

// SettleRunInput contains terminal facts learned from the target session.
// Empty optional identity fields preserve the values captured at launch.
type SettleRunInput struct {
	Status              string
	FailureReason       string
	FailureStage        string
	TargetAgentTargetID string
	ModelPlanID         string
	Model               string
	Usage               collabrunbiz.Usage
	StartedAt           time.Time
	CompletedAt         time.Time
}

// SettleRun records one terminal target-session result. It is idempotent:
// once a collaboration run settles, replayed or racing state patches return
// the stored terminal record unchanged.
func (s *Service) SettleRun(ctx context.Context, workspaceID string, runID string, input SettleRunInput) (collabrunbiz.Run, error) {
	status := collabrunbiz.Status(strings.TrimSpace(input.Status))
	if status != collabrunbiz.StatusCompleted && status != collabrunbiz.StatusFailed && status != collabrunbiz.StatusCanceled {
		return collabrunbiz.Run{}, fmt.Errorf("%w: terminal status is required", ErrInvalidRunInput)
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	run, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if run.Status != collabrunbiz.StatusRunning {
		return run, nil
	}
	completedAt := input.CompletedAt.UTC()
	if completedAt.IsZero() {
		completedAt = s.now()
	}
	if !input.StartedAt.IsZero() {
		run.StartedAt = input.StartedAt.UTC()
	}
	run.Status = status
	run.CompletedAt = completedAt
	run.UpdatedAt = completedAt
	run.DurationMs = completedAt.Sub(run.StartedAt).Milliseconds()
	if run.DurationMs < 0 {
		run.DurationMs = 0
	}
	if value := strings.TrimSpace(input.TargetAgentTargetID); value != "" {
		run.TargetAgentTargetID = value
	}
	if value := strings.TrimSpace(input.ModelPlanID); value != "" {
		run.ModelPlanID = value
	}
	if value := strings.TrimSpace(input.Model); value != "" {
		run.Model = value
	}
	run.Usage = input.Usage
	s.estimateRunCost(ctx, &run)
	if status == collabrunbiz.StatusCompleted {
		run.FailureReason = ""
		run.FailureStage = ""
	} else {
		run.FailureReason = shortFailureReason(input.FailureReason, string(status))
		run.FailureStage = strings.TrimSpace(input.FailureStage)
	}
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.notify(ctx, run)
	return run, nil
}

// ObserveAgentSessionState settles every running non-consult collaboration
// linked to a target session when its turn reaches a terminal outcome.
func (s *Service) ObserveAgentSessionState(ctx context.Context, input agentsessionstore.ReportSessionStateInput, _ agentsessionstore.ReportSessionStateReply) {
	status, outcome, startedAt, completedAt, ok := collaborationSettlement(input.State)
	if !ok {
		return
	}
	runs, err := s.Store.ListCollaborationRuns(ctx, strings.TrimSpace(input.WorkspaceID), "", 0)
	if err != nil {
		slog.Warn("list target collaboration runs failed",
			"event", "agent.collaboration.target_runs_list_failed",
			"workspace_id", strings.TrimSpace(input.WorkspaceID),
			"agent_session_id", strings.TrimSpace(input.AgentSessionID),
			"error", err,
		)
		return
	}
	usage := collaborationUsage(input.State.RuntimeContext)
	modelPlanID := collaborationModelPlanID(input.State.RuntimeContext)
	failureReason := strings.TrimSpace(input.State.LastError)
	if failureReason == "" && status != collabrunbiz.StatusCompleted {
		failureReason = outcome
	}
	for _, run := range runs {
		if run.Mode == collabrunbiz.ModeConsult || run.Status != collabrunbiz.StatusRunning || strings.TrimSpace(run.TargetSessionID) != strings.TrimSpace(input.AgentSessionID) {
			continue
		}
		if _, err := s.SettleRun(ctx, input.WorkspaceID, run.ID, SettleRunInput{
			Status:              string(status),
			FailureReason:       failureReason,
			FailureStage:        "target_execution",
			TargetAgentTargetID: firstNonEmpty(input.State.AgentTargetID, input.AgentTargetID),
			ModelPlanID:         modelPlanID,
			Model:               input.State.Model,
			Usage:               usage,
			StartedAt:           startedAt,
			CompletedAt:         completedAt,
		}); err != nil {
			slog.Warn("settle target collaboration run failed",
				"event", "agent.collaboration.target_run_settle_failed",
				"workspace_id", strings.TrimSpace(input.WorkspaceID),
				"agent_session_id", strings.TrimSpace(input.AgentSessionID),
				"collaboration_run_id", run.ID,
				"error", err,
			)
		}
	}
}

// SetAdoption records whether the run outcome was taken up. Fork and handoff
// runs are not adoptable, and a run can never become not_applicable again.
func (s *Service) SetAdoption(ctx context.Context, workspaceID string, runID string, adoption string) (collabrunbiz.Run, error) {
	next := collabrunbiz.Adoption(strings.TrimSpace(adoption))
	if !collabrunbiz.IsAdoption(string(next)) || next == collabrunbiz.AdoptionNotApplicable {
		return collabrunbiz.Run{}, fmt.Errorf("%w: adoption must be pending, adopted, or rejected", ErrInvalidAdoption)
	}
	run, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if run.Adoption == collabrunbiz.AdoptionNotApplicable {
		return collabrunbiz.Run{}, fmt.Errorf("%w: %s runs do not track adoption", ErrInvalidAdoption, run.Mode)
	}
	if run.Adoption == next {
		return run, nil
	}
	run.Adoption = next
	run.UpdatedAt = s.now()
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.notify(ctx, run)
	return run, nil
}

// CancelRun cancels a running consult completion or the active target-session
// turn for fork, delegate, and handoff. Settled runs are returned unchanged.
func (s *Service) CancelRun(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	run, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if run.Status != collabrunbiz.StatusRunning {
		return run, nil
	}
	if run.Mode == collabrunbiz.ModeConsult {
		return s.cancelConsult(ctx, run)
	}
	if s.Canceller == nil {
		return collabrunbiz.Run{}, fmt.Errorf("%w: target session cancellation is unavailable", ErrInvalidRunInput)
	}
	if err := s.Canceller.CancelTargetSession(ctx, run.WorkspaceID, run.TargetSessionID); err != nil {
		return collabrunbiz.Run{}, err
	}
	return s.SettleRun(ctx, run.WorkspaceID, run.ID, SettleRunInput{
		Status:        string(collabrunbiz.StatusCanceled),
		FailureReason: "canceled",
	})
}

// CancelConsult is retained as a compatibility wrapper for service callers.
func (s *Service) CancelConsult(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	run, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if run.Mode != collabrunbiz.ModeConsult {
		return collabrunbiz.Run{}, fmt.Errorf("%w: only consult runs can be canceled", ErrInvalidRunInput)
	}
	return s.cancelConsult(ctx, run)
}

func (s *Service) cancelConsult(ctx context.Context, run collabrunbiz.Run) (collabrunbiz.Run, error) {
	if run.Status != collabrunbiz.StatusRunning {
		return run, nil
	}
	now := s.now()
	run.Status = collabrunbiz.StatusCanceled
	run.FailureReason = "canceled"
	run.CompletedAt = now
	run.UpdatedAt = now
	run.DurationMs = now.Sub(run.StartedAt).Milliseconds()
	if err := s.Store.PutCollaborationRun(ctx, run); err != nil {
		return collabrunbiz.Run{}, err
	}
	s.cancelInFlight(run.ID)
	s.notify(ctx, run)
	return run, nil
}

func (s *Service) ListRuns(ctx context.Context, workspaceID string, sourceSessionID string, limit int) ([]collabrunbiz.Run, error) {
	runs, err := s.Store.ListCollaborationRuns(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(sourceSessionID), limit)
	if err != nil {
		return nil, err
	}
	if runs == nil {
		runs = []collabrunbiz.Run{}
	}
	return runs, nil
}

func (s *Service) checkConsultLimit(ctx context.Context, workspaceID string, sourceSessionID string) error {
	limit := s.MaxConsultRunsPerSourceSession
	if limit <= 0 {
		limit = DefaultMaxConsultRunsPerSourceSession
	}
	runs, err := s.Store.ListCollaborationRuns(ctx, workspaceID, sourceSessionID, 0)
	if err != nil {
		return err
	}
	consults := 0
	for _, run := range runs {
		if run.Mode == collabrunbiz.ModeConsult {
			consults++
		}
	}
	if consults >= limit {
		return fmt.Errorf("%w: %d runs", ErrConsultLimitReached, consults)
	}
	return nil
}

func (s *Service) registerCancel(runID string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancels == nil {
		s.cancels = map[string]context.CancelFunc{}
	}
	s.cancels[runID] = cancel
}

func (s *Service) unregisterCancel(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cancels, runID)
}

func (s *Service) cancelInFlight(runID string) {
	s.mu.Lock()
	cancel := s.cancels[runID]
	delete(s.cancels, runID)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) notify(ctx context.Context, run collabrunbiz.Run) {
	if s.Publisher != nil {
		s.Publisher.PublishCollaborationRunUpdated(run.WorkspaceID, run)
	}
	if s.Timeline != nil {
		s.Timeline.ReportCollaborationTimeline(ctx, run)
	}
	if s.TerminalObserver != nil && isTerminalStatus(run.Status) {
		if err := s.TerminalObserver.RecordCollaborationRun(ctx, run); err != nil {
			slog.Warn("record terminal collaboration run failed",
				"event", "agent_collaboration.terminal_observer_failed",
				"workspace_id", run.WorkspaceID,
				"collaboration_run_id", run.ID,
				"error", err,
			)
		}
	}
}

func isTerminalStatus(status collabrunbiz.Status) bool {
	return status == collabrunbiz.StatusCompleted ||
		status == collabrunbiz.StatusFailed ||
		status == collabrunbiz.StatusCanceled
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return s.NewID()
	}
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return "cr-" + base64.RawURLEncoding.EncodeToString(buf)
}

// consultContextScope derives the recorded context scope for a consult: the
// caller either sends no context or a prepared text bundle.
func consultContextScope(contextText string) string {
	if strings.TrimSpace(contextText) == "" {
		return "none"
	}
	return "full"
}

// sanitizeFailureReason turns a completion error into a short machine-safe
// failure reason. Credentials travel only in request headers, so provider and
// transport messages never contain them; the message is still truncated.
func sanitizeFailureReason(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var httpErr *modelplanservice.CompletionHTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return "unauthorized"
		case http.StatusNotFound, http.StatusBadRequest:
			return "model_rejected"
		default:
			return fmt.Sprintf("completion_http_%d", httpErr.StatusCode)
		}
	}
	message := err.Error()
	if len(message) > 300 {
		message = message[:300]
	}
	return message
}

func shortFailureReason(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = strings.TrimSpace(fallback)
	}
	if len(value) > 300 {
		value = value[:300]
	}
	return value
}

func collaborationSettlement(state agentsessionstore.WorkspaceAgentSessionStateUpdate) (collabrunbiz.Status, string, time.Time, time.Time, bool) {
	outcome := ""
	var startedAtUnixMS int64
	var completedAtUnixMS int64
	if lifecycle := state.TurnLifecycle; lifecycle != nil && strings.TrimSpace(lifecycle.Phase) == "settled" && lifecycle.Outcome != nil {
		outcome = strings.TrimSpace(*lifecycle.Outcome)
	}
	if turn := state.Turn; turn != nil && strings.TrimSpace(turn.Phase) == "settled" {
		if value := strings.TrimSpace(turn.Outcome); value != "" {
			outcome = value
		}
		startedAtUnixMS = turn.StartedAtUnixMS
		completedAtUnixMS = turn.CompletedAtUnixMS
	}
	if outcome == "" {
		return "", "", time.Time{}, time.Time{}, false
	}
	status := collabrunbiz.StatusFailed
	switch outcome {
	case "completed":
		status = collabrunbiz.StatusCompleted
	case "canceled":
		status = collabrunbiz.StatusCanceled
	}
	var startedAt time.Time
	if startedAtUnixMS > 0 {
		startedAt = time.UnixMilli(startedAtUnixMS).UTC()
	}
	var completedAt time.Time
	if completedAtUnixMS > 0 {
		completedAt = time.UnixMilli(completedAtUnixMS).UTC()
	}
	return status, outcome, startedAt, completedAt, true
}

func collaborationModelPlanID(runtimeContext map[string]any) string {
	snapshot, _ := runtimeContext["sessionRuntimeSnapshot"].(map[string]any)
	configuration, _ := snapshot["modelConfiguration"].(map[string]any)
	value, _ := configuration["modelPlanId"].(string)
	return strings.TrimSpace(value)
}

func collaborationUsage(runtimeContext map[string]any) collabrunbiz.Usage {
	usage, _ := runtimeContext["usage"].(map[string]any)
	if len(usage) == 0 {
		return collabrunbiz.Usage{}
	}
	inputTokens := collaborationInt64(usage, "inputTokens", "input_tokens")
	outputTokens := collaborationInt64(usage, "outputTokens", "output_tokens")
	cacheReadTokens := collaborationInt64(usage, "cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens")
	cacheWriteTokens := collaborationInt64(usage, "cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens")
	if inputTokens == 0 && outputTokens == 0 && cacheReadTokens == 0 && cacheWriteTokens == 0 {
		if last, ok := usage["last"].(map[string]any); ok {
			inputTokens = collaborationInt64(last, "inputTokens", "input_tokens")
			outputTokens = collaborationInt64(last, "outputTokens", "output_tokens")
			cacheReadTokens = collaborationInt64(last, "cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens")
			cacheWriteTokens = collaborationInt64(last, "cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens")
		}
	}
	return collabrunbiz.Usage{
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		CacheReadTokens:  cacheReadTokens,
		CacheWriteTokens: cacheWriteTokens,
	}
}

func collaborationInt64(payload map[string]any, keys ...string) int64 {
	for _, key := range keys {
		switch value := payload[key].(type) {
		case int:
			return int64(value)
		case int32:
			return int64(value)
		case int64:
			return value
		case uint:
			return int64(value)
		case uint32:
			return int64(value)
		case uint64:
			if value <= uint64(^uint64(0)>>1) {
				return int64(value)
			}
		case float64:
			return int64(value)
		case json.Number:
			if parsed, err := value.Int64(); err == nil {
				return parsed
			}
		}
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
