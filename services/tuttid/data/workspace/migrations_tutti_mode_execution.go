package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceTuttiModeExecutionV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceTuttiModeExecutionV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace Tutti mode execution migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
CREATE TABLE workspace_tutti_executions (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review',
    'orphaned_source', 'completed', 'archiving', 'archived'
  )),
  graph_revision INTEGER NOT NULL CHECK (graph_revision > 0),
  last_orchestrator_activity_at_unix_ms INTEGER NOT NULL,
  watchdog_due_at_unix_ms INTEGER NOT NULL,
  review_mode TEXT NOT NULL CHECK (review_mode IN ('self', 'independent')),
  review_agent_target_id TEXT NOT NULL DEFAULT '',
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  archived_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  archived_by TEXT NOT NULL DEFAULT '',
  archive_reason TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, execution_id),
  UNIQUE (workspace_id, issue_id),
  UNIQUE (workspace_id, workflow_id),
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workspace_workflows(workspace_id, workflow_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_tutti_executions_source_status
  ON workspace_tutti_executions(workspace_id, source_session_id, status, updated_at_unix_ms);

CREATE TABLE workspace_tutti_execution_checkpoints (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'initial_schedule', 'task_settled', 'task_failed', 'task_canceled',
    'watchdog', 'all_tasks_terminal', 'migration'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'resolved', 'superseded', 'canceled')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  graph_revision INTEGER NOT NULL CHECK (graph_revision > 0),
  subject_task_id TEXT NOT NULL DEFAULT '',
  subject_run_id TEXT NOT NULL DEFAULT '',
  creation_reason TEXT NOT NULL,
  requires_goal_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_goal_review IN (0, 1)),
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  resolved_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, execution_id, checkpoint_id),
  UNIQUE (workspace_id, execution_id, sequence),
  FOREIGN KEY (workspace_id, execution_id)
    REFERENCES workspace_tutti_executions(workspace_id, execution_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_workspace_tutti_execution_checkpoints_one_active
  ON workspace_tutti_execution_checkpoints(workspace_id, execution_id)
  WHERE status = 'active';

CREATE INDEX idx_workspace_tutti_execution_checkpoints_backlog
  ON workspace_tutti_execution_checkpoints(workspace_id, execution_id, status, sequence);

CREATE TABLE workspace_tutti_execution_wakes (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  wake_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('main', 'reviewer')),
  wake_sequence INTEGER NOT NULL CHECK (wake_sequence > 0),
  client_submit_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL DEFAULT '',
  review_agent_target_id TEXT NOT NULL DEFAULT '',
  canonical_session_id TEXT NOT NULL DEFAULT '',
  canonical_turn_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'leased', 'dispatched', 'turn_settled',
    'acknowledged', 'failed', 'canceled'
  )),
  due_at_unix_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  dispatched_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  turn_settled_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  acknowledged_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, execution_id, wake_id),
  UNIQUE (workspace_id, client_submit_id),
  UNIQUE (workspace_id, execution_id, checkpoint_id, target_kind, wake_sequence),
  FOREIGN KEY (workspace_id, execution_id, checkpoint_id)
    REFERENCES workspace_tutti_execution_checkpoints(workspace_id, execution_id, checkpoint_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_tutti_execution_wakes_due
  ON workspace_tutti_execution_wakes(workspace_id, status, due_at_unix_ms, lease_expires_at_unix_ms);

CREATE TABLE workspace_tutti_goal_reviews (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  review_agent_target_id TEXT NOT NULL DEFAULT '',
  review_session_id TEXT NOT NULL DEFAULT '',
  review_turn_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatched', 'submitted', 'failed', 'canceled')),
  verdict TEXT NOT NULL DEFAULT '' CHECK (verdict IN ('', 'goal_satisfied', 'more_work_required', 'inconclusive')),
  summary TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  submitted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, execution_id, review_id),
  UNIQUE (workspace_id, execution_id, checkpoint_id),
  FOREIGN KEY (workspace_id, execution_id, checkpoint_id)
    REFERENCES workspace_tutti_execution_checkpoints(workspace_id, execution_id, checkpoint_id) ON DELETE CASCADE
);

CREATE TABLE workspace_tutti_archive_operations (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'canceling_runs', 'archiving', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, execution_id, operation_id),
  UNIQUE (workspace_id, execution_id, request_id),
  FOREIGN KEY (workspace_id, execution_id)
    REFERENCES workspace_tutti_executions(workspace_id, execution_id) ON DELETE CASCADE
);

CREATE TABLE workspace_tutti_execution_mutations (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'mutate', 'complete', 'acknowledge')),
  request_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  checkpoint_id TEXT NOT NULL,
  expected_graph_revision INTEGER NOT NULL CHECK (expected_graph_revision > 0),
  result_graph_revision INTEGER NOT NULL CHECK (result_graph_revision > 0),
  result_json TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_session_id, kind, issue_id, request_id),
  UNIQUE (workspace_id, execution_id, kind, request_id),
  FOREIGN KEY (workspace_id, execution_id, checkpoint_id)
    REFERENCES workspace_tutti_execution_checkpoints(workspace_id, execution_id, checkpoint_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);

