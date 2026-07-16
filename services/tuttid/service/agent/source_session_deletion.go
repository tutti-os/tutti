package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// SourceSessionDeletionCoordinator is the Tutti-owned use-case boundary for
// atomically deleting agent sessions together with activation and workflow
// lifecycle state. Production wiring must prefer this coordinator over the
// persistence-only fallbacks.
type SourceSessionDeletionCoordinator interface {
	DeleteSourceSession(context.Context, string, string) (agentactivitybiz.DeleteSessionsBatchResult, error)
	DeleteSourceSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error)
	ClearSourceSessions(context.Context, string) (agentactivitybiz.ClearSessionsResult, error)
}

type SessionDeletionEventPublisher interface {
	PublishSessionDeleted(context.Context, string, string)
}

func (s *Service) Delete(ctx context.Context, workspaceID string, agentSessionID string) (DeleteSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return DeleteSessionResult{}, ErrInvalidArgument
	}
	runtimeClosed := false
	if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		if err := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
		}); err != nil {
			return DeleteSessionResult{}, normalizeRuntimeError(err)
		}
		runtimeClosed = true
	}
	if s.SourceSessionDeletions != nil {
		result, err := s.SourceSessionDeletions.DeleteSourceSession(ctx, workspaceID, agentSessionID)
		if err != nil {
			return DeleteSessionResult{}, err
		}
		s.publishSessionDeletedEvents(ctx, workspaceID, result.RemovedSessionIDs)
		removed := result.RemovedSessions > 0
		if !removed && !runtimeClosed {
			return DeleteSessionResult{}, ErrSessionNotFound
		}
		if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionResult{}, err
		}
		s.releaseAgentResources(ctx, agentSessionID)
		return DeleteSessionResult{Removed: removed || runtimeClosed}, nil
	}
	if s.ApplicationHost() != nil {
		result, err := s.ApplicationHost().DeleteSession(ctx, agenthost.SessionRef{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		})
		return DeleteSessionResult{Removed: result.Deleted, CleanupFailed: result.CleanupFailed}, err
	}
	deleter, ok := s.SessionReader.(SessionDeleter)
	if !ok {
		if runtimeClosed {
			if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
				return DeleteSessionResult{}, err
			}
			if err := s.deleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID); err != nil {
				return DeleteSessionResult{}, err
			}
			return DeleteSessionResult{Removed: true}, nil
		}
		if err := s.deleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionResult{}, err
		}
		return DeleteSessionResult{}, ErrSessionNotFound
	}
	removed, err := deleter.DeleteSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return DeleteSessionResult{}, err
	}
	if !removed {
		if err := s.deleteTuttiModeActivationSessionState(ctx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionResult{}, err
		}
		if !runtimeClosed {
			return DeleteSessionResult{}, ErrSessionNotFound
		}
	}
	if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
		return DeleteSessionResult{}, err
	}
	s.releaseAgentResources(ctx, agentSessionID)
	return DeleteSessionResult{Removed: removed || runtimeClosed}, nil
}

func (s *Service) Clear(ctx context.Context, workspaceID string) (ClearSessionsResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, ErrInvalidArgument
	}
	for _, session := range s.controller().Sessions(workspaceID) {
		if err := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		}); err != nil {
			return ClearSessionsResult{}, normalizeRuntimeError(err)
		}
		if err := s.cleanupRuntime(ctx, workspaceID, session.ID); err != nil {
			return ClearSessionsResult{}, err
		}
	}
	if s.SourceSessionDeletions != nil {
		result, err := s.SourceSessionDeletions.ClearSourceSessions(ctx, workspaceID)
		if err != nil {
			return ClearSessionsResult{}, err
		}
		s.publishSessionDeletedEvents(ctx, workspaceID, result.RemovedSessionIDs)
		for _, removedSessionID := range result.RemovedSessionIDs {
			s.releaseAgentResources(ctx, removedSessionID)
		}
		return ClearSessionsResult{
			RemovedMessages:   result.RemovedMessages,
			RemovedSessions:   result.RemovedSessions,
			RemovedSessionIDs: result.RemovedSessionIDs,
		}, nil
	}
	if s.ApplicationHost() != nil {
		result, err := s.ApplicationHost().ClearSessions(ctx, workspaceID)
		if err != nil {
			return ClearSessionsResult{}, err
		}
		return ClearSessionsResult{
			RemovedMessages:         result.RemovedMessages,
			RemovedSessions:         result.RemovedSessions,
			RemovedSessionIDs:       result.RemovedSessionIDs,
			CleanupFailedSessionIDs: result.CleanupFailedIDs,
		}, nil
	}
	clearer, ok := s.SessionReader.(SessionClearer)
	if !ok {
		return ClearSessionsResult{}, ErrSessionNotFound
	}
	result, err := clearer.ClearSessions(ctx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	for _, removedSessionID := range result.RemovedSessionIDs {
		s.releaseAgentResources(ctx, removedSessionID)
	}
	return result, nil
}

func (s *Service) publishSessionDeletedEvents(ctx context.Context, workspaceID string, sessionIDs []string) {
	if s == nil || s.SessionDeletionEvents == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	seen := make(map[string]struct{}, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if workspaceID == "" || sessionID == "" {
			continue
		}
		if _, exists := seen[sessionID]; exists {
			continue
		}
		seen[sessionID] = struct{}{}
		s.SessionDeletionEvents.PublishSessionDeleted(ctx, workspaceID, sessionID)
	}
}
