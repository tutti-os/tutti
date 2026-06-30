package agent

import (
	"context"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) reconcilePersistedStaleTurn(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if s.SessionReader == nil {
		return false, nil
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok {
		return false, nil
	}
	return s.reconcileStaleTurnOnResume(ctx, persisted)
}

func (s *Service) reconcileStaleTurnOnResume(ctx context.Context, session PersistedSession) (bool, error) {
	shouldReconcile, err := s.shouldReconcileStaleTurn(session)
	if err != nil {
		return false, err
	}
	if !shouldReconcile {
		return false, nil
	}
	reconciler, ok := s.SessionReader.(StaleTurnResumeReconciler)
	if !ok || reconciler == nil {
		return false, nil
	}
	if err := reconciler.ReconcileStaleTurnOnResume(ctx, session); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) shouldReconcileStaleTurn(session PersistedSession) (bool, error) {
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported {
		return false, nil
	}
	if isResumeStaleTurnStatus(session.Status) || isResumeStaleTurnStatus(session.CurrentPhase) {
		return true, nil
	}
	if s == nil || s.MessageReader == nil {
		return false, nil
	}
	page, ok := s.MessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    strings.TrimSpace(session.WorkspaceID),
		AgentSessionID: strings.TrimSpace(session.ID),
		Limit:          100,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok {
		return false, nil
	}
	return hasStaleResumeOpenToolCall(page.Messages), nil
}

func hasStaleResumeOpenToolCall(messages []SessionMessage) bool {
	for _, message := range messages {
		if isStaleResumeOpenToolCall(message) {
			return true
		}
	}
	return false
}

func isResumeStaleTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "running", "streaming", "submitted", "working", "waiting":
		return true
	default:
		return false
	}
}

func isRuntimeActiveTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "working", "waiting":
		return true
	default:
		return false
	}
}

func (s *Service) prepareRuntimeForResume(ctx context.Context, session PersistedSession) (preparedRuntime, error) {
	input := createSessionInputFromPersisted(session)
	return s.prepareRuntime(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input)
}
