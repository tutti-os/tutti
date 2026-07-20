package agenthost_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type sqliteCanonicalStore struct {
	*storesqlite.Store
}

func (s sqliteCanonicalStore) InitializeRuntimeSession(context.Context, agenthost.ProviderRuntimeSession) (storesqlite.Session, error) {
	return storesqlite.Session{}, nil
}

func TestSessionInteractionSnapshotReadsOnlyLatestTurnFromSQLite(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	seedTurn := func(turnID string, occurredAt int64) {
		t.Helper()
		if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: turnID,
			Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: occurredAt,
		}); err != nil || !accepted {
			t.Fatalf("seed turn %s: accepted=%v err=%v", turnID, accepted, err)
		}
	}
	seedInteraction := func(turnID, requestID, status string, occurredAt int64) {
		t.Helper()
		if _, result, err := store.UpsertInteraction(t.Context(), storesqlite.InteractionUpsert{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: turnID,
			RequestID: requestID, Kind: storesqlite.InteractionKindQuestion, Status: status,
			OccurredAtUnixMS: occurredAt,
		}); err != nil || result != storesqlite.InteractionTransitionApplied {
			t.Fatalf("seed interaction %s: result=%v err=%v", requestID, result, err)
		}
	}

	seedTurn("turn-old", 10)
	seedInteraction("turn-old", "old-pending", storesqlite.InteractionStatusPending, 11)
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-old",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 12,
	}); err != nil || !accepted {
		t.Fatalf("settle old turn: accepted=%v err=%v", accepted, err)
	}
	seedTurn("turn-latest", 20)
	seedInteraction("turn-latest", "latest-pending", storesqlite.InteractionStatusPending, 21)
	seedInteraction("turn-latest", "latest-answered", storesqlite.InteractionStatusPending, 22)
	seedInteraction("turn-latest", "latest-answered", storesqlite.InteractionStatusAnswered, 23)

	host := agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: store}})
	snapshot, err := host.GetSessionInteractionSnapshot(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("GetSessionInteractionSnapshot() error = %v", err)
	}
	if len(snapshot.Interactions) != 2 {
		t.Fatalf("Interactions = %#v, want two from latest turn", snapshot.Interactions)
	}
	for _, interaction := range snapshot.Interactions {
		if interaction.TurnID != "turn-latest" || interaction.RequestID == "old-pending" {
			t.Fatalf("snapshot leaked non-latest interaction: %#v", interaction)
		}
	}
	if len(snapshot.PendingInteractions) != 1 || snapshot.PendingInteractions[0].RequestID != "latest-pending" {
		t.Fatalf("PendingInteractions = %#v, want latest-pending only", snapshot.PendingInteractions)
	}
}
