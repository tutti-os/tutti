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
	return s.projectSessionForResponse(
		ctx,
		workspaceID,
		serviceSessionWithComposerSkillOptions(
			session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
			s.discoverComposerSkillOptions(session.Provider, session.Cwd, session.Env),
		),
	)
}
