package workspace

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

func TestSQLiteStoreAgentQuickPromptCRUDAndReopen(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "quick-prompts.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	first := agentquickpromptbiz.Prompt{ID: "first", Title: "First", Content: "secret-one", Version: 1, CreatedAtUnixMS: 1, UpdatedAtUnixMS: 10}
	second := agentquickpromptbiz.Prompt{ID: "second", Title: "Second", Content: "secret-two", Version: 1, CreatedAtUnixMS: 2, UpdatedAtUnixMS: 20}
	if err := store.CreateAgentQuickPrompt(ctx, first); err != nil {
		t.Fatalf("CreateAgentQuickPrompt(first) error = %v", err)
	}
	if err := store.CreateAgentQuickPrompt(ctx, second); err != nil {
		t.Fatalf("CreateAgentQuickPrompt(second) error = %v", err)
	}
	prompts, err := store.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts() error = %v", err)
	}
	if len(prompts) != 2 || prompts[0].ID != "second" || prompts[1].ID != "first" {
		t.Fatalf("prompt order = %#v, want second then first", prompts)
	}

	updated, err := store.UpdateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
		ID: "first", Title: "Updated", Content: "updated-secret", Version: 2, UpdatedAtUnixMS: 30,
	}, 1)
	if err != nil {
		t.Fatalf("UpdateAgentQuickPrompt() error = %v", err)
	}
	if updated.Version != 2 || updated.CreatedAtUnixMS != 1 || updated.Title != "Updated" {
		t.Fatalf("updated prompt = %#v", updated)
	}
	if _, err := store.UpdateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{ID: "first", Title: "stale", Content: "stale", Version: 2, UpdatedAtUnixMS: 31}, 1); !errors.Is(err, agentquickpromptbiz.ErrVersionConflict) {
		t.Fatalf("stale update error = %v, want version conflict", err)
	}
	if err := store.DeleteAgentQuickPrompt(ctx, "missing", 1); !errors.Is(err, agentquickpromptbiz.ErrNotFound) {
		t.Fatalf("missing delete error = %v, want not found", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore(reopen) error = %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if err := reopened.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(reopen) error = %v", err)
	}
	prompts, err = reopened.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts(reopen) error = %v", err)
	}
	if len(prompts) != 2 || prompts[0].ID != "first" || prompts[0].Version != 2 {
		t.Fatalf("reopened prompts = %#v", prompts)
	}
	if err := reopened.DeleteAgentQuickPrompt(ctx, "first", 2); err != nil {
		t.Fatalf("DeleteAgentQuickPrompt() error = %v", err)
	}
}

func TestSQLiteStoreAgentQuickPromptLimitIsAtomic(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for index := 0; index < agentquickpromptbiz.MaxPrompts; index++ {
		prompt := agentquickpromptbiz.Prompt{
			ID: fmt.Sprintf("prompt-%03d", index), Title: "title", Content: "content", Version: 1,
			CreatedAtUnixMS: int64(index + 1), UpdatedAtUnixMS: int64(index + 1),
		}
		if err := store.CreateAgentQuickPrompt(ctx, prompt); err != nil {
			t.Fatalf("CreateAgentQuickPrompt(%d) error = %v", index, err)
		}
	}
	err := store.CreateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{ID: "overflow", Title: "title", Content: "content", Version: 1, CreatedAtUnixMS: 101, UpdatedAtUnixMS: 101})
	if !errors.Is(err, agentquickpromptbiz.ErrLimitExceeded) {
		t.Fatalf("overflow create error = %v, want limit exceeded", err)
	}
}
