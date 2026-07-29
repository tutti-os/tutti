package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
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
	if len(prompts) != 2 || prompts[0].ID != "second" || prompts[1].ID != "first" || prompts[1].Version != 2 {
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
	anchor := "prompt-099"
	prompts, changed, err := store.MoveAgentQuickPrompt(ctx, "prompt-000", &anchor, 1, 200)
	if err != nil || !changed {
		t.Fatalf("100-item move changed = %v, error = %v", changed, err)
	}
	if len(prompts) != agentquickpromptbiz.MaxPrompts || prompts[0].ID != "prompt-000" || prompts[0].Version != 2 {
		t.Fatalf("100-item move result = first:%#v count:%d", prompts[0], len(prompts))
	}
	prompts, changed, err = store.MoveAgentQuickPrompt(ctx, "prompt-000", nil, 2, 201)
	if err != nil || !changed || len(prompts) != agentquickpromptbiz.MaxPrompts {
		t.Fatalf("100-item reverse move changed = %v, error = %v, count = %d", changed, err, len(prompts))
	}
	if prompts[len(prompts)-1].ID != "prompt-000" || prompts[len(prompts)-1].Version != 3 {
		t.Fatalf("100-item reverse move last = %#v", prompts[len(prompts)-1])
	}
}

func TestSQLiteStoreMoveAgentQuickPromptUsesAnchorAndVersionFence(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for index, id := range []string{"first", "second", "third"} {
		if err := store.CreateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
			ID: id, Title: id, Content: "private", Version: 1,
			CreatedAtUnixMS: int64(index + 1), UpdatedAtUnixMS: int64(index + 1),
		}); err != nil {
			t.Fatalf("CreateAgentQuickPrompt(%s) error = %v", id, err)
		}
	}
	// Creation is newest-first: third, second, first. Move first before third.
	beforeThird := "third"
	prompts, changed, err := store.MoveAgentQuickPrompt(ctx, "first", &beforeThird, 1, 20)
	if err != nil {
		t.Fatalf("MoveAgentQuickPrompt() error = %v", err)
	}
	if !changed || len(prompts) != 3 || prompts[0].ID != "first" || prompts[0].Version != 2 || prompts[1].ID != "third" || prompts[2].ID != "second" {
		t.Fatalf("moved prompts = %#v, changed = %v", prompts, changed)
	}
	if _, _, err := store.MoveAgentQuickPrompt(ctx, "first", nil, 1, 21); !errors.Is(err, agentquickpromptbiz.ErrVersionConflict) {
		t.Fatalf("stale move error = %v, want version conflict", err)
	}
	missing := "missing"
	if _, _, err := store.MoveAgentQuickPrompt(ctx, "first", &missing, 2, 22); !errors.Is(err, agentquickpromptbiz.ErrOrderConflict) {
		t.Fatalf("missing anchor error = %v, want order conflict", err)
	}
	prompts, changed, err = store.MoveAgentQuickPrompt(ctx, "first", &beforeThird, 2, 23)
	if err != nil || changed || prompts[0].Version != 2 {
		t.Fatalf("no-op move prompts = %#v, changed = %v, err = %v", prompts, changed, err)
	}
}

