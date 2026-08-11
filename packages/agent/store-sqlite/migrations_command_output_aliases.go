package storesqlite

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type historicalCommandOutputAlias struct {
	id          int64
	status      string
	payloadJSON string
}

const workspaceAgentCommandOutputAliasPayloadThresholdBytes = canonical.ToolCallPayloadMaxBytes

// applyWorkspaceAgentCommandOutputAliasesV1 heals retained command messages
// whose payload exceeds the canonical replication-safe budget. Exact display
// aliases are removed; independently truncated legacy streams receive the same
// aggregate output budget. Versions and timestamps stay unchanged so this is a
// physical representation repair, not a new logical activity event.
func (s *Store) applyWorkspaceAgentCommandOutputAliasesV1(
	ctx context.Context,
) error {
	const migrationID = schemaMigrationWorkspaceAgentCommandOutputAliasesV1
	applied, err := s.hasMigration(ctx, migrationID)
	if err != nil || applied {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent command output alias migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	const candidatePageSize = 8
	lastID := int64(0)
	for {
		rows, err := tx.QueryContext(ctx, `
SELECT message.id, message.status, message.payload_json
FROM workspace_agent_messages AS message
WHERE message.id > ?
  AND message.kind = 'tool_call'
  AND length(CAST(message.payload_json AS BLOB)) > ?
  AND (
    json_type(message.payload_json, '$.output.text') = 'text'
    OR json_type(message.payload_json, '$.output.stdout') = 'text'
    OR json_type(message.payload_json, '$.output.stderr') = 'text'
    OR json_type(message.payload_json, '$.error.text') = 'text'
    OR json_type(message.payload_json, '$.error.stdout') = 'text'
    OR json_type(message.payload_json, '$.error.stderr') = 'text'
    OR json_type(message.payload_json, '$.steps') = 'array'
    OR json_type(message.payload_json, '$.output.steps') = 'array'
    OR json_type(message.payload_json, '$.error.steps') = 'array'
    OR json_type(message.payload_json, '$.metadata.steps') = 'array'
  )
ORDER BY message.id
LIMIT ?
`, lastID, workspaceAgentCommandOutputAliasPayloadThresholdBytes, candidatePageSize)
		if err != nil {
			return fmt.Errorf("select oversized workspace agent command output aliases: %w", err)
		}
		candidates := make([]historicalCommandOutputAlias, 0, candidatePageSize)
		for rows.Next() {
			var candidate historicalCommandOutputAlias
			if err := rows.Scan(
				&candidate.id,
				&candidate.status,
				&candidate.payloadJSON,
			); err != nil {
				_ = rows.Close()
				return fmt.Errorf("scan workspace agent command output alias: %w", err)
			}
			candidates = append(candidates, candidate)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return fmt.Errorf("iterate workspace agent command output aliases: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close workspace agent command output aliases: %w", err)
		}
		if len(candidates) == 0 {
			break
		}
		lastID = candidates[len(candidates)-1].id

		for _, candidate := range candidates {
			var payload map[string]any
			decoder := json.NewDecoder(strings.NewReader(candidate.payloadJSON))
			decoder.UseNumber()
			if err := decoder.Decode(&payload); err != nil {
				return fmt.Errorf(
					"decode workspace agent command output alias row %d: %w",
					candidate.id,
					err,
				)
			}
			if !canonical.HasTerminalCommandOutput(
				candidate.status,
				payload,
			) {
				continue
			}
			aliasChanged := canonical.CompactTerminalCommandOutputAliases(
				candidate.status,
				payload,
			)
			budgetChanged, fits := canonical.FitToolCallPayloadOutputBudget(
				payload,
				canonical.ToolCallPayloadMaxBytes,
			)
			if !fits || (!aliasChanged && !budgetChanged) {
				continue
			}
			compactedJSON, err := json.Marshal(payload)
			if err != nil {
				return fmt.Errorf(
					"encode workspace agent command output alias row %d: %w",
					candidate.id,
					err,
				)
			}
			result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET payload_json = ?
WHERE id = ? AND payload_json = ?
`, string(compactedJSON), candidate.id, candidate.payloadJSON)
			if err != nil {
				return fmt.Errorf(
					"compact workspace agent command output alias row %d: %w",
					candidate.id,
					err,
				)
			}
			updated, err := result.RowsAffected()
			if err != nil {
				return fmt.Errorf(
					"read workspace agent command output alias update %d: %w",
					candidate.id,
					err,
				)
			}
			if updated != 1 {
				return fmt.Errorf(
					"compact workspace agent command output alias row %d: updated %d rows",
					candidate.id,
					updated,
				)
			}
		}
	}

	if err := recordMigrationTx(ctx, tx, migrationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent command output alias migration: %w", err)
	}
	return nil
}
