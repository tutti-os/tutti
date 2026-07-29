package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type GoalStateSessionResult struct {
	Session Session
	State   agentactivitybiz.SessionGoalState
}

func (s *Service) GetGoalState(ctx context.Context, workspaceID, agentSessionID string) (GoalStateSessionResult, error) {
	result, err := s.ApplicationHost().GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID),
	})
	if err != nil {
		return GoalStateSessionResult{}, err
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	return GoalStateSessionResult{Session: session, State: result.State}, err
}

func (s *Service) ReconcileGoal(ctx context.Context, workspaceID, agentSessionID string) (GoalStateSessionResult, error) {
	result, err := s.ApplicationHost().ReconcileGoal(ctx, agenthost.SessionRef{
		WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID),
	})
	if err != nil {
		return GoalStateSessionResult{}, err
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	return GoalStateSessionResult{Session: session, State: result.State}, err
}
