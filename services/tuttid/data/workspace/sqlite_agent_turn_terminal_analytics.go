package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
)

const terminalAnalyticsClaimScanLimit = 64

func (s *SQLiteStore) PutAgentTurnTerminalAnalytics(
	ctx context.Context,
	input agentturnanalyticsbiz.Settlement,
	nowUnixMS int64,
) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	input = normalizeTerminalAnalyticsSettlement(input)
	if err := validateTerminalAnalyticsSettlement(input, nowUnixMS); err != nil {
		return false, err
	}
	result, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_turn_terminal_analytics (
  workspace_id, agent_session_id, turn_id, event_id, provider,
  turn_origin, turn_outcome, error_code, startup_reconciled,
  started_at_unix_ms, settled_at_unix_ms, status,
  created_at_unix_ms, updated_at_unix_ms
)
SELECT turn.workspace_id, turn.agent_session_id, turn.turn_id, ?,
       COALESCE(session.provider, ''), turn.turn_origin, turn.outcome,
       COALESCE(json_extract(turn.error_json, '$.code'), ''), ?,
       turn.started_at_unix_ms, turn.settled_at_unix_ms, 'pending', ?, ?
FROM workspace_agent_turns AS turn
JOIN workspace_agent_sessions AS session
  ON session.workspace_id = turn.workspace_id
 AND session.agent_session_id = turn.agent_session_id
WHERE turn.workspace_id = ?
  AND turn.agent_session_id = ?
  AND turn.turn_id = ?
  AND turn.phase = 'settled'
  AND turn.outcome IN ('completed', 'failed', 'canceled', 'interrupted')
  AND turn.backfilled = 0
  AND turn.turn_origin = 'user_prompt'
  AND session.session_kind = 'root'
