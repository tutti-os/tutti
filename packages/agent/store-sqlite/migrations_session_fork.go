package storesqlite

import (
	"context"
	"fmt"
)

// applyWorkspaceAgentSessionForkV1 adds the provider-backed session Fork
// operation log and an immutable, session-scoped Turn order. Existing
// sessions are verified only when every Turn has durable, immutable Message
// row-id evidence whose ranges do not overlap. One missing or interleaved
// boundary makes that whole legacy
// session fail closed; timestamps, random external IDs, and mutable versions
// are not proof.
func (s *Store) applyWorkspaceAgentSessionForkV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_turn_sequences (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_sequence INTEGER NOT NULL CHECK (turn_sequence > 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('verified','legacy_unverified','fork_clone_verified')),
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  UNIQUE (workspace_id, agent_session_id, turn_sequence)
);

INSERT INTO workspace_agent_turn_sequences (
  workspace_id, agent_session_id, turn_id, turn_sequence, provenance
)
WITH turn_message_evidence AS (
  SELECT turn.workspace_id, turn.agent_session_id, turn.turn_id,
         MIN(message.id) AS first_message_id,
         MAX(message.id) AS last_message_id
  FROM workspace_agent_turns turn
  LEFT JOIN workspace_agent_messages message
    ON message.workspace_id = turn.workspace_id
   AND message.agent_session_id = turn.agent_session_id
   AND message.turn_id = turn.turn_id
  GROUP BY turn.workspace_id, turn.agent_session_id, turn.turn_id
),
ordered AS (
  SELECT workspace_id, agent_session_id, turn_id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, agent_session_id
           ORDER BY first_message_id, turn_id
         ) AS turn_sequence,
         MIN(CASE WHEN first_message_id IS NULL THEN 0 ELSE 1 END) OVER (
           PARTITION BY workspace_id, agent_session_id
         ) AS all_turns_have_message_evidence,
         MAX(last_message_id) OVER (
           PARTITION BY workspace_id, agent_session_id
           ORDER BY first_message_id, turn_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS prior_last_message_id,
         first_message_id
  FROM turn_message_evidence
),
verified AS (
  SELECT workspace_id, agent_session_id, turn_id, turn_sequence,
         MIN(CASE
           WHEN first_message_id IS NULL THEN 0
           WHEN prior_last_message_id IS NOT NULL
             AND first_message_id <= prior_last_message_id THEN 0
           ELSE 1
         END) OVER (
           PARTITION BY workspace_id, agent_session_id
         ) AS message_ranges_are_ordered,
         all_turns_have_message_evidence
  FROM ordered
)
SELECT workspace_id, agent_session_id, turn_id, turn_sequence,
       CASE WHEN all_turns_have_message_evidence = 1
                  AND message_ranges_are_ordered = 1
            THEN 'verified' ELSE 'legacy_unverified' END
FROM verified;

CREATE TRIGGER workspace_agent_turn_sequence_after_insert
AFTER INSERT ON workspace_agent_turns
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_agent_turn_sequences
  WHERE workspace_id = NEW.workspace_id
    AND agent_session_id = NEW.agent_session_id
    AND turn_id = NEW.turn_id
)
BEGIN
  INSERT INTO workspace_agent_turn_sequences (
    workspace_id, agent_session_id, turn_id, turn_sequence, provenance
  )
  SELECT NEW.workspace_id, NEW.agent_session_id, NEW.turn_id,
         COALESCE(MAX(turn_sequence), 0) + 1,
         'legacy_unverified'
  FROM workspace_agent_turn_sequences
  WHERE workspace_id = NEW.workspace_id
    AND agent_session_id = NEW.agent_session_id;
END;

