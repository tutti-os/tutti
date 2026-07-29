package workspace

import (
	"context"
	"os"
	"testing"
)

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
