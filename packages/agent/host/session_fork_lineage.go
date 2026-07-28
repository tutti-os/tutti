package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// GetSessionForkLineage reads the durable user-initiated fork lineage for one
// canonical target session. Provider-native child sessions use the separate
// parent/root relationship fields and never synthesize this record.
func (h *Host) GetSessionForkLineage(
	ctx context.Context,
	workspaceID, targetAgentSessionID string,
) (storesqlite.SessionForkLineage, bool, error) {
	if h == nil || h.sessionForks == nil {
		return storesqlite.SessionForkLineage{}, false, nil
	}
	return h.sessionForks.GetSessionForkLineage(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(targetAgentSessionID),
	)
}
