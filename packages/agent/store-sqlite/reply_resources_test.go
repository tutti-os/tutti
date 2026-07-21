package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestReplyResourceBindsToActiveTurnAndDeduplicates(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 1,
	}); err != nil || !accepted {
		t.Fatalf("record running turn accepted=%v error=%v", accepted, err)
	}

	input := AttachReplyResourceInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", ResourceID: "resource-1",
		DedupeKey: "sha256:abc", Kind: ReplyResourceKindLocalFile, SourceRef: "sha256_abc",
		ContentHash: "abc", DisplayName: "chart.png", MediaType: "image/png", SizeBytes: 42, CreatedAtUnixMS: 2,
	}
	first, created, err := store.AttachReplyResourceToActiveTurn(ctx, input)
	if err != nil || !created {
		t.Fatalf("first attach resource=%#v created=%v error=%v", first, created, err)
	}
	input.ResourceID = "resource-duplicate"
	duplicate, created, err := store.AttachReplyResourceToActiveTurn(ctx, input)
	if err != nil || created {
		t.Fatalf("duplicate attach resource=%#v created=%v error=%v", duplicate, created, err)
	}
	if duplicate.ResourceID != "resource-1" || duplicate.TurnID != "turn-1" {
		t.Fatalf("deduplicated resource = %#v", duplicate)
	}

	resources, err := store.ListTurnReplyResources(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || len(resources) != 1 || resources[0].ResourceID != "resource-1" {
		t.Fatalf("turn resources = %#v, error=%v", resources, err)
	}
}

func TestReplyResourceRejectsAfterTurnSettlement(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	for _, transition := range []TurnTransition{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseRunning, OccurredAtUnixMS: 1},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 2},
	} {
		if _, accepted, err := store.RecordTurnTransition(ctx, transition); err != nil || !accepted {
			t.Fatalf("record transition %#v accepted=%v error=%v", transition, accepted, err)
		}
	}

	_, _, err := store.AttachReplyResourceToActiveTurn(ctx, AttachReplyResourceInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", ResourceID: "late",
		DedupeKey: "sha256:late", Kind: ReplyResourceKindLocalFile, SourceRef: "sha256_late",
		DisplayName: "late.txt", CreatedAtUnixMS: 3,
	})
	if !errors.Is(err, ErrNoActiveTurn) {
		t.Fatalf("late attach error = %v, want %v", err, ErrNoActiveTurn)
	}
}

func TestReplyResourceRejectsStaleTurnAfterNextTurnStarts(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	for _, transition := range []TurnTransition{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseRunning, OccurredAtUnixMS: 1},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 2},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-2", Phase: TurnPhaseRunning, OccurredAtUnixMS: 3},
	} {
		if _, accepted, err := store.RecordTurnTransition(ctx, transition); err != nil || !accepted {
			t.Fatalf("record transition %#v accepted=%v error=%v", transition, accepted, err)
		}
	}

	_, _, err := store.AttachReplyResourceToActiveTurn(ctx, AttachReplyResourceInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", ResourceID: "stale",
		DedupeKey: "sha256:stale", Kind: ReplyResourceKindLocalFile, SourceRef: "sha256_stale",
		DisplayName: "stale.txt", CreatedAtUnixMS: 4,
	})
	if !errors.Is(err, ErrNoActiveTurn) {
		t.Fatalf("stale turn attach error = %v, want %v", err, ErrNoActiveTurn)
	}
}