ON CONFLICT(workspace_id, agent_session_id, turn_id) DO NOTHING
`, input.EventID, boolInt(input.StartupReconciled), nowUnixMS, nowUnixMS,
		input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if err != nil {
		return false, fmt.Errorf("put Agent Turn terminal analytics: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("put Agent Turn terminal analytics rows affected: %w", err)
	}
	return rows == 1, nil
}

func (s *SQLiteStore) ClaimAgentTurnTerminalAnalytics(
	ctx context.Context,
	owner string,
	nowUnixMS int64,
	leaseExpiresAtUnixMS int64,
) (agentturnanalyticsbiz.Delivery, bool, error) {
	if s == nil || s.writeDB == nil {
		return agentturnanalyticsbiz.Delivery{}, false, errors.New("workspace database is not initialized")
	}
	owner = strings.TrimSpace(owner)
	if owner == "" || nowUnixMS <= 0 || leaseExpiresAtUnixMS <= nowUnixMS {
		return agentturnanalyticsbiz.Delivery{}, false, errors.New("invalid Agent Turn terminal analytics lease")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("begin claim Agent Turn terminal analytics: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
SELECT ledger.workspace_id, ledger.agent_session_id, ledger.turn_id,
       ledger.event_id, ledger.provider, ledger.turn_origin,
       ledger.turn_outcome, ledger.error_code, ledger.startup_reconciled,
       ledger.started_at_unix_ms, ledger.settled_at_unix_ms,
       (
         SELECT submission.metadata_json
         FROM workspace_agent_turn_submissions AS submission
         WHERE submission.workspace_id = ledger.workspace_id
           AND submission.agent_session_id = ledger.agent_session_id
           AND submission.turn_id = ledger.turn_id
         LIMIT 1
       ),
       (
         SELECT submission.client_submit_id
         FROM workspace_agent_turn_submissions AS submission
         WHERE submission.workspace_id = ledger.workspace_id
           AND submission.agent_session_id = ledger.agent_session_id
           AND submission.turn_id = ledger.turn_id
         LIMIT 1
       ),
       (
         SELECT claim.metadata_json
         FROM workspace_agent_submit_claims AS claim
         WHERE claim.workspace_id = ledger.workspace_id
           AND claim.agent_session_id = ledger.agent_session_id
           AND claim.canonical_turn_id = ledger.turn_id
         ORDER BY claim.created_at_unix_ms, claim.client_submit_id
         LIMIT 1
       ),
       (
         SELECT claim.client_submit_id
         FROM workspace_agent_submit_claims AS claim
         WHERE claim.workspace_id = ledger.workspace_id
           AND claim.agent_session_id = ledger.agent_session_id
           AND claim.canonical_turn_id = ledger.turn_id
         ORDER BY claim.created_at_unix_ms, claim.client_submit_id
         LIMIT 1
       ),
       (
         SELECT COUNT(*)
         FROM workspace_agent_submit_claims AS claim
         WHERE claim.workspace_id = ledger.workspace_id
           AND claim.agent_session_id = ledger.agent_session_id
           AND claim.canonical_turn_id = ledger.turn_id
       )
FROM agent_turn_terminal_analytics AS ledger
WHERE (
    ledger.status = 'pending'
    OR (ledger.status = 'leased' AND ledger.lease_expires_at_unix_ms <= ?)
  )
  AND (
    EXISTS (
      SELECT 1
      FROM workspace_agent_turn_submissions AS submission
      WHERE submission.workspace_id = ledger.workspace_id
        AND submission.agent_session_id = ledger.agent_session_id
        AND submission.turn_id = ledger.turn_id
    )
    OR (
      (
        SELECT COUNT(*)
        FROM workspace_agent_submit_claims AS claim
        WHERE claim.workspace_id = ledger.workspace_id
          AND claim.agent_session_id = ledger.agent_session_id
          AND claim.canonical_turn_id = ledger.turn_id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM workspace_agent_submit_claims AS claim
        WHERE claim.workspace_id = ledger.workspace_id
          AND claim.agent_session_id = ledger.agent_session_id
          AND claim.canonical_turn_id = ledger.turn_id
          AND json_extract(claim.metadata_json, '$.uiMode') IN ('os', 'agent')
      )
    )
  )
ORDER BY ledger.created_at_unix_ms, ledger.workspace_id,
         ledger.agent_session_id, ledger.turn_id
LIMIT ?
`, nowUnixMS, terminalAnalyticsClaimScanLimit)
	if err != nil {
		return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("list claimable Agent Turn terminal analytics: %w", err)
	}
	type candidate struct {
		delivery                 agentturnanalyticsbiz.Delivery
		submissionMetadata       sql.NullString
		submissionClientSubmitID sql.NullString
		claimMetadata            sql.NullString
		claimClientSubmitID      sql.NullString
		claimCount               int64
	}
	candidates := make([]candidate, 0, terminalAnalyticsClaimScanLimit)
	for rows.Next() {
		var item candidate
		var startupReconciled int
		if err := rows.Scan(
			&item.delivery.WorkspaceID,
			&item.delivery.AgentSessionID,
			&item.delivery.TurnID,
			&item.delivery.EventID,
			&item.delivery.Provider,
			&item.delivery.Origin,
			&item.delivery.Outcome,
			&item.delivery.ErrorCode,
			&startupReconciled,
			&item.delivery.StartedAtUnixMS,
			&item.delivery.SettledAtUnixMS,
			&item.submissionMetadata,
			&item.submissionClientSubmitID,
			&item.claimMetadata,
			&item.claimClientSubmitID,
			&item.claimCount,
		); err != nil {
			rows.Close()
			return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("scan claimable Agent Turn terminal analytics: %w", err)
		}
		item.delivery.StartupReconciled = startupReconciled != 0
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("iterate claimable Agent Turn terminal analytics: %w", err)
	}
	rows.Close()

	for _, item := range candidates {
		delivery := item.delivery
		switch {
		case item.submissionMetadata.Valid:
			delivery.MetadataJSON = item.submissionMetadata.String
			delivery.ClientSubmitID = item.submissionClientSubmitID.String
		case item.claimCount == 1 && item.claimMetadata.Valid:
			delivery.MetadataJSON = item.claimMetadata.String
			delivery.ClientSubmitID = item.claimClientSubmitID.String
		default:
			continue
		}
		result, err := tx.ExecContext(ctx, `
UPDATE agent_turn_terminal_analytics
SET status = 'leased', lease_owner = ?, lease_expires_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND (status = 'pending' OR (status = 'leased' AND lease_expires_at_unix_ms <= ?))
`, owner, leaseExpiresAtUnixMS, nowUnixMS, delivery.WorkspaceID,
			delivery.AgentSessionID, delivery.TurnID, nowUnixMS)
		if err != nil {
			return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("claim Agent Turn terminal analytics: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("claim Agent Turn terminal analytics rows affected: %w", err)
		}
		if affected != 1 {
			continue
		}
		if err := tx.Commit(); err != nil {
			return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("commit claim Agent Turn terminal analytics: %w", err)
		}
		return delivery, true, nil
	}
	if err := tx.Commit(); err != nil {
		return agentturnanalyticsbiz.Delivery{}, false, fmt.Errorf("commit empty Agent Turn terminal analytics claim: %w", err)
	}
	return agentturnanalyticsbiz.Delivery{}, false, nil
}

