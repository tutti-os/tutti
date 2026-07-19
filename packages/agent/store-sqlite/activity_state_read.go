package storesqlite

import (
	"context"
	"strings"
)

var _ AgentStateReader = (*Store)(nil)

// GetAgentState reads the canonical root sessions and their latest Turns for
// one workspace. It intentionally excludes daemon relay presence and
// host-owned execution attribution; callers may compose those independent
// authorities at their API boundary.
func (s *Store) GetAgentState(ctx context.Context, workspaceID string) (AgentState, bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sessions, ok, err := s.ListSessions(ctx, workspaceID)
	if err != nil || !ok {
		return AgentState{}, ok, err
	}

	sessionIDs := make([]string, 0, len(sessions))
	for _, session := range sessions {
		sessionIDs = append(sessionIDs, session.ID)
	}
	latestTurns, err := s.ListLatestTurns(ctx, workspaceID, sessionIDs)
	if err != nil {
		return AgentState{}, false, err
	}

	state := AgentState{
		WorkspaceID: workspaceID,
		Sessions:    make([]AgentSessionState, 0, len(sessions)),
	}
	for _, session := range sessions {
		entry := AgentSessionState{Session: session}
		if turn, found := latestTurns[session.ID]; found {
			turnCopy := turn
			entry.LatestTurn = &turnCopy
		}
		state.Sessions = append(state.Sessions, entry)
	}
	return state, true, nil
}
