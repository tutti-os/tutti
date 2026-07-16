package storesqlite

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestGoalProvenanceLedgerKeepsMoreThanMemoryCacheCapacity(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	incarnation := createGoalProvenanceTestSession(t, store, "ws-ledger", "session-ledger")
	for i := 0; i < 300; i++ {
		input := BindGoalProvenanceInput{
			WorkspaceID: "ws-ledger", AgentSessionID: "session-ledger", ProviderSessionID: "provider-session",
			SessionCreatedAtUnixMS: incarnation,
			Fingerprint:            fmt.Sprintf("fingerprint-%03d", i), OperationID: fmt.Sprintf("operation-%03d", i),
			Revision: int64(i + 1), RepairEpoch: int64(i % 3), OccurredAtUnixMS: int64(1000 + i),
		}
		binding, err := store.BindGoalProvenance(ctx, input)
		if err != nil || binding.Ambiguous || binding.OperationID != input.OperationID {
			t.Fatalf("BindGoalProvenance(%d) = %#v, %v", i, binding, err)
		}
	}
	for _, i := range []int{0, 255, 256, 299} {
		binding, found, err := store.LookupGoalProvenance(ctx, LookupGoalProvenanceInput{
			WorkspaceID: "ws-ledger", AgentSessionID: "session-ledger", ProviderSessionID: "provider-session",
			SessionCreatedAtUnixMS: incarnation,
			Fingerprint:            fmt.Sprintf("fingerprint-%03d", i),
		})
		if err != nil || !found || binding.OperationID != fmt.Sprintf("operation-%03d", i) || binding.Revision != int64(i+1) {
			t.Fatalf("LookupGoalProvenance(%d) = %#v, found=%v, err=%v", i, binding, found, err)
		}
	}
}

func TestGoalProvenanceLedgerUsesRuntimeSessionIncarnation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	const incarnation = int64(424242)
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-runtime-incarnation", AgentSessionID: "session-runtime-incarnation",
		Provider: "codex", ProviderSessionID: "provider-session", OccurredAtUnixMS: incarnation + 1,
		CreatedAtUnixMS: incarnation,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindGoalProvenance(ctx, BindGoalProvenanceInput{
		WorkspaceID: "ws-runtime-incarnation", AgentSessionID: "session-runtime-incarnation",
		SessionCreatedAtUnixMS: incarnation, ProviderSessionID: "provider-session",
		Fingerprint: "generation", OperationID: "operation", Revision: 1, OccurredAtUnixMS: incarnation + 2,
	}); err != nil {
		t.Fatalf("runtime incarnation rejected: %v", err)
	}
}

func TestGoalProvenanceLedgerCollisionIsPermanentlyAmbiguous(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	incarnation := createGoalProvenanceTestSession(t, store, "ws-collision", "session-collision")
	key := BindGoalProvenanceInput{
		WorkspaceID: "ws-collision", AgentSessionID: "session-collision", ProviderSessionID: "provider-session",
		SessionCreatedAtUnixMS: incarnation,
		Fingerprint:            "same-provider-generation", OperationID: "operation-a", Revision: 1, RepairEpoch: 0, OccurredAtUnixMS: 10,
	}
	first, err := store.BindGoalProvenance(ctx, key)
	if err != nil || first.Ambiguous {
		t.Fatalf("first bind = %#v, %v", first, err)
	}
	duplicate, err := store.BindGoalProvenance(ctx, key)
	if err != nil || duplicate.Ambiguous || duplicate.OperationID != "operation-a" {
		t.Fatalf("idempotent bind = %#v, %v", duplicate, err)
	}
	collision := key
	collision.OperationID = "operation-b"
	collision.Revision = 2
	collision.RepairEpoch = 1
	collision.OccurredAtUnixMS = 20
	tombstone, err := store.BindGoalProvenance(ctx, collision)
	if err != nil || !tombstone.Ambiguous || tombstone.OperationID != "" || tombstone.Revision != 0 || tombstone.RepairEpoch != 0 {
		t.Fatalf("collision bind = %#v, %v", tombstone, err)
	}
	for _, retry := range []BindGoalProvenanceInput{key, collision, {
		WorkspaceID: key.WorkspaceID, AgentSessionID: key.AgentSessionID, ProviderSessionID: key.ProviderSessionID,
		SessionCreatedAtUnixMS: key.SessionCreatedAtUnixMS,
		Fingerprint:            key.Fingerprint, OperationID: "operation-c", Revision: 3, RepairEpoch: 2, OccurredAtUnixMS: 30,
	}} {
		got, bindErr := store.BindGoalProvenance(ctx, retry)
		if bindErr != nil || !got.Ambiguous || got.OperationID != "" {
			t.Fatalf("bind after tombstone = %#v, %v", got, bindErr)
		}
	}
	got, found, err := store.LookupGoalProvenance(ctx, LookupGoalProvenanceInput{
		WorkspaceID: key.WorkspaceID, AgentSessionID: key.AgentSessionID,
		SessionCreatedAtUnixMS: key.SessionCreatedAtUnixMS,
		ProviderSessionID:      key.ProviderSessionID, Fingerprint: key.Fingerprint,
	})
	if err != nil || !found || !got.Ambiguous || got.OperationID != "" {
		t.Fatalf("lookup tombstone = %#v, found=%v, err=%v", got, found, err)
	}
}