CREATE TABLE workspace_agent_session_fork_operations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
  source_agent_session_id TEXT NOT NULL CHECK (length(source_agent_session_id) > 0),
  target_agent_session_id TEXT NOT NULL CHECK (length(target_agent_session_id) > 0),
  source_provider_session_id TEXT NOT NULL CHECK (length(source_provider_session_id) > 0),
  source_turn_id TEXT NOT NULL CHECK (length(source_turn_id) > 0),
  source_provider_turn_id TEXT NOT NULL CHECK (length(source_provider_turn_id) > 0),
  driver_kind TEXT NOT NULL CHECK (length(driver_kind) > 0),
  driver_version TEXT NOT NULL CHECK (length(driver_version) > 0),
  status TEXT NOT NULL CHECK (status IN (
    'prepared','dispatching','provider_accepted','committed','failed','unknown'
  )),
  target_provider_session_id TEXT,
  snapshot_json TEXT NOT NULL CHECK (
    json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
  ),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) > 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms > 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms > 0),
  dispatched_at_unix_ms INTEGER,
  accepted_at_unix_ms INTEGER,
  completed_at_unix_ms INTEGER,
  UNIQUE (workspace_id, request_id)
);

CREATE INDEX idx_workspace_agent_session_fork_operations_recovery
  ON workspace_agent_session_fork_operations(status, updated_at_unix_ms, operation_id);

CREATE UNIQUE INDEX idx_workspace_agent_session_fork_operations_active_source
  ON workspace_agent_session_fork_operations(workspace_id, source_agent_session_id)
  WHERE status IN ('prepared','dispatching','provider_accepted');

CREATE TABLE workspace_agent_session_fork_target_reservations (
  workspace_id TEXT NOT NULL,
  target_agent_session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, target_agent_session_id),
  UNIQUE (workspace_id, request_id),
  FOREIGN KEY (operation_id)
    REFERENCES workspace_agent_session_fork_operations(operation_id)
);

CREATE TABLE workspace_agent_session_forks (
  workspace_id TEXT NOT NULL,
  target_agent_session_id TEXT NOT NULL,
  source_agent_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  forked_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, target_agent_session_id),
  UNIQUE (operation_id),
  FOREIGN KEY (workspace_id, target_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE,
  FOREIGN KEY (operation_id)
    REFERENCES workspace_agent_session_fork_operations(operation_id)
);
`); err != nil {
		return fmt.Errorf("create workspace agent session fork v1: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v1: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV2 persists the normalized fork point kind on
// every operation. Existing v1 operations are through-Turn operations by
// construction, so the backfill is exact rather than inferred.
func (s *Store) applyWorkspaceAgentSessionForkV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN point_kind TEXT NOT NULL DEFAULT 'through_turn'
CHECK (point_kind IN ('through_turn'));
`); err != nil {
		return fmt.Errorf("add workspace agent session fork point kind: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v2: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV3 adds an explicit client-observation
// handshake. A boundary barrier survives provider dispatch, unknown delivery,
// and an unobserved canonical commit. This prevents a caller that lost the
// committed response (and then restarted with new request identities) from
// creating a second provider child. Observing a committed operation releases
// only that barrier, so a later explicit user action may create another branch
// from the same Turn.
func (s *Store) applyWorkspaceAgentSessionForkV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV3)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v3: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN client_observed_at_unix_ms INTEGER;

CREATE TABLE workspace_agent_session_fork_boundary_barriers (
  workspace_id TEXT NOT NULL,
  source_agent_session_id TEXT NOT NULL,
  point_kind TEXT NOT NULL CHECK (point_kind IN ('through_turn')),
  source_turn_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (
    workspace_id, source_agent_session_id, point_kind, source_turn_id
  ),
  UNIQUE (operation_id),
  FOREIGN KEY (operation_id)
    REFERENCES workspace_agent_session_fork_operations(operation_id)
);

INSERT INTO workspace_agent_session_fork_boundary_barriers (
  workspace_id, source_agent_session_id, point_kind, source_turn_id,
  operation_id, created_at_unix_ms
)
SELECT workspace_id, source_agent_session_id, point_kind, source_turn_id,
       operation_id, created_at_unix_ms
FROM (
  SELECT operation.*,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, source_agent_session_id,
                        point_kind, source_turn_id
           ORDER BY created_at_unix_ms DESC, operation_id DESC
         ) AS boundary_rank
  FROM workspace_agent_session_fork_operations operation
  WHERE status IN (
    'prepared','dispatching','provider_accepted','committed','unknown'
  )
)
WHERE boundary_rank = 1;

