package agent

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
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
	result, err := s.listFilteredSortedSessions(ctx, workspaceID, input)
	if err != nil {
		return SessionListPage{}, err
	}
	hasMore := false
	if input.Limit > 0 && len(result) > input.Limit {
		hasMore = true
		result = result[:input.Limit]
	}
	nextCursor := ""
	if hasMore && len(result) > 0 {
		nextCursor = sessionListCursor(result[len(result)-1]).String()
	}
	result, err = s.withProtocolV2TurnStates(ctx, strings.TrimSpace(workspaceID), result)
	if err != nil {
		return SessionListPage{}, err
	}
	return SessionListPage{
		Sessions:   result,
		HasMore:    hasMore,
		NextCursor: nextCursor,
	}, nil
}

func (s *Service) listFilteredSortedSessions(ctx context.Context, workspaceID string, input ListSessionsInput) ([]Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	sessionByID := make(map[string]Session)
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.ListSessions(workspaceID); ok {
			for _, session := range persisted {
				sessionID := strings.TrimSpace(session.ID)
				if isStaleHiddenLiveModelDiscoverySession(session) {
					if _, ok := s.controller().Session(workspaceID, sessionID); !ok {
						if _, err := s.Delete(ctx, workspaceID, sessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
							return nil, err
						}
					}
					continue
				}
				sessionByID[strings.TrimSpace(session.ID)] = sessionFromPersisted(
					session,
					persistedSessionCanResume(s.controller(), session),
				)
			}
		}
	}
	sessions := s.controller().Sessions(workspaceID)
	for _, session := range sessions {
		resumable := s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session))
		service := serviceSession(session, resumable)
		if s.SessionReader != nil {
			if persisted, ok := s.SessionReader.GetSession(workspaceID, session.ID); ok {
				service = serviceSessionWithPersistedFreshness(session, persisted, resumable)
			}
		}
		sessionByID[strings.TrimSpace(session.ID)] = service
	}
	result := make([]Session, 0, len(sessionByID))
	for _, session := range sessionByID {
		result = append(result, cloneSession(session))
	}

	result = filterSessions(result, input)
	sort.SliceStable(result, func(left, right int) bool {
		leftUpdatedAtUnixMS := sessionUpdatedAtUnixMS(result[left])
		rightUpdatedAtUnixMS := sessionUpdatedAtUnixMS(result[right])
		if leftUpdatedAtUnixMS == rightUpdatedAtUnixMS {
			return strings.TrimSpace(result[left].ID) < strings.TrimSpace(result[right].ID)
		}
		return leftUpdatedAtUnixMS > rightUpdatedAtUnixMS
	})
	return result, nil
}

type sessionPageCursor struct {
	ID              string
	UpdatedAtUnixMS int64
}

func sessionListCursor(session Session) sessionPageCursor {
	return sessionPageCursor{
		ID:              strings.TrimSpace(session.ID),
		UpdatedAtUnixMS: sessionUpdatedAtUnixMS(session),
	}
}

func (cursor sessionPageCursor) String() string {
	if strings.TrimSpace(cursor.ID) == "" {
		return ""
	}
	return strconv.FormatInt(cursor.UpdatedAtUnixMS, 10) + "|" + strings.TrimSpace(cursor.ID)
}

func parseSessionListCursor(raw string) (sessionPageCursor, error) {
	parts := strings.SplitN(strings.TrimSpace(raw), "|", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[1]) == "" {
		return sessionPageCursor{}, ErrInvalidArgument
	}
	updatedAtUnixMS, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || updatedAtUnixMS < 0 {
		return sessionPageCursor{}, ErrInvalidArgument
	}
	return sessionPageCursor{
		ID:              strings.TrimSpace(parts[1]),
		UpdatedAtUnixMS: updatedAtUnixMS,
	}, nil
}
