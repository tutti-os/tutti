package workspace

import (
	"context"
	"fmt"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func (s *SQLiteStore) applyWorkspaceIssuesV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV3)
	if err != nil {
		return err
	}
	now := unixMs(time.Now().UTC())
	v3SchemaPresent, err := s.hasWorkspaceIssuesV3Schema(ctx)
	if err != nil {
		return err
	}
	if applied && v3SchemaPresent {
		return s.ensureDefaultIssueTopics(ctx)
	}
	if v3SchemaPresent {
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV3, now); err != nil {
			return fmt.Errorf("record workspace issue topics migration: %w", err)
		}
		return s.ensureDefaultIssueTopics(ctx)
	}

	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable sqlite foreign keys for workspace issue topics migration: %w", err)
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), `PRAGMA foreign_keys = ON`)
	}()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace issue topics migration: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	_, err = tx.ExecContext(ctx, `
DROP TRIGGER IF EXISTS trg_workspace_issue_tasks_delete_context_refs;
DROP INDEX IF EXISTS idx_workspace_issues_workspace_updated;
DROP INDEX IF EXISTS idx_workspace_issues_workspace_status;
DROP INDEX IF EXISTS idx_workspace_issue_tasks_issue_sort;
DROP INDEX IF EXISTS idx_workspace_issue_tasks_issue_status;
DROP INDEX IF EXISTS idx_workspace_issue_context_refs_parent;
DROP INDEX IF EXISTS idx_workspace_issue_runs_task_created;
DROP INDEX IF EXISTS idx_workspace_issue_run_outputs_run;

ALTER TABLE workspace_issue_run_outputs RENAME TO workspace_issue_run_outputs_v2;
ALTER TABLE workspace_issue_runs RENAME TO workspace_issue_runs_v2;
ALTER TABLE workspace_issue_context_refs RENAME TO workspace_issue_context_refs_v2;
ALTER TABLE workspace_issue_tasks RENAME TO workspace_issue_tasks_v2;
ALTER TABLE workspace_issues RENAME TO workspace_issues_v2;

CREATE TABLE workspace_issue_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  last_activity_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, topic_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_workspace_issue_topics_default
  ON workspace_issue_topics(workspace_id)
  WHERE is_default = 1;
CREATE INDEX idx_workspace_issue_topics_workspace_activity
  ON workspace_issue_topics(
    workspace_id,
    pinned_at_unix_ms DESC,
    last_activity_at_unix_ms DESC,
    id DESC
  );

INSERT INTO workspace_issue_topics (
  topic_id, workspace_id, title, summary, is_default, pinned_at_unix_ms,
  last_activity_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  'default',
  workspaces.id,
  'default',
  '',
  1,
  0,
  COALESCE(MAX(workspace_issues_v2.updated_at_unix_ms), ?),
  ?,
  ?
FROM workspaces
LEFT JOIN workspace_issues_v2 ON workspace_issues_v2.workspace_id = workspaces.id
GROUP BY workspaces.id;

CREATE TABLE workspace_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  not_started_count INTEGER NOT NULL DEFAULT 0,
  running_count INTEGER NOT NULL DEFAULT 0,
  pending_acceptance_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  canceled_count INTEGER NOT NULL DEFAULT 0,
  creator_user_id TEXT NOT NULL DEFAULT '',
  creator_display_name TEXT NOT NULL DEFAULT '',
  creator_avatar_url TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES workspace_issue_topics(workspace_id, topic_id) ON DELETE RESTRICT
);
CREATE INDEX idx_workspace_issues_workspace_topic_updated
  ON workspace_issues(workspace_id, topic_id, updated_at_unix_ms DESC, id DESC);
CREATE INDEX idx_workspace_issues_workspace_topic_status
  ON workspace_issues(workspace_id, topic_id, status);

INSERT INTO workspace_issues (
  id, issue_id, topic_id, workspace_id, title, content, search_text, status,
  task_count, not_started_count, running_count, pending_acceptance_count,
  completed_count, failed_count, canceled_count, creator_user_id,
  creator_display_name, creator_avatar_url, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  id, issue_id, 'default', workspace_id, title, content, search_text, status,
  task_count, not_started_count, running_count, pending_acceptance_count,
  completed_count, failed_count, canceled_count, creator_user_id,
  creator_display_name, creator_avatar_url, created_at_unix_ms, updated_at_unix_ms
FROM workspace_issues_v2;

CREATE TABLE workspace_issue_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  due_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  creator_user_id TEXT NOT NULL DEFAULT '',
  creator_display_name TEXT NOT NULL DEFAULT '',
  creator_avatar_url TEXT NOT NULL DEFAULT '',
  latest_run_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_tasks_issue_sort
  ON workspace_issue_tasks(workspace_id, issue_id, sort_index ASC, id ASC);
CREATE INDEX idx_workspace_issue_tasks_issue_status
  ON workspace_issue_tasks(workspace_id, issue_id, status);
INSERT INTO workspace_issue_tasks
SELECT * FROM workspace_issue_tasks_v2;

CREATE TABLE workspace_issue_context_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_ref_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  parent_kind TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, context_ref_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_context_refs_parent
  ON workspace_issue_context_refs(workspace_id, issue_id, task_id, parent_kind, created_at_unix_ms ASC, id ASC);
INSERT INTO workspace_issue_context_refs
SELECT * FROM workspace_issue_context_refs_v2;

CREATE TABLE workspace_issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL DEFAULT '',
  agent_user_id TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  agent_provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  output_dir TEXT NOT NULL DEFAULT '',
  execution_directory TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_runs_task_created
  ON workspace_issue_runs(workspace_id, issue_id, task_id, created_at_unix_ms DESC, id DESC);
INSERT INTO workspace_issue_runs (
  id, run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  agent_target_id, agent_session_id, agent_provider, status, summary,
  error_message, output_dir, execution_directory, created_at_unix_ms,
  started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
)
SELECT
  id, run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  '', agent_session_id, agent_provider, status, summary, error_message,
  output_dir, '', created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  updated_at_unix_ms
FROM workspace_issue_runs_v2;

CREATE TABLE workspace_issue_run_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id, output_id),
  FOREIGN KEY (workspace_id, issue_id, task_id, run_id) REFERENCES workspace_issue_runs(workspace_id, issue_id, task_id, run_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_run_outputs_run
  ON workspace_issue_run_outputs(workspace_id, issue_id, task_id, run_id, created_at_unix_ms ASC, id ASC);
INSERT INTO workspace_issue_run_outputs
SELECT * FROM workspace_issue_run_outputs_v2;

CREATE TRIGGER trg_workspace_issue_tasks_delete_context_refs
AFTER DELETE ON workspace_issue_tasks
BEGIN
  DELETE FROM workspace_issue_context_refs
  WHERE workspace_id = OLD.workspace_id
    AND issue_id = OLD.issue_id
    AND task_id = OLD.task_id
    AND parent_kind = 'task';
END;

DROP TABLE workspace_issue_run_outputs_v2;
DROP TABLE workspace_issue_runs_v2;
DROP TABLE workspace_issue_context_refs_v2;
DROP TABLE workspace_issue_tasks_v2;
DROP TABLE workspace_issues_v2;
`, now, now, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for issue manager topics: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV3, now); err != nil {
		return fmt.Errorf("record workspace issue topics migration: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace issue topics migration: %w", err)
	}

	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("re-enable sqlite foreign keys for workspace issue topics migration: %w", err)
	}

	return s.ensureDefaultIssueTopics(ctx)
}

