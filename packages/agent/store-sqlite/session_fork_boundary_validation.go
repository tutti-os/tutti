package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func sessionForkSelectedTurnStateError(turn Turn, provenance string) error {
	switch {
	case turn.Phase != TurnPhaseSettled:
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonTurnNotSettled,
			fmt.Sprintf("selected turn phase is %q, want %q", turn.Phase, TurnPhaseSettled),
		)
	case !isVerifiedSessionForkSequence(provenance):
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonTurnSequenceUnverified,
			fmt.Sprintf("selected turn sequence provenance is %q", provenance),
		)
	case strings.TrimSpace(turn.RootProviderTurnID) == "":
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonProviderTurnMissing,
			"selected turn has no root provider turn id",
		)
	default:
		return nil
	}
}

func invalidSessionForkPrefixErrorTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, sourceSessionID string,
	throughSequence int64,
) error {
	var turnID, provenance, phase, providerTurnID string
	var sequence int64
	err := tx.QueryRowContext(ctx, `
SELECT sequence.turn_id, sequence.turn_sequence, sequence.provenance,
       COALESCE(turn.phase, ''), COALESCE(turn.root_provider_turn_id, '')
FROM workspace_agent_turn_sequences sequence
LEFT JOIN workspace_agent_turns turn
  ON turn.workspace_id = sequence.workspace_id
 AND turn.agent_session_id = sequence.agent_session_id
 AND turn.turn_id = sequence.turn_id
WHERE sequence.workspace_id = ?
  AND sequence.agent_session_id = ?
  AND sequence.turn_sequence <= ?
  AND (
    sequence.provenance NOT IN ('verified','fork_clone_verified')
    OR turn.turn_id IS NULL
    OR turn.phase <> ?
    OR COALESCE(turn.root_provider_turn_id, '') = ''
  )
ORDER BY sequence.turn_sequence
LIMIT 1
`, workspaceID, sourceSessionID, throughSequence, TurnPhaseSettled).Scan(
		&turnID,
		&sequence,
		&provenance,
		&phase,
		&providerTurnID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read invalid session fork prefix: %w", err)
	}
	switch {
	case phase == "":
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonPrefixTurnMissing,
			fmt.Sprintf("turn sequence %d references missing turn %q", sequence, turnID),
		)
	case !isVerifiedSessionForkSequence(provenance):
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonPrefixSequenceUnverified,
			fmt.Sprintf(
				"turn %q at sequence %d has provenance %q",
				turnID,
				sequence,
				provenance,
			),
		)
	case phase != TurnPhaseSettled:
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonPrefixTurnNotSettled,
			fmt.Sprintf(
				"turn %q at sequence %d has phase %q",
				turnID,
				sequence,
				phase,
			),
		)
	case strings.TrimSpace(providerTurnID) == "":
		return newSessionForkBoundaryError(
			SessionForkBoundaryReasonPrefixProviderTurnMissing,
			fmt.Sprintf(
				"turn %q at sequence %d has no root provider turn id",
				turnID,
				sequence,
			),
		)
	default:
		return nil
	}
}

func rejectedSessionForkBoundaryFromError(err error) SessionForkBoundary {
	var boundaryErr *SessionForkBoundaryError
	if !errors.As(err, &boundaryErr) {
		return SessionForkBoundary{}
	}
	return rejectedSessionForkBoundary(boundaryErr.Reason, boundaryErr.detail)
}
