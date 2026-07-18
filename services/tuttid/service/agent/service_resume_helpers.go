package agent

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func (s *Service) ensureRuntimeSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ProviderRuntimeSession, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	return ensured.Session, err
}

type ensuredRuntimeSession struct {
	Session ProviderRuntimeSession
}

func (s *Service) ensureRuntimeSessionResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ensuredRuntimeSession, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID); ok && isStaleHiddenLiveModelDiscoverySession(persisted) {
			if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
				return ensuredRuntimeSession{}, err
			}
			return ensuredRuntimeSession{}, ErrSessionNotFound
		}
	}
	session, err := s.ApplicationHost().EnsureRuntimeSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	return ensuredRuntimeSession{Session: session}, err
}
