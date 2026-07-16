package collabrun

import (
	"context"
	"fmt"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

// RetryRun replays the durable inputs of one failed run as a new immutable
// attempt. It never mutates or hides the failed record.
func (s *Service) RetryRun(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	previous, err := s.Store.GetCollaborationRun(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(runID))
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if previous.Status != collabrunbiz.StatusFailed {
		return collabrunbiz.Run{}, fmt.Errorf("%w: only failed runs can be retried", ErrRunNotRetryable)
	}
	requestText := strings.TrimSpace(previous.RequestText)
	if requestText == "" {
		requestText = strings.TrimSpace(previous.Prompt)
	}
	if requestText == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: original request is unavailable", ErrRunNotRetryable)
	}
	attempt := previous.Attempt + 1
	if attempt < 2 {
		attempt = 2
	}
	if previous.Mode == collabrunbiz.ModeConsult {
		return s.StartConsult(ctx, StartConsultInput{
			WorkspaceID:     previous.WorkspaceID,
			SourceSessionID: previous.SourceSessionID,
			ModelPlanID:     previous.ModelPlanID,
			Model:           previous.Model,
			Question:        requestText,
			ContextText:     previous.ContextText,
			TriggerSource:   string(previous.TriggerSource),
			TriggerReason:   "retry:" + previous.ID,
			RetryOfRunID:    previous.ID,
			Attempt:         attempt,
		})
	}
	return s.StartAgentRun(ctx, StartAgentRunInput{
		WorkspaceID:         previous.WorkspaceID,
		Mode:                string(previous.Mode),
		SourceSessionID:     previous.SourceSessionID,
		TargetAgentTargetID: previous.TargetAgentTargetID,
		ModelPlanID:         previous.ModelPlanID,
		Model:               previous.Model,
		Question:            requestText,
		ContextText:         previous.ContextText,
		ContextScope:        retryContextScope(previous.ContextScope),
		TriggerSource:       string(previous.TriggerSource),
		TriggerReason:       "retry:" + previous.ID,
		RetryOfRunID:        previous.ID,
		Attempt:             attempt,
	})
}

func retryContextScope(value string) string {
	switch strings.TrimSpace(value) {
	case "none", "recent", "full":
		return strings.TrimSpace(value)
	default:
		// Older automation rows store a descriptive bounded_transcript scope.
		// Their exact bounded snapshot is already in ContextText, so replay it
		// without pulling a second copy of the live source transcript.
		return "none"
	}
}
