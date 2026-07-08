package agent

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

const maxSessionTitleRunes = 120

func (s *Service) UpdateTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	title = strings.TrimSpace(title)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, ErrInvalidArgument
	}
	if title == "" {
		return Session{}, fmt.Errorf("%w: title is required", ErrInvalidArgument)
	}
	if utf8.RuneCountInString(title) > maxSessionTitleRunes {
		return Session{}, fmt.Errorf("%w: title must be at most %d characters", ErrInvalidArgument, maxSessionTitleRunes)
	}
	updater, ok := s.SessionReader.(SessionTitleUpdater)
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	persisted, updated, err := updater.UpdateSessionTitle(ctx, workspaceID, agentSessionID, title)
	if err != nil {
		return Session{}, err
	}
	if !updated {
		return Session{}, ErrSessionNotFound
	}
	if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		runtime, err := s.controller().SetTitle(ctx, RuntimeSetTitleInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			Title:          persisted.Title,
		})
		if err != nil {
			return Session{}, err
		}
		service := serviceSession(
			runtime,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(runtime)),
		)
		merged := mergePersistedSessionState(service, persisted)
		merged.Title = stringPointer(persisted.Title)
		merged.UpdatedAt = timeFromUnixMSPointer(persisted.UpdatedAtUnixMS)
		return merged, nil
	}
	return sessionFromPersisted(
		persisted,
		persistedSessionCanResume(s.controller(), persisted),
	), nil
}
