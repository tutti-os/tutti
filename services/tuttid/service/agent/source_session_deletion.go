package agent

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func (s *Service) Delete(ctx context.Context, workspaceID string, agentSessionID string) (DeleteSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return DeleteSessionResult{}, ErrInvalidArgument
	}
	// Host owns live close + canonical removal; do not pre-close or the
	// live-only delete-before-report conformance path cannot observe the
	// session.
	result, err := s.ApplicationHost().DeleteSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	if err != nil {
		if errors.Is(err, agenthost.ErrSessionNotFound) || errors.Is(err, ErrSessionNotFound) {
			if tuttiErr := s.deleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID); tuttiErr != nil {
				return DeleteSessionResult{}, tuttiErr
			}
			s.forgetProviderRuntimeSessionCredentials(workspaceID, agentSessionID)
		}
		return DeleteSessionResult{}, err
	}
	s.forgetProviderRuntimeSessionCredentials(workspaceID, agentSessionID)
	return DeleteSessionResult{Removed: result.Deleted, CleanupFailed: result.CleanupFailed}, nil
}

func (s *Service) Clear(ctx context.Context, workspaceID string) (ClearSessionsResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, ErrInvalidArgument
	}
	result, err := s.ApplicationHost().ClearSessions(ctx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	s.forgetProviderRuntimeSessionCredentials(workspaceID, result.RemovedSessionIDs...)
	return ClearSessionsResult{
		RemovedMessages:         result.RemovedMessages,
		RemovedSessions:         result.RemovedSessions,
		RemovedSessionIDs:       result.RemovedSessionIDs,
		CleanupFailedSessionIDs: result.CleanupFailedIDs,
	}, nil
}
