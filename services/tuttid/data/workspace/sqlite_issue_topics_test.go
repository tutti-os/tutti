package workspace

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreCreateWorkspaceCreatesDefaultIssueTopic(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-default-topic",
		Name: "Default Topic Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	topics, err := store.ListTopics(ctx, "ws-default-topic")
	if err != nil {
		t.Fatalf("ListTopics() error = %v", err)
	}
	if len(topics.Items) != 1 {
		t.Fatalf("topics len = %d, want 1: %+v", len(topics.Items), topics.Items)
	}
	topic := topics.Items[0]
	if topic.TopicID != workspaceissues.DefaultTopicID || !topic.IsDefault {
		t.Fatalf("default topic = %+v", topic)
	}
}

func TestSQLiteStoreDeleteIssueTopic(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-delete-topic",
		Name: "Delete Topic Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	if _, err := store.CreateTopic(ctx, workspaceissues.Topic{
		TopicID:              "topic-delete",
		WorkspaceID:          "ws-delete-topic",
		Title:                "Delete me",
		LastActivityAtUnixMS: 100,
		CreatedAtUnixMS:      100,
		UpdatedAtUnixMS:      100,
	}); err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}

	removed, err := store.DeleteTopic(ctx, "ws-delete-topic", "topic-delete")
	if err != nil {
		t.Fatalf("DeleteTopic() error = %v", err)
	}
	if !removed {
		t.Fatal("DeleteTopic() removed = false, want true")
	}
	if _, err := store.GetTopic(ctx, "ws-delete-topic", "topic-delete"); err != workspaceissues.ErrTopicNotFound {
		t.Fatalf("GetTopic() after delete error = %v, want ErrTopicNotFound", err)
	}
}

func TestSQLiteStoreIssueTopicsMigrationRepairsMissingDefaultTopic(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-repair-default-topic",
		Name: "Repair Default Topic Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM workspace_issue_topics
WHERE workspace_id = ?;
`, "ws-repair-default-topic"); err != nil {
		t.Fatalf("delete default topic fixture: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() repair error = %v", err)
	}

	topics, err := store.ListTopics(ctx, "ws-repair-default-topic")
	if err != nil {
		t.Fatalf("ListTopics() error = %v", err)
	}
	if len(topics.Items) != 1 {
		t.Fatalf("topics len = %d, want 1: %+v", len(topics.Items), topics.Items)
	}
	topic := topics.Items[0]
	if topic.TopicID != workspaceissues.DefaultTopicID || !topic.IsDefault {
		t.Fatalf("default topic = %+v", topic)
	}
}

func TestSQLiteStoreIssueTopicsMigrationBackfillsLegacyIssues(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	createLegacyIssueV2Database(t, dbPath)

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	ctx := context.Background()
	topics, err := store.ListTopics(ctx, "ws-legacy-topic")
	if err != nil {
		t.Fatalf("ListTopics() error = %v", err)
	}
	if len(topics.Items) != 1 {
		t.Fatalf("topics len = %d, want 1: %+v", len(topics.Items), topics.Items)
	}
	topic := topics.Items[0]
	if topic.TopicID != workspaceissues.DefaultTopicID || !topic.IsDefault {
		t.Fatalf("default topic = %+v", topic)
	}

	issue, err := store.GetIssue(ctx, "ws-legacy-topic", "issue-legacy")
	if err != nil {
		t.Fatalf("GetIssue() error = %v", err)
	}
	if issue.TopicID != workspaceissues.DefaultTopicID {
		t.Fatalf("issue topic id = %q, want %q", issue.TopicID, workspaceissues.DefaultTopicID)
	}
}

func TestSQLiteStoreIssueTopicsMigrationIsIdempotent(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	createLegacyIssueV2Database(t, dbPath)

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() first error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() second error = %v", err)
	}

	applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceIssuesV3)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatalf("migration %q was not recorded", schemaMigrationWorkspaceIssuesV3)
	}
}

func TestSQLiteStoreIssueTopicsMigrationRepairsMissingMarker(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	createLegacyIssueV2Database(t, dbPath)

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() initial error = %v", err)
	}

	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?;
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES ('1780543054474', 1780543054474);
`, schemaMigrationWorkspaceIssuesV3); err != nil {
		t.Fatalf("simulate missing migration marker: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() repair error = %v", err)
	}

	applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceIssuesV3)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatalf("migration %q was not repaired", schemaMigrationWorkspaceIssuesV3)
	}
}

func createLegacyIssueV2Database(t *testing.T, dbPath string) {
	t.Helper()

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspaces_v1', 1),
  ('workspaces_v2', 1),
  ('workspaces_v3', 1),
  ('workspaces_v4', 1),
  ('workspace_issues_v1', 1),
  ('workspace_issues_v2', 1);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_opened_at_unix_ms INTEGER
);
CREATE TABLE workspace_workbench_snapshots (
  workspace_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE workspace_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
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
  UNIQUE(workspace_id, issue_id)
);
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
  UNIQUE(workspace_id, issue_id, task_id)
);
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
  UNIQUE(workspace_id, context_ref_id)
);
CREATE TABLE workspace_issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL DEFAULT '',
  agent_user_id TEXT NOT NULL DEFAULT '',
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
  UNIQUE(workspace_id, issue_id, task_id, run_id)
);
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
  UNIQUE(workspace_id, issue_id, task_id, run_id, output_id)
);

INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms)
VALUES ('ws-legacy-topic', 'Legacy Topic Workspace', 10, 10, NULL);
INSERT INTO workspace_issues (
  issue_id, workspace_id, title, content, search_text, status,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (
  'issue-legacy', 'ws-legacy-topic', 'Legacy issue', '', '', 'not_started', 20, 30
);
`)
	if err != nil {
		t.Fatalf("create legacy issue db: %v", err)
	}
}