func (s *SQLiteStore) RequeueAgentTurnTerminalAnalytics(
	ctx context.Context,
	nowUnixMS int64,
) (int64, error) {
	if s == nil || s.writeDB == nil {
		return 0, errors.New("workspace database is not initialized")
	}
	if nowUnixMS <= 0 {
		return 0, errors.New("invalid Agent Turn terminal analytics recovery time")
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE agent_turn_terminal_analytics
SET status = 'pending', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE status = 'leased'
`, nowUnixMS)
	if err != nil {
		return 0, fmt.Errorf("requeue Agent Turn terminal analytics: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("requeue Agent Turn terminal analytics rows affected: %w", err)
	}
	return rows, nil
}

func (s *SQLiteStore) CompleteAgentTurnTerminalAnalytics(
	ctx context.Context,
	workspaceID, agentSessionID, turnID, owner string,
	nowUnixMS int64,
) (bool, error) {
	return s.finishAgentTurnTerminalAnalytics(
		ctx, workspaceID, agentSessionID, turnID, owner, "delivered", "", nowUnixMS,
	)
}

func (s *SQLiteStore) IgnoreAgentTurnTerminalAnalytics(
	ctx context.Context,
	workspaceID, agentSessionID, turnID, owner, reason string,
	nowUnixMS int64,
) (bool, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "invalid_event"
	}
	return s.finishAgentTurnTerminalAnalytics(
		ctx, workspaceID, agentSessionID, turnID, owner, "ignored", reason, nowUnixMS,
	)
}

func (s *SQLiteStore) finishAgentTurnTerminalAnalytics(
	ctx context.Context,
	workspaceID, agentSessionID, turnID, owner, status, ignoredReason string,
	nowUnixMS int64,
) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	owner = strings.TrimSpace(owner)
	if workspaceID == "" || agentSessionID == "" || turnID == "" || owner == "" || nowUnixMS <= 0 {
		return false, errors.New("invalid Agent Turn terminal analytics completion")
	}
	deliveredAtUnixMS := int64(0)
	if status == "delivered" {
		deliveredAtUnixMS = nowUnixMS
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE agent_turn_terminal_analytics
SET status = ?, ignored_reason = ?, lease_owner = '',
    lease_expires_at_unix_ms = 0, delivered_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND status = 'leased' AND lease_owner = ?
`, status, ignoredReason, deliveredAtUnixMS, nowUnixMS,
		workspaceID, agentSessionID, turnID, owner)
	if err != nil {
		return false, fmt.Errorf("finish Agent Turn terminal analytics: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("finish Agent Turn terminal analytics rows affected: %w", err)
	}
	return rows == 1, nil
}

func normalizeTerminalAnalyticsSettlement(input agentturnanalyticsbiz.Settlement) agentturnanalyticsbiz.Settlement {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.EventID = strings.TrimSpace(input.EventID)
	input.Provider = strings.TrimSpace(input.Provider)
	input.Origin = strings.TrimSpace(input.Origin)
	input.Outcome = strings.TrimSpace(input.Outcome)
	input.ErrorCode = strings.TrimSpace(input.ErrorCode)
	if input.WorkspaceID != "" && input.AgentSessionID != "" && input.TurnID != "" {
		input.EventID = agentturnanalyticsbiz.StableEventID(input.WorkspaceID, input.AgentSessionID, input.TurnID)
	}
	return input
}

func validateTerminalAnalyticsSettlement(input agentturnanalyticsbiz.Settlement, nowUnixMS int64) error {
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" ||
		input.EventID == "" || nowUnixMS <= 0 {
		return errors.New("invalid Agent Turn terminal analytics settlement")
	}
	return nil
}
