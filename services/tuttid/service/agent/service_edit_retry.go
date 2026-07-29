package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type EditRetryInput = agenthost.EditRetryInput
type EditRetryResult = agenthost.EditRetryResult
type EditRetryRecoveryAction = agenthost.EditRetryRecoveryAction

// GetEditRetryAvailability is an adapter-only projection of Host-owned
// eligibility and recovery state.
func (s *Service) GetEditRetryAvailability(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (agenthost.EditRetryAvailability, error) {
	return s.ApplicationHost().GetEditRetryAvailability(ctx, agenthost.SessionRef{
		WorkspaceID:    strings.TrimSpace(workspaceID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
	})
}

// EditRetry delegates the complete lifecycle operation to Host. The service
// does not sequence rollback, provider reads, or replacement submission.
func (s *Service) EditRetry(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	input EditRetryInput,
) (EditRetryResult, error) {
	return s.ApplicationHost().EditRetry(
		ctx,
		agenthost.SessionRef{
			WorkspaceID:    strings.TrimSpace(workspaceID),
			AgentSessionID: strings.TrimSpace(agentSessionID),
		},
		strings.TrimSpace(turnID),
		input,
	)
}

// RecoverEditRetry delegates one explicit typed recovery command to Host.
func (s *Service) RecoverEditRetry(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	operationID string,
	action EditRetryRecoveryAction,
) (EditRetryResult, error) {
	return s.ApplicationHost().RecoverEditRetry(
		ctx,
		agenthost.SessionRef{
			WorkspaceID:    strings.TrimSpace(workspaceID),
			AgentSessionID: strings.TrimSpace(agentSessionID),
		},
		strings.TrimSpace(operationID),
		action,
	)
}
