package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func (s *Store) applyWorkspaceAgentSessionMetadataV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionMetadataV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session metadata v1: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_sessions ADD COLUMN session_metadata_json TEXT NOT NULL DEFAULT '{"visible":true,"imported":false,"capabilities":[]}'
  CHECK (json_valid(session_metadata_json)
    AND json_type(session_metadata_json, '$.visible') IN ('true','false')
    AND json_type(session_metadata_json, '$.imported') IN ('true','false')
    AND json_type(session_metadata_json, '$.capabilities') = 'array'
    AND (json_type(session_metadata_json, '$.backgroundAgents') IS NULL OR json_type(session_metadata_json, '$.backgroundAgents') IN ('null','object'))
    AND (json_type(session_metadata_json, '$.goal') IS NULL OR json_type(session_metadata_json, '$.goal') IN ('null','object')));
ALTER TABLE workspace_agent_sessions ADD COLUMN internal_runtime_context_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(internal_runtime_context_json) AND json_type(internal_runtime_context_json) = 'object');

`); err != nil {
		return fmt.Errorf("migrate workspace agent session metadata v1: %w", err)
	}
	if err := backfillSessionMetadataV1(ctx, tx); err != nil {
		return err
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionMetadataV1); err != nil {
		return err
	}
	return tx.Commit()
}

type legacySessionRuntimeContext struct {
	workspaceID, sessionID, raw string
}

func backfillSessionMetadataV1(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT workspace_id, agent_session_id, runtime_context_json FROM workspace_agent_sessions`)
	if err != nil {
		return fmt.Errorf("list legacy session runtime contexts: %w", err)
	}
	var values []legacySessionRuntimeContext
	for rows.Next() {
		var value legacySessionRuntimeContext
		if err := rows.Scan(&value.workspaceID, &value.sessionID, &value.raw); err != nil {
			rows.Close()
			return err
		}
		values = append(values, value)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, value := range values {
		runtimeContext, err := unmarshalJSONMap(value.raw)
		if err != nil {
			return fmt.Errorf("decode legacy session runtime context: %w", err)
		}
		normalizeLegacyBackgroundAgents(runtimeContext)
		legacyGoal := normalizeLegacyGoal(runtimeContext)
		metadata, internal, err := splitSessionRuntimeContext(runtimeContext)
		if err != nil {
			return fmt.Errorf("normalize legacy session metadata: %w", err)
		}
		if legacyGoal != nil {
			internal["providerGoal"] = legacyGoal
		}
		metadataJSON, err := marshalSessionMetadata(metadata)
		if err != nil {
			return err
		}
		internalJSON, err := marshalJSONMap(internal)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_agent_sessions SET session_metadata_json = ?, internal_runtime_context_json = ? WHERE workspace_id = ? AND agent_session_id = ?`, metadataJSON, internalJSON, value.workspaceID, value.sessionID); err != nil {
			return fmt.Errorf("backfill session metadata: %w", err)
		}
	}
	return nil
}

func normalizeLegacyBackgroundAgents(runtimeContext map[string]any) {
	background, ok := runtimeContext["backgroundAgents"].(map[string]any)
	if !ok {
		return
	}
	items, _ := background["items"].([]any)
	running := 0
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		status := normalizeBackgroundAgentStatus(payloadString(item, "status"))
		item["status"] = status
		if status == "running" {
			running++
		}
	}
	background["count"] = running
}

func normalizeLegacyGoal(runtimeContext map[string]any) any {
	raw := runtimeContext["goal"]
	if raw == nil {
		return nil
	}
	var goal SessionGoal
	if remarshalJSON(raw, &goal) == nil && validateSessionGoal(goal) == nil {
		return nil
	}
	delete(runtimeContext, "goal")
	return raw
}

func (s *Store) applyWorkspaceAgentSessionMetadataV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionMetadataV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session metadata v2: %w", err)
	}
	defer tx.Rollback()
	for _, column := range []string{"status", "current_phase", "last_error", "runtime_context_json"} {
		exists, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", column)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions DROP COLUMN `+column); err != nil {
			return fmt.Errorf("migrate workspace agent session metadata v2 drop %s: %w", column, err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionMetadataV2); err != nil {
		return err
	}
	return tx.Commit()
}
