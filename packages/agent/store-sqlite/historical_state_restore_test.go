package storesqlite

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestRestoreHistoricalSessionGraphBindsRuntimeUserOutsidePortableGraph(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	graph := HistoricalSessionGraph{
		RootSessionID: "session-root",
		Sessions: []HistoricalSession{{
			ID: "session-root", Kind: SessionKindRoot,
			AgentTargetID: "local:codex", Provider: "codex",
			ProviderSessionID: "provider-session-root",
			Settings:          map[string]any{},
			RailSectionKind:   RailSectionKindConversations,
			RailSectionKey:    RailSectionKeyConversations,
			Turns:             []HistoricalTurn{},
			Messages:          []HistoricalMessage{},
			Interactions:      []HistoricalInteraction{},
		}},
	}
	input := HistoricalSessionGraphRestoreInput{
		WorkspaceID: " workspace-replay ",
		UserID:      " user-current ",
		Graph:       graph,
	}
	missingOwner := input
	missingOwner.UserID = ""
	if err := store.RestoreHistoricalSessionGraph(ctx, missingOwner); err == nil {
		t.Fatal("historical restore without a runtime user was accepted")
	}
	if err := store.RestoreHistoricalSessionGraph(ctx, input); err != nil {
		t.Fatal(err)
	}
	session, found, err := store.GetSession(ctx, "workspace-replay", graph.RootSessionID)
	if err != nil || !found {
		t.Fatalf("GetSession() found=%v err=%v", found, err)
	}
	if session.UserID != "user-current" {
		t.Fatalf("restored Session user = %q, want user-current", session.UserID)
	}
	raw, err := json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "user-current") || strings.Contains(string(raw), "userId") {
		t.Fatalf("portable historical graph contains runtime user binding: %s", raw)
	}
	if err := store.RestoreHistoricalSessionGraph(ctx, input); err != nil {
		t.Fatalf("idempotent restore error = %v", err)
	}
	input.UserID = "different-user"
	if err := store.RestoreHistoricalSessionGraph(ctx, input); !errors.Is(err, ErrHistoricalStateConflict) {
		t.Fatalf("different runtime user restore error = %v", err)
	}
}