CREATE TABLE workspace_source_session_deletion_admissions (
  workspace_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  closure_sha256 TEXT NOT NULL CHECK (length(closure_sha256) = 64),
  closure_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'admitted', 'superseded', 'released', 'finalized')),
  protected_issue_ids_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  finalized_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, admission_id),
  UNIQUE (workspace_id, closure_sha256),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE workspace_issue_run_launch_intents (
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  launch_intent_id TEXT NOT NULL,
  client_submit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'leased', 'dispatched', 'failed', 'canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  canonical_session_id TEXT NOT NULL DEFAULT '',
  canonical_turn_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  dispatched_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, issue_id, task_id, run_id, launch_intent_id),
  UNIQUE (workspace_id, client_submit_id),
  UNIQUE (workspace_id, issue_id, task_id, run_id),
  FOREIGN KEY (workspace_id, issue_id, task_id, run_id)
    REFERENCES workspace_issue_runs(workspace_id, issue_id, task_id, run_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_issue_run_launch_intents_due
  ON workspace_issue_run_launch_intents(workspace_id, status, lease_expires_at_unix_ms);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceTuttiModeExecutionV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate workspace Tutti mode execution: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace Tutti mode execution migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceTuttiModeRunCancelCompensationV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceTuttiModeRunCancelCompensationV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode Run cancel compensation migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_issue_run_cancel_compensations (
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  client_submit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'leased', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, issue_id, task_id, run_id),
  UNIQUE (workspace_id, client_submit_id),
  FOREIGN KEY (workspace_id, issue_id, task_id, run_id)
    REFERENCES workspace_issue_runs(workspace_id, issue_id, task_id, run_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_issue_run_cancel_compensations_due
  ON workspace_issue_run_cancel_compensations(
    workspace_id, status, lease_expires_at_unix_ms
  );

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceTuttiModeRunCancelCompensationV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate Tutti mode Run cancel compensation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode Run cancel compensation migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceTuttiModeSourceActivityInboxV3(
	ctx context.Context,
) error {
	applied, err := s.hasMigration(
		ctx, schemaMigrationWorkspaceTuttiModeSourceActivityInboxV3,
	)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode source activity inbox migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_tutti_source_activity_inbox (
  mutation_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('message', 'turn')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_tutti_source_activity_inbox_scope
  ON workspace_tutti_source_activity_inbox(
    workspace_id, agent_session_id, entity_kind
  );

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceTuttiModeSourceActivityInboxV3,
		unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate Tutti mode source activity inbox: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode source activity inbox migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceTuttiModeGoalReviewV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceTuttiModeGoalReviewV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode Goal Review migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_tutti_goal_reviews
  ADD COLUMN client_submit_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_tutti_goal_reviews
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE workspace_tutti_goal_reviews
  ADD COLUMN lease_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_tutti_goal_reviews
  ADD COLUMN lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0;

UPDATE workspace_tutti_goal_reviews
SET client_submit_id = 'tutti-goal-review:' || review_id,
    review_session_id = CASE
      WHEN review_session_id = '' THEN review_id || ':session'
      ELSE review_session_id
    END;

CREATE UNIQUE INDEX idx_workspace_tutti_goal_reviews_submit
  ON workspace_tutti_goal_reviews(workspace_id, client_submit_id);
CREATE INDEX idx_workspace_tutti_goal_reviews_due
  ON workspace_tutti_goal_reviews(
    workspace_id, status, lease_expires_at_unix_ms
  );

CREATE TABLE workspace_tutti_goal_review_audit (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  review_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, execution_id, audit_id),
  FOREIGN KEY (workspace_id, execution_id)
    REFERENCES workspace_tutti_executions(workspace_id, execution_id) ON DELETE CASCADE
);

CREATE TABLE workspace_tutti_goal_review_mutations (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('complete', 'verdict', 'switch_to_self')),
  request_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  checkpoint_id TEXT NOT NULL,
  expected_graph_revision INTEGER NOT NULL CHECK (expected_graph_revision > 0),
  result_json TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, kind, issue_id, request_id),
  UNIQUE (workspace_id, execution_id, kind, request_id),
  FOREIGN KEY (workspace_id, execution_id, checkpoint_id)
    REFERENCES workspace_tutti_execution_checkpoints(
      workspace_id, execution_id, checkpoint_id
    ) ON DELETE CASCADE
);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceTuttiModeGoalReviewV4, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate Tutti mode Goal Review: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode Goal Review migration: %w", err)
	}
	return nil
}
