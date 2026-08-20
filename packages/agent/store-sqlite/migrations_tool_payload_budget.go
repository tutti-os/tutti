package storesqlite

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// applyWorkspaceAgentToolPayloadBudgetV1 reprojects every oversized retained
// tool call, including MCP results. Rows are updated only when the canonical
// representation encodes within the replication-safe payload budget. Logical
// message versions and timestamps remain unchanged; downstream replication
// derives a new fingerprint and mutation identity from the repaired row.
func (s *Store) applyWorkspaceAgentToolPayloadBudgetV1(ctx context.Context) error {
	const migrationID = schemaMigrationWorkspaceAgentToolPayloadBudgetV1
	applied, err := s.hasMigration(ctx, migrationID)
	if err != nil || applied {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent tool payload budget migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
SELECT id, status, payload_json
FROM workspace_agent_messages
WHERE kind = 'tool_call'
  AND length(CAST(payload_json AS BLOB)) > ?
ORDER BY id
`, canonical.ToolCallPayloadMaxBytes)
	if err != nil {
		return fmt.Errorf("select oversized workspace agent tool payloads: %w", err)
	}
	type candidate struct {
		id          int64
		status      string
		payloadJSON string
	}
	candidates := make([]candidate, 0)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.status, &item.payloadJSON); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan oversized workspace agent tool payload: %w", err)
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate oversized workspace agent tool payloads: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close oversized workspace agent tool payloads: %w", err)
	}

	for _, item := range candidates {
		var payload map[string]any
		decoder := json.NewDecoder(strings.NewReader(item.payloadJSON))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			return fmt.Errorf("decode workspace agent tool payload row %d: %w", item.id, err)
		}
		compacted, err := canonical.CompactToolCallPayloadChecked(item.status, payload)
		if err != nil {
			if canonical.IsToolCallPayloadTooLarge(err) {
				continue
			}
			return fmt.Errorf("compact workspace agent tool payload row %d: %w", item.id, err)
		}
		encoded, err := json.Marshal(compacted)
		if err != nil {
			return fmt.Errorf("encode workspace agent tool payload row %d: %w", item.id, err)
		}
		if len(encoded) > canonical.ToolCallPayloadMaxBytes || string(encoded) == item.payloadJSON {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages SET payload_json = ? WHERE id = ? AND payload_json = ?
`, string(encoded), item.id, item.payloadJSON); err != nil {
			return fmt.Errorf("update workspace agent tool payload row %d: %w", item.id, err)
		}
	}

	if err := recordMigrationTx(ctx, tx, migrationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent tool payload budget migration: %w", err)
	}
	return nil
}
