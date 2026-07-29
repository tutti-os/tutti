package storesqlite

import (
	"context"
	"database/sql"
	"testing"
)

const (
	testSessionForkSequenceVerified         = "verified"
	testSessionForkSequenceLegacyUnverified = "legacy_unverified"
)

func TestSessionForkV1MigrationBackfillsOnlyOrderedMessageEvidence(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	dbPath := sessionForkMigrationDBPath(t, db)

	for _, sessionID := range []string{"ordered", "interleaved", "missing-message"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: sessionID, Kind: SessionKindRoot,
			Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-" + sessionID,
			Status: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Lexical turn IDs intentionally disagree with insertion order. The
	// migration must derive order from immutable message row IDs.
	reportTestMessage(t, store, "ordered", "ordered-1", "turn-z", 10)
	reportTestMessage(t, store, "ordered", "ordered-2", "turn-a", 20)
	reportRootProviderTurn(t, store, "ordered", "turn-z", "provider-ordered-1", RootProviderTurnPhaseCompleted, 11)
	reportRootProviderTurn(t, store, "ordered", "turn-a", "provider-ordered-2", RootProviderTurnPhaseCompleted, 21)

	// These ranges overlap: turn-a=[3,5], turn-b=[4,4].
	reportTestMessage(t, store, "interleaved", "interleaved-a1", "turn-a", 30)
	reportTestMessage(t, store, "interleaved", "interleaved-b1", "turn-b", 40)
	reportTestMessage(t, store, "interleaved", "interleaved-a2", "turn-a", 50)
	reportRootProviderTurn(t, store, "interleaved", "turn-a", "provider-interleaved-a", RootProviderTurnPhaseCompleted, 51)
	reportRootProviderTurn(t, store, "interleaved", "turn-b", "provider-interleaved-b", RootProviderTurnPhaseCompleted, 41)

	reportTestMessage(t, store, "missing-message", "present-message", "turn-present", 60)
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "missing-message", TurnID: "turn-missing",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 70,
	}); err != nil || !accepted {
		t.Fatalf("create message-less turn accepted=%v error=%v", accepted, err)
	}
	reportRootProviderTurn(t, store, "missing-message", "turn-present", "provider-present", RootProviderTurnPhaseCompleted, 61)
	reportRootProviderTurn(t, store, "missing-message", "turn-missing", "provider-missing", RootProviderTurnPhaseCompleted, 71)

	resetSessionForkMigrationsToPreV1(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, db = reopenAndMigrateSessionForkStore(t, dbPath)
	defer db.Close()

	assertSessionForkTurnSequences(t, store, "ordered", []expectedSessionForkTurnSequence{
		{turnID: "turn-z", sequence: 1, provenance: testSessionForkSequenceVerified},
		{turnID: "turn-a", sequence: 2, provenance: testSessionForkSequenceVerified},
	})
	assertSessionForkTurnSequences(t, store, "interleaved", []expectedSessionForkTurnSequence{
		{turnID: "turn-a", sequence: 1, provenance: testSessionForkSequenceLegacyUnverified},
		{turnID: "turn-b", sequence: 2, provenance: testSessionForkSequenceLegacyUnverified},
	})
	assertSessionForkTurnSequences(t, store, "missing-message", []expectedSessionForkTurnSequence{
		{turnID: "turn-missing", sequence: 1, provenance: testSessionForkSequenceLegacyUnverified},
		{turnID: "turn-present", sequence: 2, provenance: testSessionForkSequenceLegacyUnverified},
	})

	if _, supported, err := store.CheckSessionForkThroughTurn(ctx, "ws-1", "ordered", "turn-a"); err != nil || !supported {
		t.Fatalf("ordered CheckSessionForkThroughTurn() supported=%v error=%v", supported, err)
	}
	for _, boundary := range []struct {
		sessionID string
		turnID    string
	}{
		{sessionID: "interleaved", turnID: "turn-b"},
		{sessionID: "missing-message", turnID: "turn-present"},
	} {
		if _, supported, err := store.CheckSessionForkThroughTurn(
			ctx, "ws-1", boundary.sessionID, boundary.turnID,
		); err != nil || supported {
			t.Fatalf("%s CheckSessionForkThroughTurn() supported=%v error=%v", boundary.sessionID, supported, err)
		}
	}
}

