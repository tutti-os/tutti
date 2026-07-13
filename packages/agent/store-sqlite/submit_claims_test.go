package storesqlite

import (
	"context"
	"testing"
)

func TestSubmitClaimIsDurableAndIdempotent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	input := SubmitClaimPrepare{WorkspaceID: "ws-1", AgentSessionID: "session-1", ClientSubmitID: "submit-1", NowUnixMS: 10}
	first, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || !created || first.Status != "prepared" {
		t.Fatalf("first = %#v created=%v err=%v", first, created, err)
	}
	duplicate, created, err := store.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.Status != "prepared" {
		t.Fatalf("duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
	accepted, updated, err := store.AcceptSubmitClaim(context.Background(), "ws-1", "session-1", "submit-1", "turn-1", 20)
	if err != nil || !updated || accepted.Status != "accepted" || accepted.TurnID != "turn-1" {
		t.Fatalf("accepted = %#v updated=%v err=%v", accepted, updated, err)
	}
	afterRestart := New(store.db, store.opts)
	duplicate, created, err = afterRestart.PrepareSubmitClaim(context.Background(), input)
	if err != nil || created || duplicate.TurnID != "turn-1" {
		t.Fatalf("restart duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
}
