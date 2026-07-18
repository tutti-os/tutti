package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type durableMarkerParticipant struct{}

func (durableMarkerParticipant) Participate(ctx context.Context, writer storesqlite.TransactionWriter, delta storesqlite.TransactionDelta) error {
	payload, err := json.Marshal(delta)
	if err != nil {
		return err
	}
	_, err = writer.ExecContext(ctx, `INSERT INTO test_durable_outbox (transaction_id, payload_json, delivered) VALUES (?, ?, 0)`, delta.TransactionID, string(payload))
	return err
}

type replayObserver struct {
	fail  bool
	calls int
}

func (o *replayObserver) ObserveCommitted(context.Context, agenthost.CommittedDelta) error {
	o.calls++
	if o.fail {
		return errors.New("observer unavailable")
	}
	return nil
}

func TestDurableMarkerSurvivesObserverFailureAndCanReplay(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-store.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{TransactionParticipant: durableMarkerParticipant{}})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE test_durable_outbox (transaction_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, delivered INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}

	result, err := store.ReportSessionState(context.Background(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	observer := &replayObserver{fail: true}
	agenthost.NotifyCommitted(context.Background(), observer, agenthost.CanonicalDelta(result.CommitDelta))

	var delivered int
	var payloadJSON string
	if err := db.QueryRow(`SELECT payload_json, delivered FROM test_durable_outbox WHERE transaction_id = ?`, result.TransactionID).Scan(&payloadJSON, &delivered); err != nil || delivered != 0 {
		t.Fatalf("durable marker after observer failure delivered=%d error=%v", delivered, err)
	}
	var replayed storesqlite.TransactionDelta
	if err := json.Unmarshal([]byte(payloadJSON), &replayed); err != nil {
		t.Fatalf("decode durable committed delta: %v", err)
	}
	if replayed.TransactionID != result.TransactionID || len(replayed.Mutations) != len(result.CommitDelta.Mutations) {
		t.Fatalf("replayed delta=%#v, committed=%#v", replayed, result.CommitDelta)
	}
	if _, found, err := store.GetSession(context.Background(), "workspace-1", "session-1"); err != nil || !found {
		t.Fatalf("canonical fact after observer failure found=%v error=%v", found, err)
	}
	observer.fail = false
	agenthost.NotifyCommitted(context.Background(), observer, agenthost.CanonicalDelta(replayed))
	if observer.calls != 2 {
		t.Fatalf("observer calls=%d, want failed delivery plus replay", observer.calls)
	}
	if _, err := db.Exec(`UPDATE test_durable_outbox SET delivered = 1 WHERE transaction_id = ?`, result.TransactionID); err != nil {
		t.Fatal(err)
	}
}
