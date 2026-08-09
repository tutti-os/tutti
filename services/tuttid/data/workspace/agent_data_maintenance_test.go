package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func enqueueAgentSessionResourceCleanupForTest(
	t *testing.T,
	store *SQLiteStore,
	ctx context.Context,
	items []AgentSessionResourceCleanup,
) {
	t.Helper()
	tx, err := store.writeDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin cleanup queue seed: %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := enqueueAgentSessionResourceCleanupTx(ctx, tx, items); err != nil {
		t.Fatalf("seed cleanup queue: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit cleanup queue seed: %v", err)
	}
}

func TestAgentDataMaintenanceStatePersistsAutomaticCompletion(t *testing.T) {
	t.Parallel()
	store := openTestSQLiteStore(t)
	ctx := context.Background()

	initial, err := store.GetAgentDataMaintenanceState(ctx)
	if err != nil || initial.LastAutomaticPurgeAtUnixMS != 0 {
		t.Fatalf("initial state = %#v, error = %v", initial, err)
	}
	if err := store.MarkAutomaticAgentDataPurgeCompleted(ctx, 1234); err != nil {
		t.Fatalf("MarkAutomaticAgentDataPurgeCompleted() error = %v", err)
	}
	stored, err := store.GetAgentDataMaintenanceState(ctx)
	if err != nil || stored.LastAutomaticPurgeAtUnixMS != 1234 {
		t.Fatalf("stored state = %#v, error = %v", stored, err)
	}
}

func TestAgentSessionResourceCleanupQueueRetriesUntilCompleted(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	item := AgentSessionResourceCleanup{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	}
	enqueueAgentSessionResourceCleanupForTest(t, store, ctx, []AgentSessionResourceCleanup{item})
	if err := store.FailAgentSessionResourceCleanup(ctx, item.WorkspaceID, item.AgentSessionID, "temporary failure"); err != nil {
		t.Fatalf("FailAgentSessionResourceCleanup() error = %v", err)
	}
	queued, err := store.ListAgentSessionResourceCleanup(ctx, 10)
	if err != nil || len(queued) != 1 || queued[0].AttemptCount != 1 || queued[0].LastError != "temporary failure" {
		t.Fatalf("queued = %#v, error = %v", queued, err)
	}
	if err := store.CompleteAgentSessionResourceCleanup(ctx, item.WorkspaceID, item.AgentSessionID); err != nil {
		t.Fatalf("CompleteAgentSessionResourceCleanup() error = %v", err)
	}
	queued, err = store.ListAgentSessionResourceCleanup(ctx, 10)
	if err != nil || len(queued) != 0 {
		t.Fatalf("completed queue = %#v, error = %v", queued, err)
	}
}

