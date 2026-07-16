package collabrun

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

type StartAgentRunInput struct {
	WorkspaceID         string
	Mode                string
	SourceSessionID     string
	TargetAgentTargetID string
	ModelPlanID         string
	Model               string
	Question            string
	ContextText         string
	ContextScope        string
	TriggerSource       string
	TriggerReason       string
	RetryOfRunID        string
	Attempt             int
}

type TargetSessionLaunchInput struct {
	RunID               string
	WorkspaceID         string
	Mode                string
	SourceSessionID     string
	TargetSessionID     string
	TargetAgentTargetID string
	ModelPlanID         string
	Model               string
	Question            string
	ContextText         string
	ContextScope        string
}

// StartAgentRun atomically orders the durable collaboration intent before the
// target-session side effect. Launch failure settles the same visible run as
// failed instead of leaving an invisible or falsely completed collaboration.
func (s *Service) StartAgentRun(ctx context.Context, input StartAgentRunInput) (collabrunbiz.Run, error) {
	mode := collabrunbiz.Mode(strings.TrimSpace(input.Mode))
	if mode == collabrunbiz.ModeConsult || !collabrunbiz.IsMode(string(mode)) {
		return collabrunbiz.Run{}, fmt.Errorf("%w: mode must be fork, delegate, or handoff", ErrInvalidRunInput)
	}
	if strings.TrimSpace(input.SourceSessionID) == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: source session id is required", ErrInvalidRunInput)
	}
	if strings.TrimSpace(input.TargetAgentTargetID) == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: target agent id is required", ErrInvalidRunInput)
	}
	if strings.TrimSpace(input.Question) == "" {
		return collabrunbiz.Run{}, fmt.Errorf("%w: target work request is required", ErrInvalidRunInput)
	}
	contextScope, err := normalizeAgentContextScope(input.ContextScope)
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	if s.Launcher == nil {
		return collabrunbiz.Run{}, fmt.Errorf("%w: target session launcher is unavailable", ErrInvalidRunInput)
	}
	targetSessionID := newTargetSessionID()
	run, err := s.RecordRun(ctx, RecordRunInput{
		WorkspaceID:         input.WorkspaceID,
		Mode:                string(mode),
		SourceSessionID:     input.SourceSessionID,
		TargetSessionID:     targetSessionID,
		TargetAgentTargetID: input.TargetAgentTargetID,
		ModelPlanID:         input.ModelPlanID,
		Model:               input.Model,
		ContextScope:        contextScope,
		Prompt:              strings.TrimSpace(input.Question),
		RequestText:         strings.TrimSpace(input.Question),
		ContextText:         strings.TrimSpace(input.ContextText),
		RetryOfRunID:        input.RetryOfRunID,
		Attempt:             input.Attempt,
		TriggerSource:       input.TriggerSource,
		TriggerReason:       input.TriggerReason,
	})
	if err != nil {
		return collabrunbiz.Run{}, err
	}
	err = s.Launcher.LaunchCollaborationTarget(ctx, TargetSessionLaunchInput{
		RunID:               run.ID,
		WorkspaceID:         run.WorkspaceID,
		Mode:                string(run.Mode),
		SourceSessionID:     run.SourceSessionID,
		TargetSessionID:     run.TargetSessionID,
		TargetAgentTargetID: run.TargetAgentTargetID,
		ModelPlanID:         run.ModelPlanID,
		Model:               run.Model,
		Question:            strings.TrimSpace(input.Question),
		ContextText:         strings.TrimSpace(input.ContextText),
		ContextScope:        run.ContextScope,
	})
	if err == nil {
		return run, nil
	}
	failed, settleErr := s.SettleRun(ctx, run.WorkspaceID, run.ID, SettleRunInput{
		Status:        string(collabrunbiz.StatusFailed),
		FailureReason: err.Error(),
		FailureStage:  "target_launch",
	})
	if settleErr != nil {
		return collabrunbiz.Run{}, settleErr
	}
	return failed, nil
}

func newTargetSessionID() string {
	buf := make([]byte, 18)
	_, _ = rand.Read(buf)
	return "collab-session-" + base64.RawURLEncoding.EncodeToString(buf)
}

func normalizeAgentContextScope(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "recent", nil
	}
	switch value {
	case "none", "recent", "full":
		return value, nil
	default:
		return "", fmt.Errorf("%w: context scope must be none, recent, or full", ErrInvalidRunInput)
	}
}
