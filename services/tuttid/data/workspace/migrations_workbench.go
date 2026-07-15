package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

const (
	agentGUIWorkbenchTypeID             = "agent-gui"
	agentGUIWorkbenchUnifiedDockEntryID = "agent-gui:unified"
	closedDockWindowFramesMetadataKey   = "workbenchHostClosedDockWindowFrames"
)

type storedWorkbenchSnapshotMigrationRow struct {
	snapshotJSON string
	workspaceID  string
}

func (s *SQLiteStore) applyWorkspaceWorkbenchAgentGUIUnifiedDockV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin AgentGUI workbench dock migration: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var workbenchSnapshotTableCount int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM sqlite_master
WHERE type = 'table' AND name = 'workspace_workbench_snapshots'
`).Scan(&workbenchSnapshotTableCount); err != nil {
		return fmt.Errorf("inspect workbench snapshot table for AgentGUI dock migration: %w", err)
	}
	if workbenchSnapshotTableCount == 0 {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1, unixMs(time.Now().UTC())); err != nil {
			return fmt.Errorf("record empty AgentGUI workbench dock migration: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit empty AgentGUI workbench dock migration: %w", err)
		}
		return nil
	}

	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, snapshot_json
FROM workspace_workbench_snapshots
WHERE schema_version = 1
ORDER BY workspace_id ASC
`)
	if err != nil {
		return fmt.Errorf("list workbench snapshots for AgentGUI dock migration: %w", err)
	}

	var snapshots []storedWorkbenchSnapshotMigrationRow
	for rows.Next() {
		var snapshot storedWorkbenchSnapshotMigrationRow
		if err := rows.Scan(&snapshot.workspaceID, &snapshot.snapshotJSON); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan workbench snapshot for AgentGUI dock migration: %w", err)
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workbench snapshot rows for AgentGUI dock migration: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate workbench snapshots for AgentGUI dock migration: %w", err)
	}

	for _, snapshot := range snapshots {
		normalizedJSON, changed, err := normalizeAgentGUIWorkbenchDockSnapshotJSON([]byte(snapshot.snapshotJSON))
		if err != nil {
			return fmt.Errorf("migrate AgentGUI dock identity for workspace %q: %w", snapshot.workspaceID, err)
		}
		if !changed {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_workbench_snapshots
SET snapshot_json = ?
WHERE workspace_id = ?
`, string(normalizedJSON), snapshot.workspaceID); err != nil {
			return fmt.Errorf("update AgentGUI dock identity for workspace %q: %w", snapshot.workspaceID, err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record AgentGUI workbench dock migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit AgentGUI workbench dock migration: %w", err)
	}
	return nil
}

func normalizeAgentGUIWorkbenchDockSnapshotJSON(snapshotJSON []byte) ([]byte, bool, error) {
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(snapshotJSON, &snapshot); err != nil {
		return nil, false, fmt.Errorf("decode snapshot json: %w", err)
	}

	changed := false
	if nodesJSON, ok := snapshot["nodes"]; ok {
		var nodes []map[string]json.RawMessage
		if err := json.Unmarshal(nodesJSON, &nodes); err != nil {
			return nil, false, fmt.Errorf("decode snapshot nodes: %w", err)
		}
		for _, node := range nodes {
			dataJSON, ok := node["data"]
			if !ok {
				continue
			}
			var data map[string]json.RawMessage
			if err := json.Unmarshal(dataJSON, &data); err != nil {
				return nil, false, fmt.Errorf("decode snapshot node data: %w", err)
			}
			if !rawJSONStringEquals(data["typeId"], agentGUIWorkbenchTypeID) {
				continue
			}
			if rawJSONStringEquals(data["dockEntryId"], agentGUIWorkbenchUnifiedDockEntryID) {
				continue
			}
			data["dockEntryId"] = json.RawMessage(`"` + agentGUIWorkbenchUnifiedDockEntryID + `"`)
			normalizedData, err := json.Marshal(data)
			if err != nil {
				return nil, false, fmt.Errorf("encode snapshot node data: %w", err)
			}
			node["data"] = normalizedData
			changed = true
		}
		if changed {
			normalizedNodes, err := json.Marshal(nodes)
			if err != nil {
				return nil, false, fmt.Errorf("encode snapshot nodes: %w", err)
			}
			snapshot["nodes"] = normalizedNodes
		}
	}

	metadataChanged, err := normalizeAgentGUIClosedDockWindowFrames(snapshot)
	if err != nil {
		return nil, false, err
	}
	changed = changed || metadataChanged
	if !changed {
		return snapshotJSON, false, nil
	}

	normalizedSnapshot, err := json.Marshal(snapshot)
	if err != nil {
		return nil, false, fmt.Errorf("encode snapshot json: %w", err)
	}
	return normalizedSnapshot, true, nil
}

func normalizeAgentGUIClosedDockWindowFrames(snapshot map[string]json.RawMessage) (bool, error) {
	metadataJSON, ok := snapshot["metadata"]
	if !ok || string(metadataJSON) == "null" {
		return false, nil
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(metadataJSON, &metadata); err != nil {
		return false, fmt.Errorf("decode snapshot metadata: %w", err)
	}
	framesJSON, ok := metadata[closedDockWindowFramesMetadataKey]
	if !ok {
		return false, nil
	}
	var frames map[string]json.RawMessage
	if err := json.Unmarshal(framesJSON, &frames); err != nil {
		return false, fmt.Errorf("decode closed dock window frames: %w", err)
	}
	entriesJSON, ok := frames["entries"]
	if !ok {
		return false, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(entriesJSON, &entries); err != nil {
		return false, fmt.Errorf("decode closed dock window frame entries: %w", err)
	}

	changed := false
	for index, entryJSON := range entries {
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(entryJSON, &entry); err != nil {
			continue
		}
		if !rawJSONStringEquals(entry["typeId"], agentGUIWorkbenchTypeID) {
			continue
		}
		if !rawJSONStringEquals(entry["dockEntryId"], agentGUIWorkbenchUnifiedDockEntryID) {
			entry["dockEntryId"] = json.RawMessage(`"` + agentGUIWorkbenchUnifiedDockEntryID + `"`)
			changed = true
		}
		normalizedEntry, err := json.Marshal(entry)
		if err != nil {
			return false, fmt.Errorf("encode closed dock window frame entry: %w", err)
		}
		entries[index] = normalizedEntry
	}

	deduplicatedEntries := make([]json.RawMessage, 0, len(entries))
	foundAgentGUIEntry := false
	for index := len(entries) - 1; index >= 0; index-- {
		entryJSON := entries[index]
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(entryJSON, &entry); err == nil &&
			rawJSONStringEquals(entry["typeId"], agentGUIWorkbenchTypeID) &&
			rawJSONStringEquals(entry["dockEntryId"], agentGUIWorkbenchUnifiedDockEntryID) {
			if foundAgentGUIEntry {
				changed = true
				continue
			}
			foundAgentGUIEntry = true
		}
		deduplicatedEntries = append(deduplicatedEntries, entryJSON)
	}
	for left, right := 0, len(deduplicatedEntries)-1; left < right; left, right = left+1, right-1 {
		deduplicatedEntries[left], deduplicatedEntries[right] = deduplicatedEntries[right], deduplicatedEntries[left]
	}
	if !changed {
		return false, nil
	}

	normalizedEntries, err := json.Marshal(deduplicatedEntries)
	if err != nil {
		return false, fmt.Errorf("encode closed dock window frame entries: %w", err)
	}
	frames["entries"] = normalizedEntries
	normalizedFrames, err := json.Marshal(frames)
	if err != nil {
		return false, fmt.Errorf("encode closed dock window frames: %w", err)
	}
	metadata[closedDockWindowFramesMetadataKey] = normalizedFrames
	normalizedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return false, fmt.Errorf("encode snapshot metadata: %w", err)
	}
	snapshot["metadata"] = normalizedMetadata
	return true, nil
}

func rawJSONStringEquals(value json.RawMessage, expected string) bool {
	var decoded string
	return len(value) > 0 && json.Unmarshal(value, &decoded) == nil && decoded == expected
}
