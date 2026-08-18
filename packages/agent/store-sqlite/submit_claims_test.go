package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
)

func TestSubmitClaimIsDurableAndIdempotent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	input := SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: "submit-1",
		CanonicalTurnID: "turn-1", MetadataJSON: `{"uiMode":"agent","trace":"private"}`, NowUnixMS: 10,
	}
	first, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || !created || first.Status != "prepared" || first.CanonicalTurnID != "turn-1" || first.TurnID != "" || first.MetadataJSON != `{"uiMode":"agent"}` {
		t.Fatalf("first = %#v created=%v err=%v", first, created, err)
	}
	input.CanonicalTurnID = "turn-retry-must-be-ignored"
	input.MetadataJSON = `{"uiMode":"os"}`
	input.NowUnixMS = 99
	duplicate, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.Status != "prepared" || duplicate.CanonicalTurnID != "turn-1" || duplicate.MetadataJSON != `{"uiMode":"agent"}` || duplicate.CreatedAtUnixMS != 10 {
		t.Fatalf("duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
	accepted, updated, err := store.AcceptSubmitClaim(context.Background(), "ws-1", "session-1", "submit-1", "turn-1", 20)
	if err != nil || !updated || accepted.Status != "accepted" || accepted.TurnID != "turn-1" {
		t.Fatalf("accepted = %#v updated=%v err=%v", accepted, updated, err)
	}
	afterRestart := New(store.db, store.opts)
	duplicate, created, err = afterRestart.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.TurnID != "turn-1" || duplicate.CanonicalTurnID != "turn-1" || duplicate.CreatedAtUnixMS != 10 {
		t.Fatalf("restart duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
}

func TestSubmitClaimAcceptRequiresExactCanonicalTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	input := SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: "submit-1",
		CanonicalTurnID: "turn-1", NowUnixMS: 10,
	}
	if _, _, err := store.PrepareSubmitClaim(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	claim, updated, err := store.AcceptSubmitClaim(context.Background(), "ws-1", "session-1", "submit-1", "turn-other", 20)
	if !errors.Is(err, ErrSubmitClaimTurnConflict) || updated || claim.Status != "prepared" || claim.CanonicalTurnID != "turn-1" {
		t.Fatalf("mismatched accept claim=%#v updated=%v err=%v", claim, updated, err)
	}
}

func TestSubmitClaimRejectIsTerminalAndIdempotent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: "submit-rejected",
		CanonicalTurnID: "turn-rejected", NowUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	rejected, changed, err := store.RejectSubmitClaim(ctx, "ws-1", "session-1", "submit-rejected", "turn-rejected", 20)
	if err != nil || !changed || rejected.Status != "rejected" || rejected.TurnID != "turn-rejected" {
		t.Fatalf("rejected=%#v changed=%v error=%v", rejected, changed, err)
	}
	replayed, changed, err := store.RejectSubmitClaim(ctx, "ws-1", "session-1", "submit-rejected", "turn-rejected", 30)
	if err != nil || changed || replayed.Status != "rejected" || replayed.UpdatedAtUnixMS != 20 {
		t.Fatalf("replayed rejected=%#v changed=%v error=%v", replayed, changed, err)
	}
	if _, changed, err := store.AcceptSubmitClaim(ctx, "ws-1", "session-1", "submit-rejected", "turn-rejected", 40); !errors.Is(err, ErrSubmitClaimTurnConflict) || changed {
		t.Fatalf("accepted rejected claim changed=%v error=%v", changed, err)
	}
	if _, changed, err := store.RejectSubmitClaim(ctx, "ws-1", "session-1", "submit-rejected", "turn-other", 40); !errors.Is(err, ErrSubmitClaimTurnConflict) || changed {
		t.Fatalf("mismatched rejected replay changed=%v error=%v", changed, err)
	}
}

func TestSubmitClaimsAllowMultipleGuidanceSubmissionsForOneCanonicalTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	for index, clientSubmitID := range []string{"guidance-1", "guidance-2"} {
		claim, created, err := store.PrepareSubmitClaim(context.Background(), SubmitClaimPrepare{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: clientSubmitID,
			CanonicalTurnID: "turn-active", NowUnixMS: int64(10 + index),
		})
		if err != nil || !created || claim.CanonicalTurnID != "turn-active" {
			t.Fatalf("prepare %s claim=%#v created=%v err=%v", clientSubmitID, claim, created, err)
		}
	}
}

