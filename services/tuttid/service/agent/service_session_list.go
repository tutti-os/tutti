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
	if strings.TrimSpace(input.Cursor) != "" {
		cursor, err := parseSessionListCursor(input.Cursor)
		if err != nil {
			return SessionListPage{}, err
		}
		result = sessionsAfterCursor(result, cursor)
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
				if err := validatePersistedRailSectionKey(session); err != nil {
					return nil, err
				}
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
		if s.SessionReader != nil {
			deleted, err := s.SessionReader.SessionDeleted(ctx, workspaceID, session.ID)
			if err != nil {
				return nil, err
			}
			if deleted {
				continue
			}
		}
		resumable := s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session))
		service := serviceSession(session, resumable)
		if s.SessionReader != nil {
			persisted, ok := s.SessionReader.GetSession(workspaceID, session.ID)
			if !ok {
				return nil, errors.New("live workspace agent session has no persisted session")
			}
			if err := validatePersistedRailSectionKey(persisted); err != nil {
				return nil, err
			}
			service = serviceSessionWithPersistedFreshness(session, persisted, resumable)
		}
		sessionByID[strings.TrimSpace(session.ID)] = service
	}
	result := make([]Session, 0, len(sessionByID))
	for _, session := range sessionByID {
		result = append(result, cloneSession(session))
	}

	result = filterSessions(result, input)
	result, err := s.withLatestTurnsForConversationOrder(ctx, workspaceID, result)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(result, func(left, right int) bool {
		leftSortTimeUnixMS := sessionConversationSortTimeUnixMS(result[left])
		rightSortTimeUnixMS := sessionConversationSortTimeUnixMS(result[right])
		if leftSortTimeUnixMS == rightSortTimeUnixMS {
			return strings.TrimSpace(result[left].ID) < strings.TrimSpace(result[right].ID)
		}
		return leftSortTimeUnixMS > rightSortTimeUnixMS
	})
	return result, nil
}

type sessionPageCursor struct {
	ID             string
	SortTimeUnixMS int64
}

func sessionListCursor(session Session) sessionPageCursor {
	return sessionPageCursor{
		ID:             strings.TrimSpace(session.ID),
		SortTimeUnixMS: sessionConversationSortTimeUnixMS(session),
	}
}

func (cursor sessionPageCursor) String() string {
	if strings.TrimSpace(cursor.ID) == "" {
		return ""
	}
	return strconv.FormatInt(cursor.SortTimeUnixMS, 10) + "|" + strings.TrimSpace(cursor.ID)
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

func sessionsAfterCursor(
	sessions []Session,
	cursor sessionPageCursor,
) []Session {
	for index, session := range sessions {
		sortTimeUnixMS := sessionConversationSortTimeUnixMS(session)
		sessionID := strings.TrimSpace(session.ID)
		if sortTimeUnixMS < cursor.SortTimeUnixMS ||
			(sortTimeUnixMS == cursor.SortTimeUnixMS && sessionID > cursor.ID) {
			return sessions[index:]
		}
	}
	return nil
}

func (s *Service) withLatestTurnsForConversationOrder(
	ctx context.Context,
	workspaceID string,
	sessions []Session,
) ([]Session, error) {
	if s == nil || s.TurnStore == nil || len(sessions) == 0 {
		return sessions, nil
	}
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, strings.TrimSpace(session.ID))
	}
	latestBySessionID, err := s.TurnStore.ListLatestTurns(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	result := make([]Session, len(sessions))
	for index, session := range sessions {
		if latest, ok := latestBySessionID[strings.TrimSpace(session.ID)]; ok {
			value := latest
			session.LatestTurn = &value
		}
		result[index] = session
	}
	return result, nil
}

func sessionConversationSortTimeUnixMS(session Session) int64 {
	if session.LatestTurn != nil && session.LatestTurn.StartedAtUnixMS > 0 {
		return session.LatestTurn.StartedAtUnixMS
	}
	if !session.CreatedAt.IsZero() {
		return session.CreatedAt.UnixMilli()
	}
	return 0
}
