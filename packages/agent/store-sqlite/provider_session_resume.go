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
// session whose provider identity was established by either a root Turn or a
// provider-accepted Goal. Goal evidence is historical and therefore remains
// monotonic when a later local generation fence clears the current projection.
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
       (
         EXISTS(
           SELECT 1
           FROM workspace_agent_turns
           WHERE workspace_id = ? AND agent_session_id = ?
             AND TRIM(COALESCE(root_provider_turn_id, '')) <> ''
         )
         OR EXISTS(
           SELECT 1
           FROM workspace_agent_goal_control_operations
           WHERE workspace_id = ? AND agent_session_id = ?
             AND (
               accepted_at_unix_ms > 0
               OR provider_phase IN (?, ?)
             )
         )
       )
`, workspaceID, agentSessionID, workspaceID, agentSessionID,
		workspaceID, agentSessionID, workspaceID, agentSessionID,
		GoalProviderPhaseAccepted, GoalProviderPhaseApplied).
		Scan(&hasTurns, &hasSettledTurn, &established); err != nil {
		return ProviderSessionResumeEvidence{}, fmt.Errorf("get provider session resume evidence: %w", err)
	}
	return ProviderSessionResumeEvidence{
		HasTurns:       hasTurns != 0,
		HasSettledTurn: hasSettledTurn != 0,
		Established:    established != 0,
	}, nil
}