func TestGoalProvenanceLedgerExplicitSessionCleanupWithForeignKeysOff(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	incarnations := make(map[string]int64)
	for _, sessionID := range []string{"session-delete", "session-clear"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-cleanup", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 1,
		}); err != nil {
			t.Fatal(err)
		}
		var incarnation int64
		if err := store.db.QueryRowContext(ctx, `SELECT created_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id=? AND agent_session_id=?`, "ws-cleanup", sessionID).Scan(&incarnation); err != nil {
			t.Fatal(err)
		}
		incarnations[sessionID] = incarnation
		if _, err := store.BindGoalProvenance(ctx, BindGoalProvenanceInput{
			WorkspaceID: "ws-cleanup", AgentSessionID: sessionID, ProviderSessionID: "provider-" + sessionID,
			SessionCreatedAtUnixMS: incarnations[sessionID],
			Fingerprint:            "generation", OperationID: "operation-" + sessionID, Revision: 1, OccurredAtUnixMS: 2,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-cleanup", "session-delete"); err != nil || !removed {
		t.Fatalf("DeleteSession removed=%v err=%v", removed, err)
	}
	assertGoalProvenanceRowCount(t, store, "ws-cleanup", "session-delete", 0)
	assertGoalProvenanceRowCount(t, store, "ws-cleanup", "session-clear", 1)
	// A provider ACK after the soft-delete fails closed rather than creating
	// an orphan. Also inject a legacy/orphan row to prove repeated Delete is a
	// repair boundary even when removed=false.
	if _, err := store.BindGoalProvenance(ctx, BindGoalProvenanceInput{
		WorkspaceID: "ws-cleanup", AgentSessionID: "session-delete", ProviderSessionID: "late-provider",
		SessionCreatedAtUnixMS: incarnations["session-delete"],
		Fingerprint:            "late-generation", OperationID: "late-operation", Revision: 2, OccurredAtUnixMS: 3,
	}); err != ErrGoalProvenanceSessionDeleted {
		t.Fatalf("late BindGoalProvenance error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_goal_provenance_ledger (
 workspace_id,agent_session_id,session_created_at_unix_ms,provider_session_id,fingerprint,operation_id,goal_revision,
 repair_epoch,ambiguous,created_at_unix_ms,updated_at_unix_ms
) VALUES (?,?,?,?,?,?,?,0,0,3,3)
`, "ws-cleanup", "session-delete", incarnations["session-delete"], "legacy-provider", "legacy-generation", "legacy-operation", 2); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-cleanup", "session-delete"); err != nil || removed {
		t.Fatalf("idempotent DeleteSession removed=%v err=%v", removed, err)
	}
	assertGoalProvenanceRowCount(t, store, "ws-cleanup", "session-delete", 0)
	if _, err := store.ClearSessions(ctx, "ws-cleanup"); err != nil {
		t.Fatal(err)
	}
	assertGoalProvenanceRowCount(t, store, "ws-cleanup", "", 0)
	if _, err := store.BindGoalProvenance(ctx, BindGoalProvenanceInput{
		WorkspaceID: "ws-cleanup", AgentSessionID: "session-clear", ProviderSessionID: "late-provider",
		SessionCreatedAtUnixMS: incarnations["session-clear"],
		Fingerprint:            "late-after-clear", OperationID: "late-operation", Revision: 2, OccurredAtUnixMS: 4,
	}); err != ErrGoalProvenanceSessionNotFound {
		t.Fatalf("late bind after clear error = %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-cleanup", AgentSessionID: "session-clear", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("recreate Goal provenance test session: %v", err)
	}
	var recreatedIncarnation int64
	if err := store.db.QueryRowContext(ctx, `SELECT created_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id=? AND agent_session_id=?`, "ws-cleanup", "session-clear").Scan(&recreatedIncarnation); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindGoalProvenance(ctx, BindGoalProvenanceInput{
		WorkspaceID: "ws-cleanup", AgentSessionID: "session-clear", SessionCreatedAtUnixMS: incarnations["session-clear"],
		ProviderSessionID: "late-provider", Fingerprint: "late-after-recreate", OperationID: "late-operation", Revision: 2, OccurredAtUnixMS: 11,
	}); err != ErrGoalProvenanceSessionNotFound {
		t.Fatalf("old-incarnation bind after recreate error = %v", err)
	}
	if old, found, err := store.LookupGoalProvenance(ctx, LookupGoalProvenanceInput{
		WorkspaceID: "ws-cleanup", AgentSessionID: "session-clear", ProviderSessionID: "late-provider", Fingerprint: "late-after-clear",
		SessionCreatedAtUnixMS: recreatedIncarnation,
	}); err != nil || found {
		t.Fatalf("recreated session inherited old provenance: %#v found=%v err=%v", old, found, err)
	}
}

func createGoalProvenanceTestSession(t *testing.T, store *Store, workspaceID, agentSessionID string) int64 {
	t.Helper()
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("create Goal provenance test session: %v", err)
	}
	var createdAt int64
	if err := store.db.QueryRowContext(context.Background(), `SELECT created_at_unix_ms FROM workspace_agent_sessions WHERE workspace_id=? AND agent_session_id=?`, workspaceID, agentSessionID).Scan(&createdAt); err != nil {
		t.Fatalf("read Goal provenance test session incarnation: %v", err)
	}
	return createdAt
}

func assertGoalProvenanceRowCount(t *testing.T, store *Store, workspaceID, agentSessionID string, want int) {
	t.Helper()
	query := "SELECT COUNT(*) FROM workspace_agent_goal_provenance_ledger WHERE workspace_id=?"
	args := []any{workspaceID}
	if agentSessionID != "" {
		query += " AND agent_session_id=?"
		args = append(args, agentSessionID)
	}
	var got int
	if err := store.db.QueryRow(query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("goal provenance row count = %d, want %d", got, want)
	}
}
