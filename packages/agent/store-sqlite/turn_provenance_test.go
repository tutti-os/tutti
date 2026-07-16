package storesqlite

import (
	"context"
	"database/sql"
	"testing"
)

func TestTurnProvenanceIsDurableAndImmutable(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	first, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSubmitted, Origin: TurnOriginGoalContinuation,
		SourceGoalOperationID: "goal-op-1", SourceGoalRevision: 4, SourceGoalRepairEpoch: 2, OccurredAtUnixMS: 20,
	})
	if err != nil || !accepted {
		t.Fatalf("first transition=%#v accepted=%v error=%v", first, accepted, err)
	}
	if first.Origin != TurnOriginGoalContinuation || first.SourceGoalOperationID != "goal-op-1" || first.SourceGoalRevision != 4 || first.SourceGoalRepairEpoch != 2 {
		t.Fatalf("first provenance=%#v", first)
	}

	updated, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt,
		SourceGoalOperationID: "goal-op-overwrite", SourceGoalRevision: 9, SourceGoalRepairEpoch: 8, OccurredAtUnixMS: 30,
	})
	if err != nil || !accepted {
		t.Fatalf("updated transition=%#v accepted=%v error=%v", updated, accepted, err)
	}
	if updated.Origin != TurnOriginGoalContinuation || updated.SourceGoalOperationID != "goal-op-1" || updated.SourceGoalRevision != 4 || updated.SourceGoalRepairEpoch != 2 {
		t.Fatalf("provenance was overwritten: %#v", updated)
	}

	var dbPath string
	if err := store.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name = 'main'`).Scan(&dbPath); err != nil {
		t.Fatalf("resolve database path: %v", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatalf("close before restart: %v", err)
	}
	reopenedDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	t.Cleanup(func() { _ = reopenedDB.Close() })
	reopenedDB.SetMaxOpenConns(1)
	if _, err := reopenedDB.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		t.Fatal(err)
	}
	reopened := New(reopenedDB, testOptions(&staticProjectPaths{}))
	if err := reopened.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() after restart: %v", err)
	}
	restarted, ok, err := reopened.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok || restarted.Origin != TurnOriginGoalContinuation || restarted.SourceGoalOperationID != "goal-op-1" || restarted.SourceGoalRevision != 4 || restarted.SourceGoalRepairEpoch != 2 {
		t.Fatalf("restarted provenance=%#v ok=%v error=%v", restarted, ok, err)
	}
}

func TestLegacyTurnGetsExplicitUnknownOrigin(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	turn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-legacy",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 20,
	})
	if err != nil || !accepted || turn.Origin != TurnOriginLegacyUnknown {
		t.Fatalf("legacy transition=%#v accepted=%v error=%v", turn, accepted, err)
	}
	replayed, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-legacy",
		Phase: TurnPhaseRunning, Origin: TurnOriginProviderInitiated,
		SourceGoalOperationID: "guessed-op", SourceGoalRevision: 1, SourceGoalRepairEpoch: 3,
		OccurredAtUnixMS: 30,
	})
	if err != nil || !accepted {
		t.Fatalf("legacy replay=%#v accepted=%v error=%v", replayed, accepted, err)
	}
	if replayed.Origin != TurnOriginLegacyUnknown || replayed.SourceGoalOperationID != "" || replayed.SourceGoalRevision != 0 || replayed.SourceGoalRepairEpoch != 0 {
		t.Fatalf("legacy provenance was guessed: %#v", replayed)
	}
}