func TestAgentSessionResourceCleanupQueueFencesSessionIDReuse(t *testing.T) {
	t.Parallel()
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const sourceWorkspaceID = "workspace-cleanup-fence-source"
	const destinationWorkspaceID = "workspace-cleanup-fence-destination"
	if err := store.Create(ctx, workspacebiz.Summary{ID: sourceWorkspaceID, Name: "Cleanup Fence Source"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{ID: destinationWorkspaceID, Name: "Cleanup Fence Destination"}); err != nil {
		t.Fatal(err)
	}
	item := AgentSessionResourceCleanup{WorkspaceID: sourceWorkspaceID, AgentSessionID: "session-1"}
	enqueueAgentSessionResourceCleanupForTest(t, store, ctx, []AgentSessionResourceCleanup{item})
	report := agentactivitybiz.SessionStateReport{
		WorkspaceID: destinationWorkspaceID, AgentSessionID: item.AgentSessionID,
		Origin:   agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider: "codex", Status: "completed", OccurredAtUnixMS: time.Now().UnixMilli(),
	}
	if _, err := store.ReportSessionState(ctx, report); err == nil || !strings.Contains(err.Error(), "pending cleanup") {
		t.Fatalf("ReportSessionState() error=%v, want pending-cleanup reuse fence", err)
	}
	if err := store.CompleteAgentSessionResourceCleanup(ctx, sourceWorkspaceID, item.AgentSessionID); err != nil {
		t.Fatalf("CompleteAgentSessionResourceCleanup() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, report); err != nil {
		t.Fatalf("ReportSessionState() after cleanup error = %v", err)
	}
}

func TestAgentSessionIdentityChecksSpanWorkspacesAndTombstones(t *testing.T) {
	t.Parallel()
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	for _, workspace := range []workspacebiz.Summary{
		{ID: "workspace-identity-source", Name: "Identity Source"},
		{ID: "workspace-identity-owner", Name: "Identity Owner"},
	} {
		if err := store.Create(ctx, workspace); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "workspace-identity-owner", AgentSessionID: "shared-session",
		Origin:   agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider: "codex", Status: "completed", OccurredAtUnixMS: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	exists, err := store.AgentSessionIDExists(ctx, "shared-session")
	if err != nil || !exists {
		t.Fatalf("AgentSessionIDExists()=%v error=%v, want true", exists, err)
	}
	otherLive, err := store.OtherWorkspaceLiveAgentSessionIDExists(
		ctx,
		"workspace-identity-source",
		"shared-session",
	)
	if err != nil || !otherLive {
		t.Fatalf("OtherWorkspaceLiveAgentSessionIDExists()=%v error=%v, want true", otherLive, err)
	}
	if removed, err := store.DeleteSession(ctx, "workspace-identity-owner", "shared-session"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v", removed, err)
	}

	exists, err = store.AgentSessionIDExists(ctx, "shared-session")
	if err != nil || !exists {
		t.Fatalf("AgentSessionIDExists() after tombstone=%v error=%v, want true", exists, err)
	}
	otherLive, err = store.OtherWorkspaceLiveAgentSessionIDExists(
		ctx,
		"workspace-identity-source",
		"shared-session",
	)
	if err != nil || otherLive {
		t.Fatalf("OtherWorkspaceLiveAgentSessionIDExists() after tombstone=%v error=%v, want false", otherLive, err)
	}
}

func TestAgentSessionResourceCleanupGlobalReuseFenceUpgradesV3(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?;
DROP TRIGGER IF EXISTS trg_workspace_agent_sessions_block_pending_resource_cleanup;
CREATE TRIGGER trg_workspace_agent_sessions_block_pending_resource_cleanup
BEFORE INSERT ON workspace_agent_sessions
WHEN EXISTS (
  SELECT 1
  FROM agent_session_resource_cleanup_queue cleanup
  WHERE cleanup.workspace_id = NEW.workspace_id
    AND cleanup.agent_session_id = NEW.agent_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent session resources are pending cleanup');
END;
`, schemaMigrationAgentDataMaintenanceV4); err != nil {
		t.Fatalf("restore V3 cleanup fence: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() V4 error = %v", err)
	}
	for _, workspace := range []workspacebiz.Summary{
		{ID: "workspace-v3-source", Name: "V3 Source"},
		{ID: "workspace-v4-destination", Name: "V4 Destination"},
	} {
		if err := store.Create(ctx, workspace); err != nil {
			t.Fatal(err)
		}
	}
	enqueueAgentSessionResourceCleanupForTest(t, store, ctx, []AgentSessionResourceCleanup{{
		WorkspaceID: "workspace-v3-source", AgentSessionID: "shared-session",
	}})
	_, err = store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "workspace-v4-destination", AgentSessionID: "shared-session",
		Origin:   agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider: "codex", Status: "completed", OccurredAtUnixMS: time.Now().UnixMilli(),
	})
	if err == nil || !strings.Contains(err.Error(), "pending cleanup") {
		t.Fatalf("ReportSessionState() error=%v, want V4 global reuse fence", err)
	}
}

func TestCompactDeletedDataIfSafeRequiresSubstantialFreeSpace(t *testing.T) {
	t.Parallel()
	store := openTestSQLiteStore(t)
	compacted, err := store.CompactDeletedDataIfSafe(context.Background())
	if err != nil || compacted {
		t.Fatalf("CompactDeletedDataIfSafe()=%v error=%v, want safe skip", compacted, err)
	}
}

func TestCompactDeletedDataIfSafeReclaimsSmallDisposableDatabase(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE compaction_probe (payload BLOB NOT NULL);
INSERT INTO compaction_probe(payload) VALUES (zeroblob(12582912));
DROP TABLE compaction_probe;
`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(store.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	compacted, err := store.CompactDeletedDataIfSafe(ctx)
	if err != nil || !compacted {
		t.Fatalf("CompactDeletedDataIfSafe()=%v error=%v", compacted, err)
	}
	after, err := os.Stat(store.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() >= before.Size() {
		t.Fatalf("database size after compaction=%d, before=%d", after.Size(), before.Size())
	}
}
