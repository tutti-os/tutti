package workspace

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func createCollabRunTestWorkspace(t *testing.T, store *SQLiteStore, workspaceID string) {
	t.Helper()
	if err := store.Create(context.Background(), workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Collaboration Run Workspace",
	}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
}

func TestSQLiteStoreCollaborationRunRoundTrip(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createCollabRunTestWorkspace(t, store, "ws-collab")

	now := time.UnixMilli(1700000000000).UTC()
	run := collabrunbiz.Run{
		ID:              "cr-test",
		WorkspaceID:     "ws-collab",
		Mode:            collabrunbiz.ModeConsult,
		TriggerSource:   collabrunbiz.TriggerAgent,
		TriggerReason:   "second_opinion",
		SourceSessionID: "session-1",
		ModelPlanID:     "mp-1",
		Model:           "fake-mini",
		ContextScope:    "full",
		Prompt:          "context\n\nquestion",
		RequestText:     "question",
		ContextText:     "context",
		RetryOfRunID:    "cr-parent",
		Attempt:         2,
		ResultText:      "advice text",
		FailureStage:    "provider_completion",
		Status:          collabrunbiz.StatusCompleted,
		Adoption:        collabrunbiz.AdoptionPending,
		Usage: collabrunbiz.Usage{
			InputTokens:      42,
			OutputTokens:     7,
			CacheReadTokens:  18,
			CacheWriteTokens: 3,
		},
		Cost:        collabrunbiz.Cost{Currency: "USD", EstimatedMicros: 56},
		StartedAt:   now,
		CompletedAt: now.Add(1200 * time.Millisecond),
		DurationMs:  1200,
		CreatedAt:   now,
		UpdatedAt:   now.Add(1200 * time.Millisecond),
	}
	if err := store.PutCollaborationRun(ctx, run); err != nil {
		t.Fatalf("PutCollaborationRun() error = %v", err)
	}

	loaded, err := store.GetCollaborationRun(ctx, "ws-collab", "cr-test")
	if err != nil {
		t.Fatalf("GetCollaborationRun() error = %v", err)
	}
	if loaded != run {
		t.Fatalf("GetCollaborationRun() = %#v, want %#v", loaded, run)
	}

	// Update transition persists over the same key.
	loaded.Adoption = collabrunbiz.AdoptionAdopted
	loaded.UpdatedAt = now.Add(2 * time.Second)
	if err := store.PutCollaborationRun(ctx, loaded); err != nil {
		t.Fatalf("PutCollaborationRun(update) error = %v", err)
	}
	updated, err := store.GetCollaborationRun(ctx, "ws-collab", "cr-test")
	if err != nil {
		t.Fatalf("GetCollaborationRun(update) error = %v", err)
	}
	if updated.Adoption != collabrunbiz.AdoptionAdopted {
		t.Fatalf("updated adoption = %q, want adopted", updated.Adoption)
	}

	if _, err := store.GetCollaborationRun(ctx, "ws-collab", "cr-missing"); !errors.Is(err, ErrCollaborationRunNotFound) {
		t.Fatalf("GetCollaborationRun(missing) error = %v, want ErrCollaborationRunNotFound", err)
	}
}

func TestSQLiteStoreCollaborationRunListFiltersAndLimits(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createCollabRunTestWorkspace(t, store, "ws-collab-list")

	base := time.UnixMilli(1700000000000).UTC()
	for index := 0; index < 3; index++ {
		sourceSessionID := "session-a"
		if index == 2 {
			sourceSessionID = "session-b"
		}
		run := collabrunbiz.Run{
			ID:              fmt.Sprintf("cr-%d", index),
			WorkspaceID:     "ws-collab-list",
			Mode:            collabrunbiz.ModeConsult,
			TriggerSource:   collabrunbiz.TriggerUser,
			SourceSessionID: sourceSessionID,
			Status:          collabrunbiz.StatusCompleted,
			Adoption:        collabrunbiz.AdoptionPending,
			CreatedAt:       base.Add(time.Duration(index) * time.Minute),
			UpdatedAt:       base.Add(time.Duration(index) * time.Minute),
		}
		if err := store.PutCollaborationRun(ctx, run); err != nil {
			t.Fatalf("PutCollaborationRun(%d) error = %v", index, err)
		}
	}

	all, err := store.ListCollaborationRuns(ctx, "ws-collab-list", "", 0)
	if err != nil {
		t.Fatalf("ListCollaborationRuns() error = %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("ListCollaborationRuns() len = %d, want 3", len(all))
	}
	if all[0].ID != "cr-2" || all[2].ID != "cr-0" {
		t.Fatalf("ListCollaborationRuns() order = %q..%q, want newest first", all[0].ID, all[2].ID)
	}

	filtered, err := store.ListCollaborationRuns(ctx, "ws-collab-list", "session-a", 0)
	if err != nil {
		t.Fatalf("ListCollaborationRuns(filter) error = %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("ListCollaborationRuns(filter) len = %d, want 2", len(filtered))
	}

	limited, err := store.ListCollaborationRuns(ctx, "ws-collab-list", "", 1)
	if err != nil {
		t.Fatalf("ListCollaborationRuns(limit) error = %v", err)
	}
	if len(limited) != 1 || limited[0].ID != "cr-2" {
		t.Fatalf("ListCollaborationRuns(limit) = %#v, want [cr-2]", limited)
	}

	other, err := store.ListCollaborationRuns(ctx, "ws-other", "", 0)
	if err != nil {
		t.Fatalf("ListCollaborationRuns(other) error = %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("ListCollaborationRuns(other) len = %d, want 0", len(other))
	}
}
