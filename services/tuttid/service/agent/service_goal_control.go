package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type GoalStateStore = agenthost.GoalStateStore

// GoalControlSessionResult preserves the daemon-facing session projection
// while Host owns the durable goal saga.
type GoalControlSessionResult struct {
	Session     Session
	Goal        map[string]any
	OperationID string
	GoalState   *agentactivitybiz.SessionGoalState
}

func (s *Service) GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string) (GoalControlSessionResult, error) {
	return s.goalControl(ctx, workspaceID, agentSessionID, action, objective, nil)
}

func (s *Service) goalControl(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	action string,
	objective string,
	submissionMetadata map[string]any,
) (GoalControlSessionResult, error) {
	result, err := s.ApplicationHost().GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID),
		Action: strings.TrimSpace(action), Objective: strings.TrimSpace(objective),
		SubmissionMetadata: clonePayload(submissionMetadata),
	})
	if err != nil {
		return GoalControlSessionResult{}, normalizeRuntimeError(err)
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalControlSessionResult{}, err
	}
	return GoalControlSessionResult{
		Session: session, Goal: clonePayload(result.Goal), OperationID: result.OperationID, GoalState: result.GoalState,
	}, nil
}