func TestSubmitClaimV2BackfillsAcceptedAndLeavesLegacyPreparedUnknown(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := New(openTestDB(t), testOptions(&staticProjectPaths{}))
	if _, err := store.db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV1(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_submit_claims
  (workspace_id, agent_session_id, client_submit_id, status, turn_id, created_at_unix_ms, updated_at_unix_ms)
VALUES
  ('ws-1', 'session-1', 'accepted-legacy', 'accepted', 'turn-accepted', 1, 2),
  ('ws-1', 'session-1', 'prepared-legacy', 'prepared', NULL, 1, 1);
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV2(ctx); err != nil {
		t.Fatal(err)
	}
	var acceptedCanonical sql.NullString
	if err := store.db.QueryRowContext(ctx, `
SELECT canonical_turn_id FROM workspace_agent_submit_claims
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1'
  AND client_submit_id = 'accepted-legacy'
`).Scan(&acceptedCanonical); err != nil || !acceptedCanonical.Valid || acceptedCanonical.String != "turn-accepted" {
		t.Fatalf("accepted legacy canonical=%#v err=%v", acceptedCanonical, err)
	}
	var preparedCanonical sql.NullString
	var preparedStatus string
	if err := store.db.QueryRowContext(ctx, `
SELECT canonical_turn_id, status FROM workspace_agent_submit_claims
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1'
  AND client_submit_id = 'prepared-legacy'
`).Scan(&preparedCanonical, &preparedStatus); err != nil || preparedCanonical.Valid || preparedStatus != "prepared" {
		t.Fatalf("prepared legacy canonical=%#v status=%q err=%v", preparedCanonical, preparedStatus, err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV3(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV4(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_submit_claims
  (workspace_id, agent_session_id, client_submit_id, status, turn_id, created_at_unix_ms, updated_at_unix_ms, canonical_turn_id)
VALUES ('ws-1', 'session-1', 'rejected-v3', 'rejected', 'turn-rejected', 3, 4, 'turn-rejected');
`); err != nil {
		t.Fatalf("insert rejected v3 claim: %v", err)
	}
	rejected, ok, err := store.getSubmitClaim(ctx, "ws-1", "session-1", "rejected-v3")
	if err != nil || !ok || rejected.Status != "rejected" || rejected.TurnID != "turn-rejected" {
		t.Fatalf("rejected v3 claim=%#v ok=%v err=%v", rejected, ok, err)
	}
}

func TestSubmitClaimV4RepairsMissingMigrationMarkerWhenColumnAlreadyExists(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := New(openTestDB(t), testOptions(&staticProjectPaths{}))
	if _, err := store.db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);`); err != nil {
		t.Fatal(err)
	}
	for _, migrate := range []func(context.Context) error{
		store.applyWorkspaceAgentSubmitClaimsV1,
		store.applyWorkspaceAgentSubmitClaimsV2,
		store.applyWorkspaceAgentSubmitClaimsV3,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a process that committed the old non-transactional ALTER but
	// crashed before recording the migration marker.
	if _, err := store.db.ExecContext(ctx, `
ALTER TABLE workspace_agent_submit_claims
  ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object');
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV4(ctx); err != nil {
		t.Fatalf("first V4 repair: %v", err)
	}
	if err := store.applyWorkspaceAgentSubmitClaimsV4(ctx); err != nil {
		t.Fatalf("idempotent V4 rerun: %v", err)
	}
	var migrationCount int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentSubmitClaimsV4).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("V4 migration count=%d err=%v", migrationCount, err)
	}
}

func TestSubmitClaimTransitionsContinueDuringActiveSessionFork(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)

	if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "source", ClientSubmitID: "accepted",
		CanonicalTurnID: "turn-2", NowUnixMS: 50,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AcceptSubmitClaim(ctx, "ws-1", "source", "accepted", "turn-2", 51); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-claim-fence", WorkspaceID: "ws-1",
		RequestID: "request-claim-fence", RequestHash: "hash-claim-fence",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-claim-fence",
		SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}

	claim, changed, err := store.AcceptSubmitClaim(ctx, "ws-1", "source", "accepted", "turn-2", 101)
	if err != nil || changed || claim.Status != "accepted" {
		t.Fatalf("accepted replay claim=%#v changed=%v error=%v", claim, changed, err)
	}
	if claim, changed, err := store.AcceptSubmitClaim(
		ctx, "ws-1", "source", "accepted", "turn-other", 101,
	); !errors.Is(err, ErrSubmitClaimTurnConflict) || changed || claim.Status != "accepted" {
		t.Fatalf("conflicting replay claim=%#v changed=%v error=%v", claim, changed, err)
	}
	if deleted, err := store.DeleteSubmitClaim(ctx, "ws-1", "source", "accepted"); err != nil || !deleted {
		t.Fatalf("delete accepted during fork deleted=%v error=%v", deleted, err)
	}
	if deleted, err := store.DeleteSubmitClaim(ctx, "ws-1", "source", "absent"); err != nil || deleted {
		t.Fatalf("delete absent during fork deleted=%v error=%v", deleted, err)
	}

	// Prepared submit claims remain independently mutable after the Fork
	// snapshot is frozen.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_submit_claims (
  workspace_id, agent_session_id, client_submit_id, status, turn_id,
  created_at_unix_ms, updated_at_unix_ms, canonical_turn_id
) VALUES ('ws-1', 'source', 'legacy-prepared', 'prepared', NULL, 99, 99, 'turn-2')
`); err != nil {
		t.Fatal(err)
	}
	if claim, changed, err := store.AcceptSubmitClaim(
		ctx, "ws-1", "source", "legacy-prepared", "turn-2", 102,
	); err != nil || !changed || claim.Status != "accepted" {
		t.Fatalf("accept prepared during fork claim=%#v changed=%v error=%v", claim, changed, err)
	}
	if deleted, err := store.DeleteSubmitClaim(ctx, "ws-1", "source", "legacy-prepared"); err != nil || !deleted {
		t.Fatalf("delete prepared during fork deleted=%v error=%v", deleted, err)
	}
	persisted, ok, err := store.GetSubmitClaim(ctx, "ws-1", "source", "legacy-prepared")
	if err != nil || ok || persisted != (SubmitClaim{}) {
		t.Fatalf("prepared claim after fenced transitions=%#v ok=%v error=%v", persisted, ok, err)
	}
}

func TestSubmitClaimResolutionAndSessionForkPrepareSerialize(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		resolve func(context.Context, *Store) error
	}{
		{
			name: "accept",
			resolve: func(ctx context.Context, store *Store) error {
				_, changed, err := store.AcceptSubmitClaim(
					ctx, "ws-1", "source", "concurrent", "turn-2", 60,
				)
				if err == nil && !changed {
					return errors.New("concurrent accept did not change the prepared claim")
				}
				return err
			},
		},
		{
			name: "delete",
			resolve: func(ctx context.Context, store *Store) error {
				deleted, err := store.DeleteSubmitClaim(ctx, "ws-1", "source", "concurrent")
				if err == nil && !deleted {
					return errors.New("concurrent delete did not remove the prepared claim")
				}
				return err
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := context.Background()
			seedForkSession(t, store)
			if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
				WorkspaceID: "ws-1", AgentSessionID: "source", ClientSubmitID: "concurrent",
				CanonicalTurnID: "turn-2", NowUnixMS: 50,
			}); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var group sync.WaitGroup
			var resolveErr, forkErr error
			group.Add(2)
			go func() {
				defer group.Done()
				<-start
				resolveErr = test.resolve(ctx, store)
			}()
			go func() {
				defer group.Done()
				<-start
				_, _, forkErr = store.PrepareSessionFork(ctx, SessionForkPrepare{
					OperationID: "fork-concurrent", WorkspaceID: "ws-1",
					RequestID: "request-concurrent", RequestHash: "hash-concurrent",
					SourceAgentSessionID: "source", TargetAgentSessionID: "target-concurrent",
					SourceTurnID: "turn-1", PointKind: SessionForkPointThroughTurn,
					DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
				})
			}()
			close(start)
			group.Wait()

			if resolveErr != nil {
				t.Fatalf("resolve prepared claim error=%v", resolveErr)
			}
			if forkErr != nil && !errors.Is(forkErr, ErrSessionForkSourceState) {
				t.Fatalf("PrepareSessionFork() error=%v", forkErr)
			}
			claim, found, err := store.GetSubmitClaim(ctx, "ws-1", "source", "concurrent")
			if err != nil {
				t.Fatal(err)
			}
			if test.name == "accept" && (!found || claim.Status != "accepted") {
				t.Fatalf("accepted claim=%#v found=%v", claim, found)
			}
			if test.name == "delete" && found {
				t.Fatalf("deleted claim still exists: %#v", claim)
			}
		})
	}
}
