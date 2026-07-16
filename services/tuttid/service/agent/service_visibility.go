package agent

import (
	"context"
	"strings"
)

func (s *Service) UpdateVisible(ctx context.Context, workspaceID string, agentSessionID string, visible bool) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, ErrInvalidArgument
	}
	session, err := s.controller().SetVisible(ctx, RuntimeSetVisibleInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Visible:        visible,
	})
	if err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	persisted, err := s.initializeRuntimeSession(ctx, session)
	if err != nil {
		return Session{}, err
	}
	return s.projectSessionForResponse(ctx, workspaceID, serviceSessionWithPersistedFreshness(
		session,
		persisted,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
	))
}