func (s *SQLiteStore) applyWorkspaceIssuesV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV4)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasExecutionDirectory, err := s.hasColumn(ctx, "workspace_issue_runs", "execution_directory")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasExecutionDirectory {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_issue_runs ADD COLUMN execution_directory TEXT NOT NULL DEFAULT '';`); err != nil {
			return fmt.Errorf("migrate workspace issue runs execution directory: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV4, now); err != nil {
		return fmt.Errorf("record workspace issues v4 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceIssuesV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV5)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasAgentTargetID, err := s.hasColumn(ctx, "workspace_issue_runs", "agent_target_id")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasAgentTargetID {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_issue_runs ADD COLUMN agent_target_id TEXT NOT NULL DEFAULT '';`); err != nil {
			return fmt.Errorf("migrate workspace issue runs agent target id: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_issue_runs
SET agent_target_id = CASE agent_provider
  WHEN 'codex' THEN 'local:codex'
  WHEN 'claude-code' THEN 'local:claude-code'
  ELSE agent_target_id
END
WHERE agent_target_id = '';
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV5, now); err != nil {
		return fmt.Errorf("record workspace issues v5 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) ensureDefaultIssueTopics(ctx context.Context) error {
	now := unixMs(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET is_default = 1, updated_at_unix_ms = ?
WHERE topic_id = ?
  AND is_default = 0
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_issue_topics existing
    WHERE existing.workspace_id = workspace_issue_topics.workspace_id
      AND existing.is_default = 1
  );
`, now, workspaceissues.DefaultTopicID); err != nil {
		return fmt.Errorf("repair default workspace issue topic flags: %w", err)
	}

	if _, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_issue_topics (
  topic_id, workspace_id, title, summary, is_default, pinned_at_unix_ms,
  last_activity_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  ?,
  workspaces.id,
  ?,
  '',
  1,
  0,
  COALESCE(MAX(workspace_issues.updated_at_unix_ms), ?),
  ?,
  ?
FROM workspaces
LEFT JOIN workspace_issues ON workspace_issues.workspace_id = workspaces.id
WHERE NOT EXISTS (
  SELECT 1
  FROM workspace_issue_topics existing
  WHERE existing.workspace_id = workspaces.id
    AND existing.is_default = 1
)
GROUP BY workspaces.id;
`, workspaceissues.DefaultTopicID, workspaceissues.DefaultTopicID, now, now, now); err != nil {
		return fmt.Errorf("ensure default workspace issue topics: %w", err)
	}

	return nil
}

func (s *SQLiteStore) hasWorkspaceIssuesV3Schema(ctx context.Context) (bool, error) {
	hasIssueTopicID, err := s.hasColumn(ctx, "workspace_issues", "topic_id")
	if err != nil {
		return false, err
	}
	hasTopicTopicID, err := s.hasColumn(ctx, "workspace_issue_topics", "topic_id")
	if err != nil {
		return false, err
	}
	return hasIssueTopicID && hasTopicTopicID, nil
}
