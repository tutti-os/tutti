package agenthost

import (
	"context"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (s *SQLiteWorkspaceStore) CompareAndSwapSessionRuntimeContext(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	expected map[string]any,
	replacement map[string]any,
) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	session, changed, err := store.CompareAndSwapSessionRuntimeContext(
		ctx,
		workspaceID,
		sessionID,
		expected,
		replacement,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(session.CommitDelta))
	}
	return session, changed, err
}
