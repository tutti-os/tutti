package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentSubmitClaimsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV1)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_submit_claims (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  client_submit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','accepted')),
  turn_id TEXT,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, client_submit_id),
  CHECK ((status = 'prepared' AND turn_id IS NULL)
      OR (status = 'accepted' AND length(turn_id) > 0))
);`); err != nil {
		return fmt.Errorf("create workspace agent submit claims: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV1)
}

// V2 adds an immutable canonical turn binding without rebuilding the v1
// table. The v1 turn_id column remains the accepted result, while
// canonical_turn_id is written before dispatch and survives an ambiguous
// delivery so retries can never allocate or send a second turn.
//
// This index is deliberately non-unique: an initial submit and any number of
// guidance submits may all belong to the same active canonical turn.
func (s *Store) applyWorkspaceAgentSubmitClaimsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent submit claims v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_submit_claims ADD COLUMN canonical_turn_id TEXT;
UPDATE workspace_agent_submit_claims
SET canonical_turn_id = turn_id
WHERE status = 'accepted' AND turn_id IS NOT NULL AND length(trim(turn_id)) > 0;
CREATE INDEX IF NOT EXISTS idx_workspace_agent_submit_claims_canonical_turn
  ON workspace_agent_submit_claims(workspace_id, agent_session_id, canonical_turn_id);
`); err != nil {
		return fmt.Errorf("migrate workspace agent submit claims v2: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSubmitClaimsV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent submit claims v2: %w", err)
	}
	return nil
}

// V3 makes an explicit provider rejection a terminal submit-claim state. The
// v1 CHECK constraint cannot be altered in place by SQLite, so rebuild the
// small claim table while preserving the immutable canonical-turn binding.
func (s *Store) applyWorkspaceAgentSubmitClaimsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV3)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent submit claims v3: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
DROP INDEX IF EXISTS idx_workspace_agent_submit_claims_canonical_turn;
ALTER TABLE workspace_agent_submit_claims RENAME TO workspace_agent_submit_claims_v2;
CREATE TABLE workspace_agent_submit_claims (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  client_submit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','accepted','rejected')),
  turn_id TEXT,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  canonical_turn_id TEXT,
  PRIMARY KEY (workspace_id, agent_session_id, client_submit_id),
  CHECK ((status = 'prepared' AND turn_id IS NULL)
      OR (status IN ('accepted','rejected') AND length(turn_id) > 0))
);
INSERT INTO workspace_agent_submit_claims (
  workspace_id, agent_session_id, client_submit_id, status, turn_id,
  created_at_unix_ms, updated_at_unix_ms, canonical_turn_id
)
SELECT workspace_id, agent_session_id, client_submit_id, status, turn_id,
       created_at_unix_ms, updated_at_unix_ms, canonical_turn_id
FROM workspace_agent_submit_claims_v2;
DROP TABLE workspace_agent_submit_claims_v2;
CREATE INDEX idx_workspace_agent_submit_claims_canonical_turn
  ON workspace_agent_submit_claims(workspace_id, agent_session_id, canonical_turn_id);
`); err != nil {
		return fmt.Errorf("migrate workspace agent submit claims v3: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSubmitClaimsV3); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent submit claims v3: %w", err)
	}
	return nil
}

// V4 retains the small submission-metadata envelope that must cross the
// provider-admission barrier. The complete TurnSubmission is still persisted
// after Exec, but metadata needed by durable post-commit consumers must survive
// a process crash between provider settlement and that later envelope write.
func (s *Store) applyWorkspaceAgentSubmitClaimsV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent submit claims v4 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	hasMetadata, err := hasColumnTx(ctx, tx, "workspace_agent_submit_claims", "metadata_json")
	if err != nil {
		return err
	}
	if !hasMetadata {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_submit_claims
  ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object');
`); err != nil {
			return fmt.Errorf("migrate workspace agent submit claims v4: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSubmitClaimsV4); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent submit claims v4 migration: %w", err)
	}
	return nil
}
