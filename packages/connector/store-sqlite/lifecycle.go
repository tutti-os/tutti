package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

const maxLifecycleCleanupBatchSize = 500

func saveInstalledReleaseEvidenceOn(ctx context.Context, tx *sql.Tx, operation market.Operation) error {
	if operation.State != market.OperationStateCompleted {
		return nil
	}
	switch operation.Kind {
	case market.OperationKindInstall:
		if operation.Target == nil || operation.Target.Release == nil || operation.Target.ReleaseDigest == "" {
			return errors.New("completed connector install is missing release evidence")
		}
		return saveInstalledReleaseOn(ctx, tx, *operation.Target.Release)
	case market.OperationKindUninstall:
		_, err := tx.ExecContext(ctx, `DELETE FROM connector_market_installed_releases WHERE connector_key = ?`, operation.ConnectorKey)
		return err
	default:
		return nil
	}
}

func saveInstalledReleaseOn(ctx context.Context, tx *sql.Tx, release market.Release) error {
	payload, err := json.Marshal(release)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO connector_market_installed_releases (connector_key, release_digest, release_json)
VALUES (?, ?, ?)
ON CONFLICT(connector_key) DO UPDATE SET
  release_digest = excluded.release_digest,
  release_json = excluded.release_json`, release.ConnectorKey, release.ReleaseDigest, string(payload))
	return err
}

func (store *Store) CleanupLifecycle(ctx context.Context, request market.LifecycleCleanupRequest) (market.LifecycleCleanupResult, error) {
	if request.BatchSize <= 0 || request.BatchSize > maxLifecycleCleanupBatchSize {
		return market.LifecycleCleanupResult{}, fmt.Errorf("connector market lifecycle cleanup batch size must be between 1 and %d", maxLifecycleCleanupBatchSize)
	}
	if request.TerminalOperationsUpdatedThrough.IsZero() || request.PublishedEventsPublishedThrough.IsZero() {
		return market.LifecycleCleanupResult{}, errors.New("connector market lifecycle cleanup cutoffs are required")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	operationResult, err := tx.ExecContext(ctx, `
DELETE FROM connector_market_operations
WHERE operation_id IN (
  SELECT operation_id FROM connector_market_operations
  WHERE state IN ('completed', 'failed', 'cancelled') AND updated_at_unix_ms <= ?
  ORDER BY updated_at_unix_ms, operation_id LIMIT ?
)
AND state IN ('completed', 'failed', 'cancelled') AND updated_at_unix_ms <= ?`,
		request.TerminalOperationsUpdatedThrough.UTC().UnixMilli(), request.BatchSize,
		request.TerminalOperationsUpdatedThrough.UTC().UnixMilli())
	if err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	outboxResult, err := tx.ExecContext(ctx, `
DELETE FROM connector_market_outbox
WHERE sequence IN (
  SELECT sequence FROM connector_market_outbox
  WHERE published_at_unix_ms IS NOT NULL AND published_at_unix_ms <= ?
  ORDER BY published_at_unix_ms, sequence LIMIT ?
)
AND published_at_unix_ms IS NOT NULL AND published_at_unix_ms <= ?`,
		request.PublishedEventsPublishedThrough.UTC().UnixMilli(), request.BatchSize,
		request.PublishedEventsPublishedThrough.UTC().UnixMilli())
	if err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	operationsDeleted, err := operationResult.RowsAffected()
	if err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	eventsDeleted, err := outboxResult.RowsAffected()
	if err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return market.LifecycleCleanupResult{}, err
	}
	return market.LifecycleCleanupResult{
		TerminalOperationsDeleted: operationsDeleted,
		PublishedEventsDeleted:    eventsDeleted,
	}, nil
}
