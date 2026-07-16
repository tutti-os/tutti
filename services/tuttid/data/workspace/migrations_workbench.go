package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
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

	tx, err := s.writeDB.BeginTx(ctx, nil)
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

func (s *SQLiteStore) applyWorkspaceWorkbenchAgentTargetIdentityV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceWorkbenchAgentTargetIdentityV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin AgentGUI target identity migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var snapshotTableCount int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name = 'workspace_workbench_snapshots'
`).Scan(&snapshotTableCount); err != nil {
		return fmt.Errorf("inspect workbench snapshot table for target identity migration: %w", err)
	}
	if snapshotTableCount == 0 {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationWorkspaceWorkbenchAgentTargetIdentityV1, unixMs(time.Now().UTC())); err != nil {
			return fmt.Errorf("record empty AgentGUI target identity migration: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit empty AgentGUI target identity migration: %w", err)
		}
		return nil
	}

	validAgentTargetIDs := make(map[string]struct{})
	targetRows, err := tx.QueryContext(ctx, `SELECT id FROM agent_targets`)
	if err != nil {
		return fmt.Errorf("list agent targets for workbench migration: %w", err)
	}
	for targetRows.Next() {
		var targetID string
		if err := targetRows.Scan(&targetID); err != nil {
			_ = targetRows.Close()
			return fmt.Errorf("scan agent target for workbench migration: %w", err)
		}
		validAgentTargetIDs[strings.TrimSpace(targetID)] = struct{}{}
	}
	if err := targetRows.Close(); err != nil {
		return fmt.Errorf("close agent target rows for workbench migration: %w", err)
	}
	if err := targetRows.Err(); err != nil {
		return fmt.Errorf("iterate agent targets for workbench migration: %w", err)
	}

	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, snapshot_json
FROM workspace_workbench_snapshots
WHERE schema_version = 1
ORDER BY workspace_id ASC
`)
	if err != nil {
		return fmt.Errorf("list snapshots for AgentGUI target identity migration: %w", err)
	}
	var snapshots []storedWorkbenchSnapshotMigrationRow
	for rows.Next() {
		var snapshot storedWorkbenchSnapshotMigrationRow
		if err := rows.Scan(&snapshot.workspaceID, &snapshot.snapshotJSON); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan snapshot for AgentGUI target identity migration: %w", err)
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close snapshot rows for AgentGUI target identity migration: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate snapshots for AgentGUI target identity migration: %w", err)
	}

	for _, snapshot := range snapshots {
		normalizedJSON, changed, err := filterAgentGUIWorkbenchNodesWithoutValidTarget(
			[]byte(snapshot.snapshotJSON), validAgentTargetIDs,
		)
		if err != nil {
			return fmt.Errorf("filter AgentGUI cache for workspace %q: %w", snapshot.workspaceID, err)
		}
		if !changed {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_workbench_snapshots
SET snapshot_json = ?
WHERE workspace_id = ?
`, string(normalizedJSON), snapshot.workspaceID); err != nil {
			return fmt.Errorf("update AgentGUI cache for workspace %q: %w", snapshot.workspaceID, err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceWorkbenchAgentTargetIdentityV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record AgentGUI target identity migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit AgentGUI target identity migration: %w", err)
	}
	return nil
}

func filterAgentGUIWorkbenchNodesWithoutValidTarget(
	snapshotJSON []byte,
	validAgentTargetIDs map[string]struct{},
) ([]byte, bool, error) {
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(snapshotJSON, &snapshot); err != nil {
		return nil, false, fmt.Errorf("decode snapshot json: %w", err)
	}
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(snapshot["nodes"], &nodes); err != nil {
		return nil, false, fmt.Errorf("decode snapshot nodes: %w", err)
	}

	removedNodeIDs := make(map[string]struct{})
	filteredNodes := make([]map[string]json.RawMessage, 0, len(nodes))
	for _, node := range nodes {
		remove, err := shouldRemoveAgentGUIWorkbenchNode(node, validAgentTargetIDs)
		if err != nil {
			return nil, false, err
		}
		if !remove {
			filteredNodes = append(filteredNodes, node)
			continue
		}
		var nodeID string
		if err := json.Unmarshal(node["id"], &nodeID); err == nil && nodeID != "" {
			removedNodeIDs[nodeID] = struct{}{}
		}
	}
	if len(removedNodeIDs) == 0 {
		return snapshotJSON, false, nil
	}
	normalizedNodes, err := json.Marshal(filteredNodes)
	if err != nil {
		return nil, false, fmt.Errorf("encode filtered snapshot nodes: %w", err)
	}
	snapshot["nodes"] = normalizedNodes
	filterSnapshotNodeIDList(snapshot, "nodeStack", removedNodeIDs)
	filterSnapshotActiveNodeID(snapshot, removedNodeIDs)
	if err := filterSnapshotSpaceNodeIDs(snapshot, removedNodeIDs); err != nil {
		return nil, false, err
	}
	normalizedSnapshot, err := json.Marshal(snapshot)
	if err != nil {
		return nil, false, fmt.Errorf("encode filtered snapshot: %w", err)
	}
	return normalizedSnapshot, true, nil
}

func shouldRemoveAgentGUIWorkbenchNode(
	node map[string]json.RawMessage,
	validAgentTargetIDs map[string]struct{},
) (bool, error) {
	var data map[string]json.RawMessage
	if err := json.Unmarshal(node["data"], &data); err != nil {
		return false, nil
	}
	if !rawJSONStringEquals(data["typeId"], agentGUIWorkbenchTypeID) {
		return false, nil
	}
	var snapshotState map[string]json.RawMessage
	if err := json.Unmarshal(data["snapshotNodeState"], &snapshotState); err != nil {
		return true, nil
	}
	var agentTargetID string
	if err := json.Unmarshal(snapshotState["agentTargetId"], &agentTargetID); err != nil {
		return true, nil
	}
	_, valid := validAgentTargetIDs[strings.TrimSpace(agentTargetID)]
	return !valid, nil
}

func filterSnapshotNodeIDList(
	snapshot map[string]json.RawMessage,
	key string,
	removedNodeIDs map[string]struct{},
) {
	var nodeIDs []string
	if json.Unmarshal(snapshot[key], &nodeIDs) != nil {
		return
	}
	filtered := nodeIDs[:0]
	for _, nodeID := range nodeIDs {
		if _, removed := removedNodeIDs[nodeID]; !removed {
			filtered = append(filtered, nodeID)
		}
	}
	encoded, err := json.Marshal(filtered)
	if err == nil {
		snapshot[key] = encoded
	}
}

func filterSnapshotActiveNodeID(
	snapshot map[string]json.RawMessage,
	removedNodeIDs map[string]struct{},
) {
	var activeNodeID string
	if json.Unmarshal(snapshot["activeNodeId"], &activeNodeID) != nil {
		return
	}
	if _, removed := removedNodeIDs[activeNodeID]; removed {
		snapshot["activeNodeId"] = json.RawMessage("null")
	}
}

func filterSnapshotSpaceNodeIDs(
	snapshot map[string]json.RawMessage,
	removedNodeIDs map[string]struct{},
) error {
	spacesJSON, ok := snapshot["spaces"]
	if !ok {
		return nil
	}
	var spaces []map[string]json.RawMessage
	if err := json.Unmarshal(spacesJSON, &spaces); err != nil {
		return fmt.Errorf("decode snapshot spaces: %w", err)
	}
	for _, space := range spaces {
		filterSnapshotNodeIDList(space, "nodeIds", removedNodeIDs)
	}
	encoded, err := json.Marshal(spaces)
	if err != nil {
		return fmt.Errorf("encode snapshot spaces: %w", err)
	}
	snapshot["spaces"] = encoded
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
