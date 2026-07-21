// Package collabrun orchestrates collaboration runs: daemon-side model
// consults executed against a workspace model access plan, plus recorded
// fork, delegate, and handoff runs linked to sessions the GUI creates through
// the existing session-create path.
package collabrun

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

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

type Service struct {
	Store     workspacedata.CollaborationRunsStore
	Plans     workspacedata.ModelPlansStore
	Completer Completer
	Publisher Publisher
	Timeline  Timeline
	// MaxConsultRunsPerSourceSession defaults to
	// DefaultMaxConsultRunsPerSourceSession when zero.
	MaxConsultRunsPerSourceSession int
	Now                            func() time.Time
	NewID                          func() string

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
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

	prompt := question
	if contextText := strings.TrimSpace(input.ContextText); contextText != "" {
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
	} else {
		run.Status = collabrunbiz.StatusCompleted
		run.ResultText = result.Text
		run.Usage = collabrunbiz.Usage{
			InputTokens:  result.Usage.InputTokens,
			OutputTokens: result.Usage.OutputTokens,
		}
	}
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
	TriggerSource       string
	TriggerReason       string
}

// RecordRun stores one completed fork, delegate, or handoff record. The
// launch already happened through the session-create path, so the run settles
// immediately with zero duration.
func (s *Service) RecordRun(ctx context.Context, input RecordRunInput) (collabrunbiz.Run, error) {
	mode := collabrunbiz.Mode(strings.TrimSpace(input.Mode))
	if mode == collabrunbiz.ModeConsult || !collabrunbiz.IsMode(string(mode)) {
		return collabrunbiz.Run{}, fmt.Errorf("%w: mode must be fork, delegate, or handoff", ErrInvalidRunInput)
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
		Status:              collabrunbiz.StatusCompleted,
		StartedAt:           now,
		CompletedAt:         now,
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

// CancelConsult marks a still-running consult canceled and cancels its
// in-flight completion call. Settled runs are returned unchanged.
func (s *Service) CancelConsult(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	run, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if run.Mode != collabrunbiz.ModeConsult {
		return collabrunbiz.Run{}, fmt.Errorf("%w: only consult runs can be canceled", ErrInvalidRunInput)
	}
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
