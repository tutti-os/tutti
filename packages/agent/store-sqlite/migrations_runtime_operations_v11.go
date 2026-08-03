package storesqlite

import (
	"context"
	"fmt"
	"time"
)

// V11 permanently retires only the known pre-V2 edit-retry protocol: a
// missing sagaVersion or the numeric legacy versions zero and one. A future,
// text, NULL, malformed, or otherwise invalid version is never treated as a
// historical row with pre-effect proof. Rows that cannot have crossed a
// provider mutation are terminalized; every other non-V2 row becomes a
// session-local blocked incident and can never return to the claim query.
// This includes a legacy terminal row which still owns a non-ready fence:
// terminal status alone is not provider evidence and must not leave a
// permanently fenced session with a terminal owner.
func (s *Store) applyWorkspaceAgentRuntimeOperationsV11(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV11)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin runtime operations v11 migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	now := time.Now().UTC().UnixMilli()
	// A historical fence for an already deleted session is not an incident and
	// has no provider authority. Never apply this rule to a live session.
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history AS h
SET recovery_state='ready', operation_id='', updated_at_unix_ms=?
WHERE h.recovery_state <> 'ready'
  AND EXISTS (
    SELECT 1 FROM workspace_agent_sessions AS s
    WHERE s.workspace_id=h.workspace_id AND s.agent_session_id=h.agent_session_id
      AND s.deleted_at_unix_ms <> 0
  )`, now); err != nil {
		return fmt.Errorf("clear deleted session edit retry fences: %w", err)
	}
	// Only explicit, valid pre-effect checkpoints may be terminalized. Do not
	// give a missing, NULL, unknown, or malformed payload the benefit of the
	// doubt: any such row may have crossed an old provider boundary and must
	// remain a fenced, non-executable incident instead.
	//
	// rollback_aborted is the historical durable proof that rollback was not
	// dispatched. It is therefore safe to terminalize alongside prepared.
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status='completed', result='abandoned', lease_owner=NULL,
    lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=NULL,
    last_error='edit_retry_protocol_retired', completed_at_unix_ms=?,
    updated_at_unix_ms=?, version=version+1
WHERE kind='edit_retry' AND status IN ('prepared','leased')
  AND CASE WHEN json_valid(payload_json) THEN CASE
    WHEN json_type(payload_json,'$.sagaVersion') IS NULL THEN 1
    WHEN json_type(payload_json,'$.sagaVersion') IN ('integer','real')
     AND json_extract(payload_json,'$.sagaVersion') IN (0,1) THEN 1
    ELSE 0
  END ELSE 0 END = 1
  AND CASE WHEN json_valid(payload_json) THEN CASE
    WHEN json_type(payload_json,'$.step') = 'text'
     AND json_extract(payload_json,'$.step') IN ('prepared','rollback_aborted') THEN 1
    ELSE 0
  END ELSE 0 END = 1`, now, now); err != nil {
		return fmt.Errorf("terminalize pre-effect legacy edit retries: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history AS h
SET recovery_state='ready', operation_id='', updated_at_unix_ms=?
WHERE EXISTS (
  SELECT 1 FROM workspace_agent_runtime_operations AS o
  WHERE o.workspace_id=h.workspace_id
    AND o.agent_session_id=h.agent_session_id
    AND o.operation_id=h.operation_id
    AND o.kind='edit_retry'
    AND o.result='abandoned'
    AND o.last_error='edit_retry_protocol_retired'
    AND CASE WHEN json_valid(o.payload_json) THEN CASE
      WHEN json_type(o.payload_json,'$.sagaVersion') IS NULL THEN 1
      WHEN json_type(o.payload_json,'$.sagaVersion') IN ('integer','real')
       AND json_extract(o.payload_json,'$.sagaVersion') IN (0,1) THEN 1
      ELSE 0
    END ELSE 0 END = 1
    AND CASE WHEN json_valid(o.payload_json) THEN CASE
      WHEN json_type(o.payload_json,'$.step') = 'text'
       AND json_extract(o.payload_json,'$.step') IN ('prepared','rollback_aborted') THEN 1
      ELSE 0
    END ELSE 0 END = 1
)`, now); err != nil {
		return fmt.Errorf("clear terminalized legacy edit retry fences: %w", err)
	}
	// Any non-V2 row not terminalized above is intentionally not terminalized:
	// retain its exact fence as a typed, non-executable recovery incident. This
	// includes legacy rows which were already blocked; normalization never gives a
	// pre-effect checkpoint in a blocked row permission to clear its fence.
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status='blocked', result=NULL, completed_at_unix_ms=NULL,
    lease_owner=NULL, lease_expires_at_unix_ms=NULL,
    next_attempt_at_unix_ms=NULL, last_error='recovery_required',
    updated_at_unix_ms=?, version=version+1
WHERE kind='edit_retry'
  AND (
    status IN ('prepared','leased','blocked') OR EXISTS (
      SELECT 1 FROM workspace_agent_session_history AS h
      WHERE h.workspace_id=workspace_agent_runtime_operations.workspace_id
        AND h.agent_session_id=workspace_agent_runtime_operations.agent_session_id
        AND h.operation_id=workspace_agent_runtime_operations.operation_id
        AND h.recovery_state <> 'ready'
    )
  )
  AND CASE WHEN json_valid(payload_json) THEN CASE
    WHEN json_type(payload_json,'$.sagaVersion') IN ('integer','real')
     AND json_extract(payload_json,'$.sagaVersion') = ? THEN 1
    ELSE 0
  END ELSE 0 END = 0
  AND NOT (
    status IN ('prepared','leased')
    AND CASE WHEN json_valid(payload_json) THEN CASE
      WHEN json_type(payload_json,'$.sagaVersion') IS NULL THEN 1
      WHEN json_type(payload_json,'$.sagaVersion') IN ('integer','real')
       AND json_extract(payload_json,'$.sagaVersion') IN (0,1) THEN 1
      ELSE 0
    END ELSE 0 END = 1
    AND CASE WHEN json_valid(payload_json) THEN CASE
      WHEN json_type(payload_json,'$.step') = 'text'
       AND json_extract(payload_json,'$.step') IN ('prepared','rollback_aborted') THEN 1
      ELSE 0
    END ELSE 0 END = 1
  )`, now, EditRetrySagaVersionCurrent); err != nil {
		return fmt.Errorf("block ambiguous legacy edit retries: %w", err)
	}
	// Retain the exact owner while using the one stable incident state. This is
	// intentionally after the operation disposition: a failed or completed
	// legacy row may be changed to blocked only when it was demonstrably the
	// owner of this live non-ready fence. Cross-session/workspace pointers stay
	// observable invariants rather than being rewritten here.
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history AS h
SET recovery_state='recovery_required', updated_at_unix_ms=?
WHERE h.recovery_state <> 'ready'
  AND EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS o
    WHERE o.workspace_id=h.workspace_id
      AND o.agent_session_id=h.agent_session_id
      AND o.operation_id=h.operation_id
      AND o.kind='edit_retry'
      AND o.status='blocked'
      AND o.last_error='recovery_required'
      AND CASE WHEN json_valid(o.payload_json) THEN CASE
        WHEN json_type(o.payload_json,'$.sagaVersion') IN ('integer','real')
         AND json_extract(o.payload_json,'$.sagaVersion') = ? THEN 1
        ELSE 0
      END ELSE 0 END = 0
  )`, now, EditRetrySagaVersionCurrent); err != nil {
		return fmt.Errorf("normalize legacy edit retry fences: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV11); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit runtime operations v11 migration: %w", err)
	}
	committed = true
	return nil
}
