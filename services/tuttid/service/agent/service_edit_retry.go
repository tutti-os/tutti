package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type EditRetryInput = agenthost.EditRetryInput
type EditRetryResult = agenthost.EditRetryResult
type EditRetryRecoveryAction = agenthost.EditRetryRecoveryAction
type RecoverEditRetryInput = agenthost.RecoverEditRetryInput

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

// RecoverEditRetryCommand delegates one explicit CAS-bound recovery command
// to Host. The adapter deliberately does not infer lifecycle state.
func (s *Service) RecoverEditRetryCommand(ctx context.Context, workspaceID, agentSessionID, operationID string, input RecoverEditRetryInput) (EditRetryResult, error) {
	return s.ApplicationHost().RecoverEditRetryCommand(ctx, agenthost.SessionRef{WorkspaceID: strings.TrimSpace(workspaceID), AgentSessionID: strings.TrimSpace(agentSessionID)}, strings.TrimSpace(operationID), input)
}
