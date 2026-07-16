package workspace

import (
	"context"
	"encoding/json"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreMigrationUnifiesAgentGUIDockIdentity(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-agent-gui-dock-migration"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Agent GUI Dock Migration"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	const snapshotJSON = `{
  "schemaVersion": 1,
  "nodes": [
    {"id":"agent-legacy","kind":"agent-gui","data":{"dockEntryId":"agent-gui","instanceId":"agent-gui:codex:panel:1","typeId":"agent-gui"}},
    {"id":"agent-provider","kind":"agent-gui","data":{"dockEntryId":"agent-gui:codex","instanceId":"agent-gui:codex:panel:2","typeId":"agent-gui"}},
    {"id":"agent-null","kind":"agent-gui","data":{"dockEntryId":null,"instanceId":"agent-gui:claude-code:panel:3","typeId":"agent-gui"}},
    {"id":"agent-missing","kind":"agent-gui","data":{"instanceId":"agent-gui:codex:panel:4","typeId":"agent-gui"}},
    {"id":"agent-unified","kind":"agent-gui","data":{"dockEntryId":"agent-gui:unified","instanceId":"agent-gui:codex:panel:5","typeId":"agent-gui"}},
    {"id":"app","kind":"workspace-app-webview","data":{"dockEntryId":"workspace-app:calendar","instanceId":"app:calendar","typeId":"workspace-app-webview"}}
  ],
  "nodeStack": ["agent-legacy", "app"],
  "metadata": {
    "workbenchHostClosedDockWindowFrames": {
      "version": 1,
      "entries": [
        {"dockEntryId":"agent-gui","typeId":"agent-gui","frame":{"x":1,"y":1,"width":111,"height":111}},
        {"dockEntryId":"workspace-app:calendar","typeId":"workspace-app-webview","frame":{"x":2,"y":2,"width":222,"height":222}},
        {"dockEntryId":"agent-gui:unified","typeId":"agent-gui","frame":{"x":3,"y":3,"width":333,"height":333}},
        {"dockEntryId":"agent-gui:codex","typeId":"agent-gui","frame":{"x":4,"y":4,"width":444,"height":444}}
      ]
    }
  }
}`
	if err := store.PutWorkbenchSnapshot(ctx, workspacebiz.WorkbenchSnapshot{
		JSON:          []byte(snapshotJSON),
		SchemaVersion: 1,
		WorkspaceID:   workspaceID,
	}); err != nil {
		t.Fatalf("PutWorkbenchSnapshot() error = %v", err)
	}

	var originalUpdatedAt int64
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT updated_at_unix_ms
FROM workspace_workbench_snapshots
WHERE workspace_id = ?
`, workspaceID).Scan(&originalUpdatedAt); err != nil {
		t.Fatalf("read original snapshot timestamp: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?
`, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1); err != nil {
		t.Fatalf("delete migration marker: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	migrated := readTestWorkbenchSnapshotMigration(t, store, workspaceID)
	for _, node := range migrated.Nodes {
		if node.TypeID == agentGUIWorkbenchTypeID && node.DockEntryID != agentGUIWorkbenchUnifiedDockEntryID {
			t.Fatalf("AgentGUI node %q dockEntryId = %q, want %q", node.ID, node.DockEntryID, agentGUIWorkbenchUnifiedDockEntryID)
		}
		if node.ID == "app" && node.DockEntryID != "workspace-app:calendar" {
			t.Fatalf("workspace app dockEntryId = %q, want workspace-app:calendar", node.DockEntryID)
		}
	}
	if len(migrated.ClosedFrames) != 2 {
		t.Fatalf("closed frame entries len = %d, want 2", len(migrated.ClosedFrames))
	}
	if migrated.ClosedFrames[0].DockEntryID != "workspace-app:calendar" {
		t.Fatalf("workspace app closed frame dockEntryId = %q", migrated.ClosedFrames[0].DockEntryID)
	}
	if migrated.ClosedFrames[1].DockEntryID != agentGUIWorkbenchUnifiedDockEntryID || migrated.ClosedFrames[1].Frame.Width != 444 {
		t.Fatalf("AgentGUI closed frame = %+v, want final legacy entry normalized", migrated.ClosedFrames[1])
	}

	var migratedUpdatedAt int64
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT updated_at_unix_ms
FROM workspace_workbench_snapshots
WHERE workspace_id = ?
`, workspaceID).Scan(&migratedUpdatedAt); err != nil {
		t.Fatalf("read migrated snapshot timestamp: %v", err)
	}
	if migratedUpdatedAt != originalUpdatedAt {
		t.Fatalf("snapshot updated_at = %d, want unchanged %d", migratedUpdatedAt, originalUpdatedAt)
	}

	firstJSON := readTestWorkbenchSnapshotJSON(t, store, workspaceID)
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("second Migrate() error = %v", err)
	}
	if secondJSON := readTestWorkbenchSnapshotJSON(t, store, workspaceID); secondJSON != firstJSON {
		t.Fatal("second migration changed the normalized snapshot")
	}
}

func TestSQLiteStoreAgentGUIDockMigrationRollsBackInvalidSnapshotJSON(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-invalid-agent-gui-dock-migration"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Invalid Agent GUI Dock Migration"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := store.PutWorkbenchSnapshot(ctx, workspacebiz.WorkbenchSnapshot{
		JSON:          []byte(`{"schemaVersion":1`),
		SchemaVersion: 1,
		WorkspaceID:   workspaceID,
	}); err != nil {
		t.Fatalf("PutWorkbenchSnapshot() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?
`, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1); err != nil {
		t.Fatalf("delete migration marker: %v", err)
	}

	if err := store.Migrate(ctx); err == nil {
		t.Fatal("Migrate() error = nil, want invalid snapshot error")
	}
	applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if applied {
		t.Fatal("migration marker was recorded after rollback")
	}
	if storedJSON := readTestWorkbenchSnapshotJSON(t, store, workspaceID); storedJSON != `{"schemaVersion":1` {
		t.Fatalf("invalid snapshot changed to %q", storedJSON)
	}
}

func TestSQLiteStoreMigrationFiltersAgentGUINodesWithoutValidTargetIdentity(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-agent-gui-target-migration"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Agent GUI Target Migration"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT OR IGNORE INTO agent_targets (
  id, provider, launch_ref_json, name, icon_key, enabled, source,
  sort_order, created_at_ms, updated_at_ms
) VALUES (
  'local:codex', 'codex', '{"type":"local_cli","provider":"codex"}',
  'Codex', 'codex', 1, 'system', 10, 1, 1
)
`); err != nil {
		t.Fatalf("insert target fixture: %v", err)
	}
	const snapshotJSON = `{
  "schemaVersion": 1,
  "nodes": [
    {"id":"agent-valid","kind":"agent-gui","data":{"typeId":"agent-gui","snapshotNodeState":{"agentTargetId":"local:codex"}}},
    {"id":"agent-missing","kind":"agent-gui","data":{"typeId":"agent-gui","snapshotNodeState":{}}},
    {"id":"agent-unknown","kind":"agent-gui","data":{"typeId":"agent-gui","snapshotNodeState":{"agentTargetId":"missing-target"}}},
    {"id":"app","kind":"workspace-app-webview","data":{"typeId":"workspace-app-webview"}}
  ],
  "nodeStack": ["agent-valid", "agent-missing", "agent-unknown", "app"],
  "activeNodeId": "agent-unknown",
  "spaces": [{"id":"space-1","name":"One","nodeIds":["agent-valid","agent-missing","agent-unknown","app"]}]
}`
	if err := store.PutWorkbenchSnapshot(ctx, workspacebiz.WorkbenchSnapshot{
		JSON: []byte(snapshotJSON), SchemaVersion: 1, WorkspaceID: workspaceID,
	}); err != nil {
		t.Fatalf("PutWorkbenchSnapshot() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceWorkbenchAgentTargetIdentityV1); err != nil {
		t.Fatalf("delete migration marker: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	var migrated struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
		NodeStack    []string `json:"nodeStack"`
		ActiveNodeID *string  `json:"activeNodeId"`
		Spaces       []struct {
			NodeIDs []string `json:"nodeIds"`
		} `json:"spaces"`
	}
	if err := json.Unmarshal([]byte(readTestWorkbenchSnapshotJSON(t, store, workspaceID)), &migrated); err != nil {
		t.Fatalf("decode migrated snapshot: %v", err)
	}
	if len(migrated.Nodes) != 2 || migrated.Nodes[0].ID != "agent-valid" || migrated.Nodes[1].ID != "app" {
		t.Fatalf("nodes = %+v, want valid AgentGUI node and app", migrated.Nodes)
	}
	if got := migrated.NodeStack; len(got) != 2 || got[0] != "agent-valid" || got[1] != "app" {
		t.Fatalf("nodeStack = %v, want [agent-valid app]", got)
	}
	if migrated.ActiveNodeID != nil {
		t.Fatalf("activeNodeId = %v, want null", migrated.ActiveNodeID)
	}
	if len(migrated.Spaces) != 1 || len(migrated.Spaces[0].NodeIDs) != 2 {
		t.Fatalf("spaces = %+v, want only retained node ids", migrated.Spaces)
	}
}

type testWorkbenchSnapshotMigration struct {
	Nodes        []testWorkbenchSnapshotMigrationNode
	ClosedFrames []testWorkbenchSnapshotMigrationClosedFrame
}

type testWorkbenchSnapshotMigrationNode struct {
	ID          string
	TypeID      string
	DockEntryID string
}

type testWorkbenchSnapshotMigrationClosedFrame struct {
	DockEntryID string
	Frame       struct {
		Width float64 `json:"width"`
	}
	TypeID string
}

type testWorkbenchSnapshotMigrationRawClosedFrame struct {
	DockEntryID string `json:"dockEntryId"`
	Frame       struct {
		Width float64 `json:"width"`
	} `json:"frame"`
	TypeID string `json:"typeId"`
}

func readTestWorkbenchSnapshotMigration(t *testing.T, store *SQLiteStore, workspaceID string) testWorkbenchSnapshotMigration {
	t.Helper()

	storedJSON := readTestWorkbenchSnapshotJSON(t, store, workspaceID)
	var raw struct {
		Nodes []struct {
			ID   string `json:"id"`
			Data struct {
				DockEntryID string `json:"dockEntryId"`
				TypeID      string `json:"typeId"`
			} `json:"data"`
		} `json:"nodes"`
		Metadata struct {
			ClosedFrames struct {
				Entries []testWorkbenchSnapshotMigrationRawClosedFrame `json:"entries"`
			} `json:"workbenchHostClosedDockWindowFrames"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(storedJSON), &raw); err != nil {
		t.Fatalf("decode migrated snapshot: %v", err)
	}

	result := testWorkbenchSnapshotMigration{}
	for _, entry := range raw.Metadata.ClosedFrames.Entries {
		result.ClosedFrames = append(result.ClosedFrames, testWorkbenchSnapshotMigrationClosedFrame(entry))
	}
	for _, node := range raw.Nodes {
		result.Nodes = append(result.Nodes, testWorkbenchSnapshotMigrationNode{
			ID: node.ID, TypeID: node.Data.TypeID, DockEntryID: node.Data.DockEntryID,
		})
	}
	return result
}

func readTestWorkbenchSnapshotJSON(t *testing.T, store *SQLiteStore, workspaceID string) string {
	t.Helper()

	var snapshotJSON string
	if err := store.writeDB.QueryRowContext(context.Background(), `
SELECT snapshot_json
FROM workspace_workbench_snapshots
WHERE workspace_id = ?
`, workspaceID).Scan(&snapshotJSON); err != nil {
		t.Fatalf("read workbench snapshot json: %v", err)
	}
	return snapshotJSON
}
