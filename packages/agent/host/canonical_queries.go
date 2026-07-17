package agenthost

import (
	"context"
	"strings"
)

// FindTurnByClientSubmitID exposes the canonical idempotency lookup without
// requiring callers to depend on a concrete SQLite store.
func (h *Host) FindTurnByClientSubmitID(ctx context.Context, ref SessionRef, clientSubmitID string) (string, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || clientSubmitID == "" {
		return "", false, ErrInvalidArgument
	}
	return h.store.FindTurnByClientSubmitID(ctx, ref.WorkspaceID, ref.AgentSessionID, clientSubmitID)
}
