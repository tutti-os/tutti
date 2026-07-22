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

func (sqliteCanonicalStore) InitializeRuntimeSession(context.Context, agenthost.ProviderRuntimeSession) (storesqlite.Session, error) {
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

func TestGetGoalStateDoesNotBootstrapMissingProjection(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-goal-read.db"))
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
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-read", Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, found, err := store.GetSessionGoalState(t.Context(), "workspace-1", "session-goal-read"); err != nil || found {
		t.Fatalf("goal before read: found=%v err=%v", found, err)
	}

	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store},
		GoalStore:      store,
	})
	result, err := host.GetGoalState(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-read",
	})
	if err != nil {
		t.Fatalf("GetGoalState() error = %v", err)
	}
	if result.State.Revision != 0 || result.State.WorkspaceID != "" {
		t.Fatalf("GetGoalState() state = %#v, want zero value", result.State)
	}
	if _, found, err := store.GetSessionGoalState(t.Context(), "workspace-1", "session-goal-read"); err != nil || found {
		t.Fatalf("goal after read: found=%v err=%v", found, err)
	}
}

func TestListSessionMessagesReadsOneCanonicalTurnPageFromSQLite(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-host-messages.db"))
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
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-old",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed old turn: accepted=%v err=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-old",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
	}); err != nil || !accepted {
		t.Fatalf("settle old turn: accepted=%v err=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-current",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 4,
	}); err != nil || !accepted {
		t.Fatalf("seed current turn: accepted=%v err=%v", accepted, err)
	}
	for index, turnID := range []string{"turn-old", "turn-current", "turn-current"} {
		messageID := []string{"old", "first", "second"}[index]
		if _, err := store.ReportSessionMessages(t.Context(), storesqlite.SessionMessageReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Messages: []storesqlite.MessageUpdate{{
				MessageID: messageID, TurnID: turnID, Role: "assistant", Kind: "tool", OccurredAtUnixMS: int64(index + 10),
			}},
		}); err != nil {
			t.Fatalf("seed message %s: %v", messageID, err)
		}
	}

	host := agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: store}})
	page, found, err := host.ListSessionMessages(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}, agenthost.SessionMessageQuery{TurnID: "turn-current", Limit: 1, Order: storesqlite.MessageOrderAsc})
	if err != nil || !found {
		t.Fatalf("ListSessionMessages() found=%v error=%v", found, err)
	}
	if len(page.Messages) != 1 || page.Messages[0].MessageID != "first" || !page.HasMore || page.LatestVersion == 0 {
		t.Fatalf("ListSessionMessages() page = %#v, want first current-turn message with cursor", page)
	}
}
