package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ProviderSessionResumeEvidence is canonical proof that a provider session
// progressed far enough to be restored after its live runtime disappears.
type ProviderSessionResumeEvidence struct {
	HasTurns       bool
	HasSettledTurn bool
	Established    bool
}

// GetProviderSessionResumeEvidence distinguishes an empty live session from a
// session whose first canonical turn settled before the provider acknowledged
// its own root turn.
func (s *Store) GetProviderSessionResumeEvidence(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ProviderSessionResumeEvidence, error) {
	if s == nil || s.db == nil {
		return ProviderSessionResumeEvidence{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return ProviderSessionResumeEvidence{}, nil
	}
	var hasTurns, hasSettledTurn, established int
	if err := s.db.QueryRowContext(ctx, `
SELECT EXISTS(
         SELECT 1
         FROM workspace_agent_turns
         WHERE workspace_id = ? AND agent_session_id = ?
       ),
       EXISTS(
         SELECT 1
         FROM workspace_agent_turns
         WHERE workspace_id = ? AND agent_session_id = ?
           AND phase = 'settled'
       ),
       EXISTS(
         SELECT 1
         FROM workspace_agent_turns
         WHERE workspace_id = ? AND agent_session_id = ?
           AND TRIM(COALESCE(root_provider_turn_id, '')) <> ''
       )
`, workspaceID, agentSessionID, workspaceID, agentSessionID, workspaceID, agentSessionID).
		Scan(&hasTurns, &hasSettledTurn, &established); err != nil {
		return ProviderSessionResumeEvidence{}, fmt.Errorf("get provider session resume evidence: %w", err)
	}
	return ProviderSessionResumeEvidence{
		HasTurns:       hasTurns != 0,
		HasSettledTurn: hasSettledTurn != 0,
		Established:    established != 0,
	}, nil
}
