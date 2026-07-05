package agent

import (
	"strings"
)

func filterSessions(
	sessions []Session,
	input ListSessionsInput,
) []Session {
	if len(sessions) == 0 {
		return sessions
	}
	filtered := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		if !sessionVisibleInLists(session) {
			continue
		}
		if !matchesSessionSearch(session, input.SearchQuery) {
			continue
		}
		filtered = append(filtered, session)
	}
	return filtered
}

func sessionVisibleInLists(session Session) bool {
	if !session.Visible {
		return false
	}
	return visibleFromRuntimeContext(session.RuntimeContext, true)
}

func matchesSessionSearch(session Session, rawQuery string) bool {
	query := strings.Join(strings.Fields(strings.ToLower(rawQuery)), " ")
	if query == "" {
		return true
	}
	haystack := strings.ToLower(strings.Join([]string{
		session.ID,
		session.Provider,
		value(session.Title),
		session.Status,
		session.Cwd,
	}, "\n"))
	for _, token := range strings.Fields(query) {
		if !strings.Contains(haystack, token) {
			return false
		}
	}
	return true
}