func TestSQLiteStoreAgentQuickPromptOrderStaysDenseAcrossMoveAndCRUD(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for index, id := range []string{"first", "second", "third"} {
		if err := store.CreateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
			ID: id, Title: id, Content: "private", Version: 1,
			CreatedAtUnixMS: int64(index + 1), UpdatedAtUnixMS: int64(index + 1),
		}); err != nil {
			t.Fatalf("CreateAgentQuickPrompt(%s) error = %v", id, err)
		}
	}
	beforeThird := "third"
	if _, changed, err := store.MoveAgentQuickPrompt(ctx, "first", &beforeThird, 1, 20); err != nil || !changed {
		t.Fatalf("MoveAgentQuickPrompt() changed = %v, error = %v", changed, err)
	}
	if _, err := store.UpdateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
		ID: "second", Title: "Second updated", Content: "private", Version: 2, UpdatedAtUnixMS: 21,
	}, 1); err != nil {
		t.Fatalf("UpdateAgentQuickPrompt() error = %v", err)
	}
	if err := store.CreateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
		ID: "fourth", Title: "fourth", Content: "private", Version: 1,
		CreatedAtUnixMS: 22, UpdatedAtUnixMS: 22,
	}); err != nil {
		t.Fatalf("CreateAgentQuickPrompt(fourth) error = %v", err)
	}
	if err := store.DeleteAgentQuickPrompt(ctx, "third", 1); err != nil {
		t.Fatalf("DeleteAgentQuickPrompt(third) error = %v", err)
	}
	beforeFourth := "fourth"
	if _, changed, err := store.MoveAgentQuickPrompt(ctx, "second", &beforeFourth, 2, 23); err != nil || !changed {
		t.Fatalf("MoveAgentQuickPrompt(after CRUD) changed = %v, error = %v", changed, err)
	}
	prompts, err := store.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts() error = %v", err)
	}
	if len(prompts) != 3 {
		t.Fatalf("prompt count = %d, want 3", len(prompts))
	}
	if got := []string{prompts[0].ID, prompts[1].ID, prompts[2].ID}; fmt.Sprint(got) != fmt.Sprint([]string{"second", "fourth", "first"}) {
		t.Fatalf("prompt order = %v", got)
	}
	var count, minimum, maximum, distinct int
	if err := store.readDB.QueryRowContext(ctx, `SELECT COUNT(*), MIN(sort_order), MAX(sort_order), COUNT(DISTINCT sort_order) FROM agent_quick_prompts`).Scan(&count, &minimum, &maximum, &distinct); err != nil {
		t.Fatalf("read dense order stats error = %v", err)
	}
	if count != 3 || minimum != 0 || maximum != 2 || distinct != count {
		t.Fatalf("dense order stats = count:%d min:%d max:%d distinct:%d", count, minimum, maximum, distinct)
	}
}

func TestSQLiteStoreMoveAgentQuickPromptRollsBackPartialRewrite(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	for index, id := range []string{"first", "second", "third"} {
		if err := store.CreateAgentQuickPrompt(ctx, agentquickpromptbiz.Prompt{
			ID: id, Title: id, Content: "private", Version: 1,
			CreatedAtUnixMS: int64(index + 1), UpdatedAtUnixMS: int64(index + 1),
		}); err != nil {
			t.Fatalf("CreateAgentQuickPrompt(%s) error = %v", id, err)
		}
	}
	before, err := store.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts(before) error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER fail_agent_quick_prompt_order_rewrite
BEFORE UPDATE OF sort_order ON agent_quick_prompts
WHEN NEW.id = 'second'
BEGIN
  SELECT RAISE(ABORT, 'injected order rewrite failure');
END
`); err != nil {
		t.Fatalf("create failure trigger error = %v", err)
	}
	beforeThird := "third"
	if _, _, err := store.MoveAgentQuickPrompt(ctx, "first", &beforeThird, 1, 20); err == nil {
		t.Fatal("MoveAgentQuickPrompt() error = nil, want injected failure")
	}
	after, err := store.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts(after) error = %v", err)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("move failure changed prompts\nafter: %#v\nbefore: %#v", after, before)
	}
}

func TestAgentQuickPromptsV2MigrationPreservesV1DataAndOrder(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "quick-prompts-v1.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	if _, err := db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES ('agent_quick_prompts_v1', 1);
CREATE TABLE agent_quick_prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX idx_agent_quick_prompts_updated
  ON agent_quick_prompts(updated_at_unix_ms DESC, id ASC);
INSERT INTO agent_quick_prompts
  (id, title, content, version, created_at_unix_ms, updated_at_unix_ms)
VALUES
  ('beta', 'Beta', 'private-beta', 4, 10, 30),
  ('alpha', 'Alpha', 'private-alpha', 2, 5, 30),
  ('old', 'Old', 'private-old', 7, 1, 20);
`); err != nil {
		t.Fatalf("create v1 fixture error = %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close v1 fixture error = %v", err)
	}

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	prompts, err := store.ListAgentQuickPrompts(ctx)
	if err != nil {
		t.Fatalf("ListAgentQuickPrompts() error = %v", err)
	}
	if len(prompts) != 3 || prompts[0].ID != "alpha" || prompts[1].ID != "beta" || prompts[2].ID != "old" {
		t.Fatalf("migrated order = %#v", prompts)
	}
	if prompts[0].Content != "private-alpha" || prompts[0].Version != 2 || prompts[0].CreatedAtUnixMS != 5 || prompts[0].UpdatedAtUnixMS != 30 {
		t.Fatalf("migrated data changed = %#v", prompts[0])
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("second Migrate() error = %v", err)
	}
}
