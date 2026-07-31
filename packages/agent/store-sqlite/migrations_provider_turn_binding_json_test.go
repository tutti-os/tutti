package storesqlite

import (
	"context"
	"testing"
)

func TestProviderTurnBindingJSONMigrationLeavesHistoricalRowsUnbound(
	t *testing.T,
) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if _, err := db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE workspace_agent_turns (
  turn_id TEXT PRIMARY KEY,
  root_provider_turn_id TEXT
);
CREATE TABLE workspace_agent_session_fork_operations (
  operation_id TEXT PRIMARY KEY
);
INSERT INTO workspace_agent_turns (turn_id, root_provider_turn_id)
VALUES ('turn-legacy', 'synthetic-legacy');
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentProviderTurnBindingJSONV1(ctx); err != nil {
		t.Fatal(err)
	}
	var binding string
	if err := db.QueryRowContext(ctx, `
SELECT provider_turn_binding_json
FROM workspace_agent_turns
WHERE turn_id = 'turn-legacy'
`).Scan(&binding); err != nil {
		t.Fatal(err)
	}
	if binding != "{}" {
		t.Fatalf("historical binding json = %q, want empty object", binding)
	}
	if _, err := db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET provider_turn_binding_json = '[]'
WHERE turn_id = 'turn-legacy'
`); err == nil {
		t.Fatal("non-object provider binding unexpectedly passed schema constraint")
	}
}

func TestHistoricalProviderTurnIDWithoutBindingJSONRemainsUnusable(
	t *testing.T,
) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", ProviderSessionID: "provider-session",
		OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "turn-legacy",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted,
		OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed historical turn accepted=%v error=%v", accepted, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = 'synthetic-legacy'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'root'
  AND turn_id = 'turn-legacy'
`); err != nil {
		t.Fatal(err)
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "root", "turn-legacy")
	if err != nil || !found {
		t.Fatalf("GetTurn() found=%v error=%v", found, err)
	}
	if HasPersistedProviderTurnBinding(turn) {
		t.Fatalf("historical turn unexpectedly usable: %#v", turn)
	}
}

func TestProviderTurnBindingJSONMigrationConvertsAndDropsLegacyClaudeColumns(
	t *testing.T,
) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if _, err := db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE workspace_agent_turns (
  turn_id TEXT PRIMARY KEY,
  root_provider_turn_id TEXT,
  provider_checkpoint_message_id TEXT
);
CREATE TABLE workspace_agent_session_fork_operations (
  operation_id TEXT PRIMARY KEY,
  source_provider_turn_id TEXT,
  source_provider_checkpoint_message_id TEXT,
  target_provider_turn_ids_json TEXT NOT NULL DEFAULT '[]',
  target_provider_checkpoint_message_id TEXT,
  target_provider_turn_bindings_json TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO workspace_agent_turns (
  turn_id, root_provider_turn_id, provider_checkpoint_message_id
) VALUES
  ('turn-valid', 'provider-turn-valid', 'checkpoint-valid'),
  ('turn-historical', 'synthetic-historical', NULL);
INSERT INTO workspace_agent_session_fork_operations (
  operation_id,
  source_provider_turn_id,
  source_provider_checkpoint_message_id,
  target_provider_turn_ids_json,
  target_provider_checkpoint_message_id
) VALUES (
  'fork-1',
  'provider-turn-valid',
  'checkpoint-valid',
  '["provider-turn-child"]',
  'checkpoint-child'
);
`); err != nil {
		t.Fatal(err)
	}

	if err := store.applyWorkspaceAgentProviderTurnBindingJSONV1(ctx); err != nil {
		t.Fatal(err)
	}

	var validBinding, historicalBinding string
	if err := db.QueryRowContext(ctx, `
SELECT provider_turn_binding_json
FROM workspace_agent_turns
WHERE turn_id = 'turn-valid'
`).Scan(&validBinding); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `
SELECT provider_turn_binding_json
FROM workspace_agent_turns
WHERE turn_id = 'turn-historical'
`).Scan(&historicalBinding); err != nil {
		t.Fatal(err)
	}
	if validBinding !=
		`{"schemaVersion":1,"checkpointMessageId":"checkpoint-valid"}` {
		t.Fatalf("valid binding = %q", validBinding)
	}
	if historicalBinding != "{}" {
		t.Fatalf("historical binding = %q, want empty object", historicalBinding)
	}

	var sourceBinding, targetBindings string
	if err := db.QueryRowContext(ctx, `
SELECT source_provider_turn_binding_json, target_provider_turn_bindings_json
FROM workspace_agent_session_fork_operations
WHERE operation_id = 'fork-1'
`).Scan(&sourceBinding, &targetBindings); err != nil {
		t.Fatal(err)
	}
	if sourceBinding !=
		`{"schemaVersion":1,"checkpointMessageId":"checkpoint-valid"}` {
		t.Fatalf("source binding = %q", sourceBinding)
	}
	if targetBindings !=
		`[{"providerTurnId":"provider-turn-child","providerTurnBindingJson":{"schemaVersion":1,"checkpointMessageId":"checkpoint-child"}}]` {
		t.Fatalf("target bindings = %q", targetBindings)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, column := range []struct {
		table string
		name  string
	}{
		{"workspace_agent_turns", "provider_checkpoint_message_id"},
		{
			"workspace_agent_session_fork_operations",
			"source_provider_checkpoint_message_id",
		},
		{
			"workspace_agent_session_fork_operations",
			"target_provider_checkpoint_message_id",
		},
	} {
		exists, err := hasColumnTx(ctx, tx, column.table, column.name)
		if err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("%s.%s still exists", column.table, column.name)
		}
	}
}