func TestSessionForkV2MigrationBackfillsRecoverableV1OperationsAndReopensIdempotently(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	dbPath := sessionForkMigrationDBPath(t, db)
	resetSessionForkMigrationsToPreV1(t, db)

	// This is the schema/data boundary produced by the v1 binary before a
	// current binary opens the same database and applies v2.
	if err := store.applyWorkspaceAgentSessionForkV1(ctx); err != nil {
		t.Fatalf("apply staged session fork v1: %v", err)
	}
	statuses := []string{
		SessionForkStatusPrepared,
		SessionForkStatusDispatching,
		SessionForkStatusProviderAccepted,
	}
	for index, status := range statuses {
		operationID := "operation-" + status
		targetProviderSessionID := any(nil)
		if status == SessionForkStatusProviderAccepted {
			targetProviderSessionID = "provider-target-accepted"
		}
		if _, err := db.ExecContext(ctx, `
INSERT INTO workspace_agent_session_fork_operations (
  operation_id, workspace_id, request_id, request_hash,
  source_agent_session_id, target_agent_session_id,
  source_provider_session_id, source_turn_id, source_provider_turn_id,
  driver_kind, driver_version, status, target_provider_session_id,
  snapshot_json, snapshot_hash, last_error,
  created_at_unix_ms, updated_at_unix_ms,
  dispatched_at_unix_ms, accepted_at_unix_ms, completed_at_unix_ms
) VALUES (?, 'ws-1', ?, ?, ?, ?, ?, ?, ?, 'codex', '1', ?, ?,
          '{}', ?, '', ?, ?, ?, ?, NULL)
`, operationID, "request-"+status, "hash-"+status,
			"source-"+status, "target-"+status,
			"provider-source-"+status, "turn-"+status, "provider-turn-"+status,
			status, targetProviderSessionID, "snapshot-hash-"+status,
			100+index, 100+index,
			nullableSessionForkMigrationTime(status != SessionForkStatusPrepared, 110+index),
			nullableSessionForkMigrationTime(status == SessionForkStatusProviderAccepted, 120+index),
		); err != nil {
			t.Fatalf("insert v1 %s operation: %v", status, err)
		}
		if _, err := db.ExecContext(ctx, `
INSERT INTO workspace_agent_session_fork_target_reservations (
  workspace_id, target_agent_session_id, operation_id,
  request_id, request_hash, created_at_unix_ms
) VALUES ('ws-1', ?, ?, ?, ?, ?)
`, "target-"+status, operationID, "request-"+status, "hash-"+status, 100+index); err != nil {
			t.Fatalf("insert v1 %s reservation: %v", status, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, db = reopenAndMigrateSessionForkStore(t, dbPath)
	assertRecoverableSessionForkV1Fixture(t, store, statuses)
	assertSessionForkMigrationCounts(t, db, len(statuses))
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	// A second real process reopen must neither replay ALTER TABLE nor mutate
	// operation status/order/reservations.
	store, db = reopenAndMigrateSessionForkStore(t, dbPath)
	defer db.Close()
	assertRecoverableSessionForkV1Fixture(t, store, statuses)
	assertSessionForkMigrationCounts(t, db, len(statuses))
}

func TestSessionForkV4MigrationBackfillsCommittedOperationAndLineage(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	dbPath := sessionForkMigrationDBPath(t, db)
	seedForkSession(t, store)
	result := commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-v4", WorkspaceID: "ws-1", RequestID: "request-v4",
		RequestHash: "hash-v4", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-v4", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	})
	expectedTargetTurnID := result.Lineage.TargetTurnID
	if expectedTargetTurnID == "" {
		t.Fatal("committed fixture omitted target Turn identity")
	}
	if _, err := db.Exec(`
ALTER TABLE workspace_agent_session_forks DROP COLUMN target_turn_id;
ALTER TABLE workspace_agent_session_fork_operations DROP COLUMN target_turn_id;
DELETE FROM agent_store_schema_migrations
WHERE id = 'workspace_agent_session_fork_v4';
`); err != nil {
		t.Fatalf("stage session fork v3 database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, db = reopenAndMigrateSessionForkStore(t, dbPath)
	defer db.Close()
	operation, found, err := store.GetSessionForkOperation(ctx, "ws-1", "fork-v4")
	if err != nil || !found || operation.TargetTurnID != expectedTargetTurnID {
		t.Fatalf("backfilled operation=%#v found=%v error=%v", operation, found, err)
	}
	lineage, found, err := store.GetSessionForkLineage(ctx, "ws-1", "target-v4")
	if err != nil || !found || lineage.TargetTurnID != expectedTargetTurnID {
		t.Fatalf("backfilled lineage=%#v found=%v error=%v", lineage, found, err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("idempotent Migrate() error=%v", err)
	}
}

type expectedSessionForkTurnSequence struct {
	turnID     string
	sequence   int64
	provenance string
}

func assertSessionForkTurnSequences(
	t *testing.T,
	store *Store,
	sessionID string,
	expected []expectedSessionForkTurnSequence,
) {
	t.Helper()
	rows, err := store.db.QueryContext(context.Background(), `
SELECT turn_id, turn_sequence, provenance
FROM workspace_agent_turn_sequences
WHERE workspace_id = 'ws-1' AND agent_session_id = ?
ORDER BY turn_sequence
`, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var actual []expectedSessionForkTurnSequence
	for rows.Next() {
		var item expectedSessionForkTurnSequence
		if err := rows.Scan(&item.turnID, &item.sequence, &item.provenance); err != nil {
			t.Fatal(err)
		}
		actual = append(actual, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(actual) != len(expected) {
		t.Fatalf("%s turn sequences=%#v, want %#v", sessionID, actual, expected)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("%s turn sequences=%#v, want %#v", sessionID, actual, expected)
		}
	}
}

func assertRecoverableSessionForkV1Fixture(t *testing.T, store *Store, statuses []string) {
	t.Helper()
	operations, err := store.ListRecoverableSessionForkOperations(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != len(statuses) {
		t.Fatalf("recoverable operations=%#v, want statuses=%#v", operations, statuses)
	}
	for index, status := range statuses {
		operation := operations[index]
		if operation.OperationID != "operation-"+status ||
			operation.Status != status ||
			operation.PointKind != SessionForkPointThroughTurn {
			t.Fatalf("recoverable operation[%d]=%#v, want status=%q and through_turn", index, operation, status)
		}
	}
}

func assertSessionForkMigrationCounts(t *testing.T, db *sql.DB, operationCount int) {
	t.Helper()
	var operations, reservations, barriers, migrationRows, pointKinds int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_session_fork_operations`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_session_fork_target_reservations`).Scan(&reservations); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_session_fork_boundary_barriers`).Scan(&barriers); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
SELECT COUNT(*) FROM agent_store_schema_migrations
WHERE id IN (?, ?, ?, ?, ?)
`, schemaMigrationWorkspaceAgentSessionForkV1, schemaMigrationWorkspaceAgentSessionForkV2,
		schemaMigrationWorkspaceAgentSessionForkV3,
		schemaMigrationWorkspaceAgentSessionForkV4,
		schemaMigrationWorkspaceAgentSessionForkV5).Scan(&migrationRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
SELECT COUNT(*) FROM workspace_agent_session_fork_operations
WHERE point_kind = 'through_turn'
`).Scan(&pointKinds); err != nil {
		t.Fatal(err)
	}
	if operations != operationCount || reservations != operationCount ||
		barriers != operationCount || migrationRows != 5 || pointKinds != operationCount {
		t.Fatalf(
			"migration counts operations=%d reservations=%d barriers=%d ledger=%d pointKinds=%d, want %d/%d/%d/5/%d",
			operations, reservations, barriers, migrationRows, pointKinds,
			operationCount, operationCount, operationCount, operationCount,
		)
	}
}

func resetSessionForkMigrationsToPreV1(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
DROP TRIGGER IF EXISTS workspace_agent_turn_sequence_after_insert;
DROP TABLE IF EXISTS workspace_agent_session_forks;
DROP TABLE IF EXISTS workspace_agent_session_fork_boundary_barriers;
DROP TABLE IF EXISTS workspace_agent_session_fork_target_reservations;
DROP TABLE IF EXISTS workspace_agent_session_fork_operations;
DROP TABLE IF EXISTS workspace_agent_turn_sequences;
DELETE FROM agent_store_schema_migrations
WHERE id IN (
  'workspace_agent_session_fork_v1',
  'workspace_agent_session_fork_v2',
  'workspace_agent_session_fork_v3',
  'workspace_agent_session_fork_v4',
  'workspace_agent_session_fork_v5'
);
`); err != nil {
		t.Fatalf("reset session fork migrations to pre-v1: %v", err)
	}
}

func sessionForkMigrationDBPath(t *testing.T, db *sql.DB) string {
	t.Helper()
	var dbPath string
	if err := db.QueryRow(`SELECT file FROM pragma_database_list WHERE name = 'main'`).Scan(&dbPath); err != nil {
		t.Fatalf("resolve migration fixture database path: %v", err)
	}
	return dbPath
}

func reopenAndMigrateSessionForkStore(t *testing.T, dbPath string) (*Store, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("reopen migration fixture database: %v", err)
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			_ = db.Close()
			t.Fatalf("%s: %v", pragma, err)
		}
	}
	store := New(db, testOptions(&staticProjectPaths{}))
	if err := store.Migrate(context.Background()); err != nil {
		_ = db.Close()
		t.Fatalf("Migrate() after reopen: %v", err)
	}
	return store, db
}

func nullableSessionForkMigrationTime(condition bool, value int) any {
	if !condition {
		return nil
	}
	return value
}
