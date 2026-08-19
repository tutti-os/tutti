package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func (store *Store) OperationForScope(
	ctx context.Context,
	scope market.OperationScope,
	operationID string,
) (market.Operation, error) {
	var payload string
	if err := store.db.QueryRowContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE operation_id = ? AND owner_account_id = ? AND visibility = ?`,
		strings.TrimSpace(operationID), strings.TrimSpace(scope.AccountID), market.OperationVisibilityAccount,
	).Scan(&payload); err != nil {
		return market.Operation{}, mapNotFound(err)
	}
	operation, err := decodeOperation(payload)
	if err != nil {
		return market.Operation{}, err
	}
	return publicOperation(operation), nil
}

func (store *Store) migrateOperationOwnership(ctx context.Context) error {
	columns, err := store.operationColumns(ctx)
	if err != nil {
		return err
	}
	if !columns["owner_account_id"] || !columns["visibility"] {
		if err := store.rebuildOperationsWithOwnership(ctx); err != nil {
			return err
		}
	}
	for _, statement := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS connector_market_operation_owner_request
ON connector_market_operations(owner_account_id, client_request_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS connector_market_one_active_operation
ON connector_market_operations(connector_key)
WHERE state IN ('accepted', 'running')`,
		`CREATE INDEX IF NOT EXISTS connector_market_operations_terminal_cleanup
ON connector_market_operations(updated_at_unix_ms, operation_id)
WHERE state IN ('completed', 'failed')`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate connector market operation ownership index: %w", err)
		}
	}
	return nil
}

func (store *Store) operationColumns(ctx context.Context) (map[string]bool, error) {
	rows, err := store.db.QueryContext(ctx, `PRAGMA table_info(connector_market_operations)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[strings.ToLower(name)] = true
	}
	return columns, rows.Err()
}

func (store *Store) rebuildOperationsWithOwnership(ctx context.Context) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT operation_json FROM connector_market_operations ORDER BY operation_id`)
	if err != nil {
		return err
	}
	var operations []market.Operation
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			_ = rows.Close()
			return err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			_ = rows.Close()
			return err
		}
		operations = append(operations, market.NormalizeOperationOwnership(operation))
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE connector_market_operations_ownership_v2 (
  operation_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('account', 'system_private')),
  connector_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_unix_ms INTEGER,
  updated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  operation_json TEXT NOT NULL
)`); err != nil {
		return fmt.Errorf("create connector market operation ownership table: %w", err)
	}
	for _, operation := range operations {
		payload, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		var leaseExpiresAt any
		if operation.LeaseExpiresAt != nil {
			leaseExpiresAt = operation.LeaseExpiresAt.UTC().UnixMilli()
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO connector_market_operations_ownership_v2 (
  operation_id, client_request_id, owner_account_id, visibility, connector_key, kind, state,
  lease_owner, lease_token, lease_expires_at_unix_ms, updated_at_unix_ms, operation_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			operation.OperationID, operation.ClientRequestID, operation.OwnerAccountID, operation.Visibility,
			operation.ConnectorKey, operation.Kind, operation.State, operation.LeaseOwner, operation.LeaseToken,
			leaseExpiresAt, operation.UpdatedAt.UTC().UnixMilli(), string(payload)); err != nil {
			return fmt.Errorf("backfill connector market operation ownership: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DROP TABLE connector_market_operations`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE connector_market_operations_ownership_v2 RENAME TO connector_market_operations`); err != nil {
		return err
	}
	return tx.Commit()
}
