package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

const MaxSessionTitleRunes = titletext.MaxSessionTitleRunes

var ErrSessionTitleTooLong = fmt.Errorf(
	"%w: title must be at most %d characters",
	ErrInvalidArgument,
	MaxSessionTitleRunes,
)

func (s *Service) UpdateTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	title = strings.TrimSpace(title)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, ErrInvalidArgument
	}
	// The Host accepts an empty canonical title so adapters such as tsh can
	// intentionally clear placeholders. The legacy tuttid API keeps its existing
	// request validation until its transport contract explicitly opts in.
	if title == "" {
		return Session{}, fmt.Errorf("%w: title is required", ErrInvalidArgument)
	}
	result, err := s.ApplicationHost().UpdateTitle(ctx, agenthost.UpdateTitleInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Title: title,
	})
	if err != nil {
		if errors.Is(err, agenthost.ErrSessionTitleTooLong) {
			return Session{}, ErrSessionTitleTooLong
		}
		return Session{}, err
	}
	persisted := persistedSessionFromHost(result.Canonical)
	if strings.TrimSpace(result.Session.ID) != "" {
		service := serviceSession(
			result.Session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(result.Session)),
		)
		merged := mergePersistedSessionState(service, persisted)
		merged.Title = stringPointer(persisted.Title)
		merged.UpdatedAt = timeFromUnixMSPointer(persisted.UpdatedAtUnixMS)
		return s.projectSessionForResponse(ctx, workspaceID, merged)
	}
	return s.projectSessionForResponse(ctx, workspaceID, sessionFromPersisted(
		persisted,
		s.persistedSessionCanResume(ctx, persisted),
	))
}
