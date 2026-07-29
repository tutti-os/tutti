package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) List(ctx context.Context, workspaceID string) ([]Session, error) {
	return s.ListFiltered(ctx, workspaceID, ListSessionsInput{})
}

func (s *Service) ListFiltered(ctx context.Context, workspaceID string, input ListSessionsInput) ([]Session, error) {
	page, err := s.ListPage(ctx, workspaceID, input)
	if err != nil {
		return nil, err
	}
	return page.Sessions, nil
}

func (s *Service) ListPage(ctx context.Context, workspaceID string, input ListSessionsInput) (SessionListPage, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	reader, ok := s.SessionReader.(SessionPageReader)
	if workspaceID == "" || !ok {
		return SessionListPage{}, fmt.Errorf("%w: canonical session page reader is unavailable", ErrInvalidArgument)
	}
	cursor := sessionPageCursor{}
	if strings.TrimSpace(input.Cursor) != "" {
		parsed, err := parseSessionListCursor(input.Cursor)
		if err != nil {
			return SessionListPage{}, err
		}
		cursor = parsed
	}
	page, ok, err := reader.ListSessionsPage(ctx, agentactivitybiz.ListSessionsPageInput{
		WorkspaceID:          workspaceID,
		AgentTargetID:        strings.TrimSpace(input.AgentTargetID),
		SearchQuery:          input.SearchQuery,
		CursorSortTimeUnixMS: cursor.SortTimeUnixMS,
		CursorSessionID:      cursor.ID,
		Limit:                input.Limit,
	})
	if err != nil {
		return SessionListPage{}, err
	}
	if !ok {
		return SessionListPage{Sessions: []Session{}}, nil
	}
	liveByID := make(map[string]ProviderRuntimeSession)
	for _, session := range s.controller().Sessions(workspaceID) {
		liveByID[strings.TrimSpace(session.ID)] = session
	}
	result := make([]Session, 0, len(page.Sessions))
	for _, persisted := range page.Sessions {
		if err := validatePersistedRailSectionKey(persisted); err != nil {
			return SessionListPage{}, err
		}
		resumable := s.persistedSessionCanResume(ctx, persisted)
		projected := sessionFromPersisted(persisted, resumable)
		if live, found := liveByID[strings.TrimSpace(persisted.ID)]; found {
			projected = serviceSessionWithPersistedFreshness(
				live,
				persisted,
				s.controller().CanResume(runtimeResumeInputFromRuntimeSession(live)),
			)
		}
		result = append(result, cloneSession(projected))
	}
	result, err = s.withProtocolV2TurnStates(ctx, workspaceID, result)
	if err != nil {
		return SessionListPage{}, err
	}
	return SessionListPage{
		Sessions:   result,
		HasMore:    page.HasMore,
		NextCursor: page.NextCursor,
	}, nil
}

type sessionPageCursor struct {
	ID             string
	SortTimeUnixMS int64
}

func parseSessionListCursor(raw string) (sessionPageCursor, error) {
	parts := strings.SplitN(strings.TrimSpace(raw), "|", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[1]) == "" {
		return sessionPageCursor{}, ErrInvalidArgument
	}
	sortTimeUnixMS, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || sortTimeUnixMS < 0 {
		return sessionPageCursor{}, ErrInvalidArgument
	}
	return sessionPageCursor{
		ID:             strings.TrimSpace(parts[1]),
		SortTimeUnixMS: sortTimeUnixMS,
	}, nil
}