UPDATE workspace_agent_session_fork_operations
SET client_observed_at_unix_ms = completed_at_unix_ms
WHERE status = 'committed'
  AND operation_id NOT IN (
    SELECT operation_id
    FROM workspace_agent_session_fork_boundary_barriers
  );
`); err != nil {
		return fmt.Errorf("add workspace agent session fork client observation: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV3); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v3: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV4 records the canonical target Turn at the
// inclusive Fork boundary. Source Turn ids are remapped while cloning, so a
// durable target id lets timeline clients place lineage UI without duplicating
// the canonical id algorithm. Existing lineage rows are backfilled with that
// same deterministic mapping.
func (s *Store) applyWorkspaceAgentSessionForkV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v4: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN target_turn_id TEXT;

ALTER TABLE workspace_agent_session_forks
ADD COLUMN target_turn_id TEXT;
`); err != nil {
		return fmt.Errorf("add workspace agent session fork target turn: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, operation_id, source_agent_session_id,
       target_agent_session_id, source_turn_id
FROM workspace_agent_session_fork_operations
WHERE status = 'committed'
`)
	if err != nil {
		return fmt.Errorf("read workspace agent session fork target turn backfill: %w", err)
	}
	type targetTurnBackfill struct {
		workspaceID, operationID, sourceSessionID, targetSessionID, sourceTurnID string
	}
	var backfills []targetTurnBackfill
	for rows.Next() {
		var backfill targetTurnBackfill
		if err := rows.Scan(
			&backfill.workspaceID,
			&backfill.operationID,
			&backfill.sourceSessionID,
			&backfill.targetSessionID,
			&backfill.sourceTurnID,
		); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan workspace agent session fork target turn backfill: %w", err)
		}
		backfills = append(backfills, backfill)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workspace agent session fork target turn backfill: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate workspace agent session fork target turn backfill: %w", err)
	}
	for _, backfill := range backfills {
		operation := SessionForkOperation{
			WorkspaceID:          backfill.workspaceID,
			OperationID:          backfill.operationID,
			SourceAgentSessionID: backfill.sourceSessionID,
			TargetAgentSessionID: backfill.targetSessionID,
		}
		targetTurnID := deterministicSessionForkCanonicalID(
			operation,
			"turn",
			backfill.sourceTurnID,
		)
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_forks
SET target_turn_id = ?
WHERE workspace_id = ? AND operation_id = ?
`, targetTurnID, backfill.workspaceID, backfill.operationID); err != nil {
			return fmt.Errorf("backfill workspace agent session fork target turn: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET target_turn_id = ?
WHERE workspace_id = ? AND operation_id = ? AND status = 'committed'
`, targetTurnID, backfill.workspaceID, backfill.operationID); err != nil {
			return fmt.Errorf("backfill workspace agent session fork operation target turn: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV4); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v4: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV5 persists the provider identities created by
// a native fork. Claude's official SDK remaps every transcript UUID, so the
// canonical child must not retain source provider-turn identities.
func (s *Store) applyWorkspaceAgentSessionForkV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV5)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v5: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN target_title TEXT NOT NULL DEFAULT '';

ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN target_provider_turn_ids_json TEXT NOT NULL DEFAULT '[]'
CHECK (
  json_valid(target_provider_turn_ids_json)
  AND json_type(target_provider_turn_ids_json) = 'array'
);

ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN provider_state_binding_mode TEXT NOT NULL DEFAULT '';

ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN provider_state_binding_receipt TEXT NOT NULL DEFAULT '';

UPDATE workspace_agent_session_fork_operations
SET provider_state_binding_mode = 'host_copy'
WHERE TRIM(COALESCE(target_provider_session_id, '')) <> '';
`); err != nil {
		return fmt.Errorf("add workspace agent session fork provider mapping: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV5); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v5: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV6 is the intentional hard cutover to
// optimistic Fork. It refuses to migrate while an old saga is non-terminal,
// then replaces the source-wide constraint with an exact active-boundary
// constraint. Different Turns can Fork independently while one Turn cannot
// dispatch two provider mutations concurrently.
func (s *Store) applyWorkspaceAgentSessionForkV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV6)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v6: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var nonterminal int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_agent_session_fork_operations
WHERE status IN ('prepared','dispatching','provider_accepted')
`).Scan(&nonterminal); err != nil {
		return fmt.Errorf("count nonterminal session forks before v6: %w", err)
	}
	if nonterminal != 0 {
		return fmt.Errorf(
			"workspace agent session fork v6 requires draining %d nonterminal operations",
			nonterminal,
		)
	}
	if _, err := tx.ExecContext(ctx, `
DROP INDEX IF EXISTS idx_workspace_agent_session_fork_operations_active_source;

CREATE UNIQUE INDEX idx_workspace_agent_session_fork_operations_active_boundary
  ON workspace_agent_session_fork_operations(
    workspace_id, source_agent_session_id, point_kind, source_turn_id
  )
  WHERE status IN ('prepared','dispatching','provider_accepted');
`); err != nil {
		return fmt.Errorf("replace session fork active-source constraint: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV6); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v6: %w", err)
	}
	return nil
}

// applyWorkspaceAgentSessionForkV7 stores the complete provider-owned child
// Turn/checkpoint mapping as one ordered receipt. Existing committed
// operations retain only their historical boundary receipt so idempotent
// reads remain possible; their already-materialized child Turns are not
// backfilled.
func (s *Store) applyWorkspaceAgentSessionForkV7(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionForkV7)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session fork v7: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var nonterminal int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_agent_session_fork_operations
WHERE status IN ('prepared','dispatching','provider_accepted')
`).Scan(&nonterminal); err != nil {
		return fmt.Errorf("count nonterminal session forks before v7: %w", err)
	}
	if nonterminal != 0 {
		return fmt.Errorf(
			"workspace agent session fork v7 requires draining %d nonterminal operations",
			nonterminal,
		)
	}
	hasSourceBindingJSON, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"source_provider_turn_binding_json",
	)
	if err != nil {
		return err
	}
	if !hasSourceBindingJSON {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN source_provider_turn_binding_json TEXT NOT NULL DEFAULT '{}'
CHECK (
  json_valid(source_provider_turn_binding_json)
  AND json_type(source_provider_turn_binding_json) = 'object'
);
`); err != nil {
			return fmt.Errorf(
				"add session fork source provider binding json: %w",
				err,
			)
		}
	}
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN target_provider_turn_bindings_json TEXT NOT NULL DEFAULT '[]'
CHECK (
  json_valid(target_provider_turn_bindings_json)
  AND json_type(target_provider_turn_bindings_json) = 'array'
);
`); err != nil {
		return fmt.Errorf("add workspace agent session fork full turn bindings: %w", err)
	}
	hasLegacyCheckpoint, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"target_provider_checkpoint_message_id",
	)
	if err != nil {
		return err
	}
	if hasLegacyCheckpoint {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET target_provider_turn_bindings_json = json_array(
  json_object(
    'providerTurnId',
    json_extract(target_provider_turn_ids_json, '$[#-1]'),
    'providerTurnBindingJson',
    json_object(
      'schemaVersion', 1,
      'checkpointMessageId', target_provider_checkpoint_message_id
    )
  )
)
WHERE provider_state_binding_mode = 'provider_owned'
  AND json_array_length(target_provider_turn_ids_json) > 0
  AND TRIM(COALESCE(target_provider_checkpoint_message_id, '')) <> '';
`); err != nil {
			return fmt.Errorf(
				"backfill legacy session fork provider binding json: %w",
				err,
			)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionForkV7); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session fork v7: %w", err)
	}
	return nil
}
