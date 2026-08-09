package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// goalStateProvesProviderSessionEstablished covers legitimate turnless Goal
// sessions. Provider acceptance or application of a durable Goal is the same
// strength of resume evidence as a provider-root Turn: both can only happen
// after the provider Session exists. A merely prepared or dispatched Goal is
// intentionally insufficient because it may predate provider acceptance.
func (h *Host) goalStateProvesProviderSessionEstablished(ctx context.Context, ref SessionRef) (bool, error) {
	if h == nil || h.goals == nil {
		return false, nil
	}
	state, found, err := h.goals.GetSessionGoalState(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found {
		return false, err
	}
	if strings.TrimSpace(metadataString(state.LastEvidence, "phase")) == storesqlite.GoalProviderPhaseAccepted ||
		strings.TrimSpace(metadataString(state.LastEvidence, "confidence")) == "authoritative" {
		return true, nil
	}
	switch strings.TrimSpace(state.SyncStatus) {
	case storesqlite.GoalSyncStatusSynced, storesqlite.GoalSyncStatusDiverged:
		return true, nil
	default:
		return false, nil
	}
}
