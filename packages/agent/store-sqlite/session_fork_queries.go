package storesqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func getSessionForkOperation(ctx context.Context, db *sql.DB, workspaceID, operationID string) (SessionForkOperation, bool, error) {
	op, err := scanSessionForkOperation(db.QueryRowContext(ctx, sessionForkOperationSelectSQL+`
WHERE workspace_id = ? AND operation_id = ?`, workspaceID, operationID))
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	return op, err == nil, err
}

func getSessionForkOperationTx(ctx context.Context, tx *sql.Tx, workspaceID, operationID string) (SessionForkOperation, bool, error) {
	op, err := scanSessionForkOperation(tx.QueryRowContext(ctx, sessionForkOperationSelectSQL+`
WHERE workspace_id = ? AND operation_id = ?`, workspaceID, operationID))
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	return op, err == nil, err
}

func getSessionForkOperationByRequestTx(ctx context.Context, tx *sql.Tx, workspaceID, requestID string) (SessionForkOperation, bool, error) {
	op, err := scanSessionForkOperation(tx.QueryRowContext(ctx, sessionForkOperationSelectSQL+`
WHERE workspace_id = ? AND request_id = ?`, workspaceID, requestID))
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, nil
	}
	return op, err == nil, err
}

func getSessionForkOperationWithSnapshotTx(ctx context.Context, tx *sql.Tx, workspaceID, operationID string) (SessionForkOperation, bool, string, error) {
	row := tx.QueryRowContext(ctx, `
SELECT operation_id, workspace_id, request_id, request_hash,
       source_agent_session_id, target_agent_session_id,
       source_provider_session_id, source_turn_id, source_provider_turn_id,
       source_provider_turn_binding_json,
       COALESCE(target_turn_id, ''),
       point_kind, driver_kind, driver_version, status,
       COALESCE(target_provider_session_id, ''),
       target_title, target_provider_turn_bindings_json,
       provider_state_binding_mode, provider_state_binding_receipt,
       snapshot_hash, last_error,
       created_at_unix_ms, updated_at_unix_ms,
       COALESCE(dispatched_at_unix_ms, 0), COALESCE(accepted_at_unix_ms, 0),
       COALESCE(completed_at_unix_ms, 0),
       COALESCE(client_observed_at_unix_ms, 0), snapshot_json
FROM workspace_agent_session_fork_operations
WHERE workspace_id = ? AND operation_id = ?`, workspaceID, operationID)
	var snapshotJSON string
	op, err := scanSessionForkOperationWithExtra(row, &snapshotJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkOperation{}, false, "", nil
	}
	return op, err == nil, snapshotJSON, err
}

func scanSessionForkOperation(scanner rowScanner) (SessionForkOperation, error) {
	return scanSessionForkOperationWithExtra(scanner)
}

func scanSessionForkOperationWithExtra(scanner rowScanner, extra ...any) (SessionForkOperation, error) {
	var op SessionForkOperation
	var sourceProviderTurnBindingJSON string
	var targetProviderTurnBindingsJSON string
	destinations := []any{
		&op.OperationID, &op.WorkspaceID, &op.RequestID, &op.RequestHash,
		&op.SourceAgentSessionID, &op.TargetAgentSessionID,
		&op.SourceProviderSessionID, &op.SourceTurnID, &op.SourceProviderTurnID,
		&sourceProviderTurnBindingJSON,
		&op.TargetTurnID,
		&op.PointKind, &op.DriverKind, &op.DriverVersion, &op.Status, &op.TargetProviderSessionID,
		&op.TargetTitle, &targetProviderTurnBindingsJSON,
		&op.StateBindingMode, &op.StateBindingReceipt,
		&op.SnapshotHash, &op.LastError, &op.CreatedAtUnixMS, &op.UpdatedAtUnixMS,
		&op.DispatchedAtUnixMS, &op.AcceptedAtUnixMS, &op.CompletedAtUnixMS,
		&op.ClientObservedAtUnixMS,
	}
	destinations = append(destinations, extra...)
	if err := scanner.Scan(destinations...); err != nil {
		return SessionForkOperation{}, err
	}
	op.SourceProviderTurnBindingJSON = json.RawMessage(
		sourceProviderTurnBindingJSON,
	)
	if err := json.Unmarshal(
		[]byte(targetProviderTurnBindingsJSON),
		&op.TargetProviderTurnBindings,
	); err != nil {
		return SessionForkOperation{}, fmt.Errorf(
			"decode target provider turn bindings: %w",
			err,
		)
	}
	if op.Status == SessionForkStatusCommitted &&
		strings.TrimSpace(op.TargetTurnID) == "" {
		return SessionForkOperation{}, errors.New(
			"committed session fork operation omitted target turn identity",
		)
	}
	return op, nil
}

func normalizedProviderTurnBindings(
	values []SessionForkProviderTurnBinding,
) []SessionForkProviderTurnBinding {
	result := make([]SessionForkProviderTurnBinding, 0, len(values))
	seenProviderTurnIDs := make(map[string]struct{}, len(values))
	for _, value := range values {
		value.ProviderTurnID = strings.TrimSpace(value.ProviderTurnID)
		normalized, err := normalizeProviderTurnBindingJSON(
			value.ProviderTurnBindingJSON,
		)
		if err != nil || len(normalized) == 0 {
			return nil
		}
		value.ProviderTurnBindingJSON = normalized
		if _, duplicate := seenProviderTurnIDs[value.ProviderTurnID]; duplicate {
			return nil
		}
		seenProviderTurnIDs[value.ProviderTurnID] = struct{}{}
		result = append(result, value)
	}
	return result
}

func scanSessionForkLineage(scanner rowScanner) (SessionForkLineage, bool, error) {
	var lineage SessionForkLineage
	err := scanner.Scan(&lineage.WorkspaceID, &lineage.TargetAgentSessionID,
		&lineage.SourceAgentSessionID, &lineage.SourceTurnID,
		&lineage.TargetTurnID,
		&lineage.OperationID, &lineage.ForkedAtUnixMS)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionForkLineage{}, false, nil
	}
	if err == nil && strings.TrimSpace(lineage.TargetTurnID) == "" {
		return SessionForkLineage{}, false, errors.New(
			"session fork lineage omitted target turn identity",
		)
	}
	return lineage, err == nil, err
}

func normalizeSessionForkPrepare(input *SessionForkPrepare) {
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.RequestHash = strings.TrimSpace(input.RequestHash)
	input.SourceAgentSessionID = strings.TrimSpace(input.SourceAgentSessionID)
	input.TargetAgentSessionID = strings.TrimSpace(input.TargetAgentSessionID)
	input.SourceTurnID = strings.TrimSpace(input.SourceTurnID)
	input.PointKind = strings.TrimSpace(input.PointKind)
	input.DriverKind = strings.TrimSpace(input.DriverKind)
	input.DriverVersion = strings.TrimSpace(input.DriverVersion)
}

func hashSessionForkBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
