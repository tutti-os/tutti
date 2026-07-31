package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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

func (s *Service) AdoptProviderGoal(ctx context.Context, input agenthost.ProviderGoalAdoptionInput) (agenthost.ProviderGoalAdoptionResult, error) {
	result, err := s.ApplicationHost().AdoptProviderGoal(ctx, input)
	if err != nil {
		return agenthost.ProviderGoalAdoptionResult{}, normalizeRuntimeError(err)
	}
	return result, nil
}

func (s *Service) GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string, clientSubmitID string) (GoalControlSessionResult, error) {
	return s.goalControl(ctx, workspaceID, agentSessionID, action, objective, clientSubmitID, nil)
}

func (s *Service) goalControl(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	action string,
	objective string,
	clientSubmitID string,
	submissionMetadata map[string]any,
) (GoalControlSessionResult, error) {
	result, err := s.ApplicationHost().GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID),
		Action: strings.TrimSpace(action), Objective: strings.TrimSpace(objective),
		ClientSubmitID:     strings.TrimSpace(clientSubmitID),
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
