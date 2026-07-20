package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentEventSubscriptionsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentEventSubscriptionsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent event subscriptions v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subscriber_agent_session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_subject_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','matched','canceled')),
  matched_event_id TEXT,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, subscriber_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_agent_event_subscriptions_match
  ON workspace_agent_event_subscriptions(workspace_id, source_kind, source_id, event_type, event_version, status, created_at_unix_ms);
CREATE INDEX idx_workspace_agent_event_subscriptions_subscriber
  ON workspace_agent_event_subscriptions(workspace_id, subscriber_agent_session_id, created_at_unix_ms DESC);

CREATE TABLE workspace_agent_event_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  subscriber_agent_session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('prepared','leased','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  UNIQUE (event_id, subscription_id),
  FOREIGN KEY (subscription_id) REFERENCES workspace_agent_event_subscriptions(subscription_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, subscriber_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_agent_event_deliveries_claim
  ON workspace_agent_event_deliveries(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms);
`); err != nil {
		return fmt.Errorf("create workspace agent event subscription tables: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentEventSubscriptionsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent event subscriptions v1: %w", err)
	}
	return nil
}
