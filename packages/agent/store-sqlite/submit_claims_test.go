package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestSubmitClaimIsDurableAndIdempotent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	input := SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: "submit-1",
		CanonicalTurnID: "turn-1", NowUnixMS: 10,
	}
	first, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || !created || first.Status != "prepared" || first.CanonicalTurnID != "turn-1" || first.TurnID != "" {
		t.Fatalf("first = %#v created=%v err=%v", first, created, err)
	}
	input.CanonicalTurnID = "turn-retry-must-be-ignored"
	duplicate, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.Status != "prepared" || duplicate.CanonicalTurnID != "turn-1" {
		t.Fatalf("duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
	accepted, updated, err := store.AcceptSubmitClaim(context.Background(), "ws-1", "session-1", "submit-1", "turn-1", 20)
	if err != nil || !updated || accepted.Status != "accepted" || accepted.TurnID != "turn-1" {
		t.Fatalf("accepted = %#v updated=%v err=%v", accepted, updated, err)
	}
	afterRestart := New(store.db, store.opts)
	duplicate, created, err = afterRestart.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.TurnID != "turn-1" || duplicate.CanonicalTurnID != "turn-1" {
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
	accepted, ok, err := store.getSubmitClaim(ctx, "ws-1", "session-1", "accepted-legacy")
	if err != nil || !ok || accepted.CanonicalTurnID != "turn-accepted" {
		t.Fatalf("accepted legacy claim=%#v ok=%v err=%v", accepted, ok, err)
	}
	prepared, ok, err := store.getSubmitClaim(ctx, "ws-1", "session-1", "prepared-legacy")
	if err != nil || !ok || prepared.CanonicalTurnID != "" || prepared.Status != "prepared" {
		t.Fatalf("prepared legacy claim=%#v ok=%v err=%v", prepared, ok, err)
	}
}
