package workspace

import (
	"context"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreRecoverableDeleteAndRestorePreserveTuttiModeSessionState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-recoverable-tutti-mode"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Recoverable Tutti Mode"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")

	deleted, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: workspaceID,
		SessionIDs:  []string{"session-1"},
	})
	if err != nil || deleted.RemovedSessions != 1 {
		t.Fatalf("DeleteSessionsBatch() result=%#v error=%v, want one soft-deleted session", deleted, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", true)

	restored, err := store.RestoreDeletedSession(ctx, agentactivitybiz.RestoreDeletedSessionInput{
		WorkspaceID: workspaceID, AgentSessionID: "session-1",
	})
	if err != nil || !restored.Restored {
		t.Fatalf("RestoreDeletedSession() result=%#v error=%v, want restored", restored, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", true)
}

func TestSQLiteStoreClearSessionsPermanentlyRemovesTuttiModeSessionState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-hard-clear-tutti-mode"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Hard Clear Tutti Mode"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")

	cleared, err := store.ClearSessions(ctx, workspaceID)
	if err != nil || cleared.RemovedSessions != 1 {
		t.Fatalf("ClearSessions() result=%#v error=%v, want one permanently removed session", cleared, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", false)
	deleted, err := store.ListDeletedSessions(ctx, agentactivitybiz.ListDeletedSessionsInput{WorkspaceID: workspaceID})
	if err != nil || deleted.WorkspaceTotalCount != 0 {
		t.Fatalf("ListDeletedSessions() page=%#v error=%v, want no canonical tombstone after hard clear", deleted, err)
	}
}

func TestSQLiteStoreScopedDeletedSessionPurgeRemovesTuttiModeSessionState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-scoped-purge-tutti-mode"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Scoped Purge Tutti Mode"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")
	if removed, err := store.DeleteSession(ctx, workspaceID, "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want soft-deleted", removed, err)
	}

	result, err := store.PurgeDeletedSessionTrees(ctx, agentactivitybiz.PurgeDeletedSessionTreesInput{
		WorkspaceID: workspaceID, RootSessionIDs: []string{"session-1"},
	})
	if err != nil || result.RemovedSessions != 1 {
		t.Fatalf("PurgeDeletedSessionTrees() result=%#v error=%v, want one purged session", result, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", false)
	assertSessionResourceCleanupQueued(t, store, ctx, workspaceID, "session-1")
}

func TestSQLiteStoreRetentionPurgeRemovesTuttiModeSessionState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-retention-purge-tutti-mode"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Retention Purge Tutti Mode"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")
	if removed, err := store.DeleteSession(ctx, workspaceID, "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want soft-deleted", removed, err)
	}

	result, err := store.PurgeDeletedSessions(ctx, agentactivitybiz.PurgeDeletedSessionsInput{
		CutoffUnixMS: time.Now().Add(time.Hour).UnixMilli(),
		MaxSessions:  10,
	})
	if err != nil || len(result.Sessions) != 1 {
		t.Fatalf("PurgeDeletedSessions() result=%#v error=%v, want one purged session", result, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", false)
	assertSessionResourceCleanupQueued(t, store, ctx, workspaceID, "session-1")
}

func TestSQLiteStoreDeletedSessionPurgeRollsBackCanonicalAndTuttiModeStateTogether(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-atomic-purge-tutti-mode"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Atomic Purge Tutti Mode"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")
	if removed, err := store.DeleteSession(ctx, workspaceID, "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want soft-deleted", removed, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER fail_tutti_mode_activation_delete
BEFORE DELETE ON tutti_mode_activations
WHEN OLD.workspace_id = 'ws-atomic-purge-tutti-mode'
BEGIN
  SELECT RAISE(ABORT, 'forced Tutti mode cleanup failure');
END
`); err != nil {
		t.Fatalf("create cleanup failure trigger: %v", err)
	}

	_, err := store.PurgeDeletedSessionTrees(ctx, agentactivitybiz.PurgeDeletedSessionTreesInput{
		WorkspaceID: workspaceID, RootSessionIDs: []string{"session-1"},
	})
	if err == nil || !strings.Contains(err.Error(), "forced Tutti mode cleanup failure") {
		t.Fatalf("PurgeDeletedSessionTrees() error=%v, want forced cleanup failure", err)
	}
	deleted, err := store.SessionDeleted(ctx, workspaceID, "session-1")
	if err != nil || !deleted {
		t.Fatalf("SessionDeleted() deleted=%v error=%v, want canonical tombstone rolled back", deleted, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", true)
}

func TestSQLiteStoreDeletedSessionPurgeRollsBackWhenCleanupOutboxCannotCommit(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	const workspaceID = "ws-atomic-purge-outbox"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Atomic Purge Outbox"}); err != nil {
		t.Fatal(err)
	}
	seedSessionWithTuttiModeState(t, store, ctx, workspaceID, "session-1")
	if removed, err := store.DeleteSession(ctx, workspaceID, "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want soft-deleted", removed, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER fail_agent_session_resource_cleanup_enqueue
BEFORE INSERT ON agent_session_resource_cleanup_queue
WHEN NEW.workspace_id = 'ws-atomic-purge-outbox'
BEGIN
  SELECT RAISE(ABORT, 'forced cleanup outbox failure');
END
`); err != nil {
		t.Fatalf("create outbox failure trigger: %v", err)
	}

	_, err := store.PurgeDeletedSessionTrees(ctx, agentactivitybiz.PurgeDeletedSessionTreesInput{
		WorkspaceID: workspaceID, RootSessionIDs: []string{"session-1"},
	})
	if err == nil || !strings.Contains(err.Error(), "forced cleanup outbox failure") {
		t.Fatalf("PurgeDeletedSessionTrees() error=%v, want forced outbox failure", err)
	}
	deleted, err := store.SessionDeleted(ctx, workspaceID, "session-1")
	if err != nil || !deleted {
		t.Fatalf("SessionDeleted() deleted=%v error=%v, want canonical tombstone rolled back", deleted, err)
	}
	assertTuttiModeSessionState(t, store, ctx, workspaceID, "session-1", true)
	queued, err := store.ListAgentSessionResourceCleanup(ctx, 10)
	if err != nil || len(queued) != 0 {
		t.Fatalf("ListAgentSessionResourceCleanup() items=%#v error=%v, want rolled back outbox", queued, err)
	}
}

func seedSessionWithTuttiModeState(
	t *testing.T,
	store *SQLiteStore,
	ctx context.Context,
	workspaceID string,
	sessionID string,
) {
	t.Helper()
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
		Origin:   agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider: "codex", Status: "completed", OccurredAtUnixMS: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
	}
	changedAt := time.Now().UTC()
	activation, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
		ActivationID: "activation-" + sessionID, RevisionID: "revision-" + sessionID,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: changedAt,
	})
	if err != nil || !changed {
		t.Fatalf("SetTuttiModeActivation(%s) changed=%v error=%v", sessionID, changed, err)
	}
	if _, changed, err := store.PutTuttiModeTurnSnapshot(
		ctx,
		workspaceID,
		sessionID,
		"turn-"+sessionID,
		activationbiz.SnapshotFromActivation(&activation),
		changedAt,
	); err != nil || !changed {
		t.Fatalf("PutTuttiModeTurnSnapshot(%s) changed=%v error=%v", sessionID, changed, err)
	}
}

func assertTuttiModeSessionState(
	t *testing.T,
	store *SQLiteStore,
	ctx context.Context,
	workspaceID string,
	sessionID string,
	want bool,
) {
	t.Helper()
	if _, ok, err := store.GetTuttiModeActivation(ctx, workspaceID, sessionID); err != nil || ok != want {
		t.Fatalf("GetTuttiModeActivation(%s) ok=%v error=%v, want ok=%v", sessionID, ok, err, want)
	}
	if _, ok, err := store.GetTuttiModeTurnSnapshot(ctx, workspaceID, sessionID, "turn-"+sessionID); err != nil || ok != want {
		t.Fatalf("GetTuttiModeTurnSnapshot(%s) ok=%v error=%v, want ok=%v", sessionID, ok, err, want)
	}
}

func assertSessionResourceCleanupQueued(
	t *testing.T,
	store *SQLiteStore,
	ctx context.Context,
	workspaceID string,
	sessionID string,
) {
	t.Helper()
	queued, err := store.ListAgentSessionResourceCleanup(ctx, 100)
	if err != nil {
		t.Fatalf("ListAgentSessionResourceCleanup() error = %v", err)
	}
	for _, item := range queued {
		if item.WorkspaceID == workspaceID && item.AgentSessionID == sessionID {
			return
		}
	}
	t.Fatalf("cleanup queue = %#v, want %s/%s", queued, workspaceID, sessionID)
}
