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
	Session        Session
	Goal           map[string]any
	IntentAccepted bool
	OperationID    string
	GoalState      *agentactivitybiz.SessionGoalState
}

type GoalControlInput struct {
	WorkspaceID        string
	AgentSessionID     string
	Action             string
	Objective          string
	ClientSubmitID     string
	SubmissionMetadata map[string]any
}

func (s *Service) AdoptProviderGoal(ctx context.Context, input agenthost.ProviderGoalAdoptionInput) (agenthost.ProviderGoalAdoptionResult, error) {
	result, err := s.ApplicationHost().AdoptProviderGoal(ctx, input)
	if err != nil {
		return agenthost.ProviderGoalAdoptionResult{}, normalizeRuntimeError(err)
	}
	return result, nil
}

func (s *Service) GoalControl(ctx context.Context, input GoalControlInput) (GoalControlSessionResult, error) {
	result, err := s.ApplicationHost().GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID:        strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:     strings.TrimSpace(input.AgentSessionID),
		Action:             strings.TrimSpace(input.Action),
		Objective:          strings.TrimSpace(input.Objective),
		ClientSubmitID:     strings.TrimSpace(input.ClientSubmitID),
		SubmissionMetadata: clonePayload(input.SubmissionMetadata),
	})
	serviceResult := GoalControlSessionResult{
		Goal: clonePayload(result.Goal), IntentAccepted: result.IntentAccepted,
		OperationID: result.OperationID, GoalState: result.GoalState,
	}
	if err != nil {
		return serviceResult, normalizeRuntimeError(err)
	}
	session, err := s.Get(ctx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return serviceResult, err
	}
	serviceResult.Session = session
	return serviceResult, nil
}
