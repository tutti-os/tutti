package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const maxDueRuntimeConvergences = 100

func (store *Store) migrateRuntimeConvergence(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS connector_market_runtime_convergence (
  account_id TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  desired_generation INTEGER NOT NULL CHECK (desired_generation > 0),
  observed_generation INTEGER NOT NULL CHECK (observed_generation >= 0),
  observed_boot_epoch TEXT NOT NULL,
  next_attempt_at_unix_ms INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_unix_ms INTEGER,
  updated_at_unix_ms INTEGER NOT NULL,
  convergence_json TEXT NOT NULL,
  PRIMARY KEY (account_id, connector_key)
)`,
		`CREATE INDEX IF NOT EXISTS connector_market_runtime_convergence_due
ON connector_market_runtime_convergence(account_id, next_attempt_at_unix_ms, connector_key)`,
	}
	for _, statement := range statements {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate connector runtime convergence: %w", err)
		}
	}
	return nil
}

func (store *Store) RuntimeConvergence(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey string,
) (market.RuntimeConvergence, error) {
	return runtimeConvergenceOn(ctx, store.db, scope, connectorKey)
}

func (store *Store) DueRuntimeConvergences(
	ctx context.Context,
	scope market.OperationScope,
	bootEpoch string,
	now time.Time,
	limit int,
) ([]market.RuntimeConvergence, error) {
	if limit <= 0 || limit > maxDueRuntimeConvergences {
		limit = maxDueRuntimeConvergences
	}
	rows, err := store.db.QueryContext(ctx, `
SELECT convergence_json
FROM connector_market_runtime_convergence
WHERE account_id = ?
  AND (desired_generation != observed_generation OR observed_boot_epoch != ?)
  AND next_attempt_at_unix_ms <= ?
  AND (lease_owner = '' OR lease_expires_at_unix_ms IS NULL OR lease_expires_at_unix_ms <= ?)
ORDER BY next_attempt_at_unix_ms, connector_key
LIMIT ?`, strings.TrimSpace(scope.AccountID), strings.TrimSpace(bootEpoch), now.UTC().UnixMilli(), now.UTC().UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]market.RuntimeConvergence, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		convergence, err := decodeRuntimeConvergence(payload)
		if err != nil {
			return nil, err
		}
		result = append(result, convergence)
	}
	return result, rows.Err()
}

func (store *Store) ClaimRuntimeConvergence(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, bootEpoch, owner string,
	now, leaseExpiresAt time.Time,
) (market.RuntimeConvergence, bool, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	accountID, connectorKey := runtimeConvergenceKey(scope, connectorKey)
	result, err := tx.ExecContext(ctx, `
UPDATE connector_market_runtime_convergence
SET lease_owner = ?, lease_token = lease_token + 1, lease_expires_at_unix_ms = ?
WHERE account_id = ? AND connector_key = ?
  AND (desired_generation != observed_generation OR observed_boot_epoch != ?)
  AND next_attempt_at_unix_ms <= ?
  AND (lease_owner = '' OR lease_expires_at_unix_ms IS NULL OR lease_expires_at_unix_ms <= ?)`,
		strings.TrimSpace(owner), leaseExpiresAt.UTC().UnixMilli(), accountID, connectorKey,
		strings.TrimSpace(bootEpoch), now.UTC().UnixMilli(), now.UTC().UnixMilli())
	if err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	convergence, err := runtimeConvergenceOn(ctx, tx, scope, connectorKey)
	if err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	if changed == 0 {
		return convergence, false, tx.Commit()
	}
	var token uint64
	if err := tx.QueryRowContext(ctx, `
SELECT lease_token FROM connector_market_runtime_convergence
WHERE account_id = ? AND connector_key = ?`, accountID, connectorKey).Scan(&token); err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	expiresAt := leaseExpiresAt.UTC()
	convergence.LeaseOwner = strings.TrimSpace(owner)
	convergence.LeaseToken = token
	convergence.LeaseExpiresAt = &expiresAt
	if err := saveRuntimeConvergenceOn(ctx, tx, convergence); err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return market.RuntimeConvergence{}, false, err
	}
	return convergence, true, nil
}

func (store *Store) RenewRuntimeConvergenceLease(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, owner string,
	token uint64,
	now, leaseExpiresAt time.Time,
) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	convergence, err := runtimeConvergenceOn(ctx, tx, scope, connectorKey)
	if err != nil {
		return err
	}
	if convergence.LeaseOwner != strings.TrimSpace(owner) || convergence.LeaseToken != token ||
		convergence.LeaseExpiresAt == nil || !convergence.LeaseExpiresAt.After(now.UTC()) {
		return market.ErrOperationLeaseLost
	}
	expiresAt := leaseExpiresAt.UTC()
	convergence.LeaseExpiresAt = &expiresAt
	if err := saveRuntimeConvergenceOn(ctx, tx, convergence); err != nil {
		return err
	}
	return tx.Commit()
}

func (store *Store) ReleaseRuntimeConvergenceLease(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, owner string,
	token uint64,
) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	convergence, err := runtimeConvergenceOn(ctx, tx, scope, connectorKey)
	if err != nil {
		return err
	}
	if convergence.LeaseOwner != strings.TrimSpace(owner) || convergence.LeaseToken != token {
		return tx.Commit()
	}
	convergence.LeaseOwner = ""
	convergence.LeaseExpiresAt = nil
	if err := saveRuntimeConvergenceOn(ctx, tx, convergence); err != nil {
		return err
	}
	return tx.Commit()
}

func (store *Store) CompleteRuntimeConvergence(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, owner string,
	token, desiredGeneration uint64,
	observed market.RuntimeObserved,
	now time.Time,
) error {
	return store.finishRuntimeConvergence(ctx, scope, connectorKey, owner, token, desiredGeneration, now,
		func(convergence *market.RuntimeConvergence) {
			convergence.Observed = observed
			convergence.Attempt = 0
			convergence.NextAttemptAt = time.Time{}
			convergence.LastErrorCode = ""
			convergence.LastError = ""
		})
}

func (store *Store) RetryRuntimeConvergence(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, owner string,
	token, desiredGeneration uint64,
	nextAttemptAt time.Time,
	errorCode, errorMessage string,
	now time.Time,
) error {
	return store.finishRuntimeConvergence(ctx, scope, connectorKey, owner, token, desiredGeneration, now,
		func(convergence *market.RuntimeConvergence) {
			convergence.Attempt++
			convergence.NextAttemptAt = nextAttemptAt.UTC()
			convergence.LastErrorCode = strings.TrimSpace(errorCode)
			convergence.LastError = strings.TrimSpace(errorMessage)
		})
}

func (store *Store) finishRuntimeConvergence(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey, owner string,
	token, desiredGeneration uint64,
	now time.Time,
	update func(*market.RuntimeConvergence),
) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	convergence, err := runtimeConvergenceOn(ctx, tx, scope, connectorKey)
	if err != nil {
		return err
	}
	if convergence.Desired.Generation != desiredGeneration {
		return market.ErrOperationLeaseLost
	}
	if convergence.LeaseOwner != strings.TrimSpace(owner) || convergence.LeaseToken != token ||
		convergence.LeaseExpiresAt == nil || !convergence.LeaseExpiresAt.After(now.UTC()) {
		return market.ErrOperationLeaseLost
	}
	update(&convergence)
	convergence.LeaseOwner = ""
	convergence.LeaseExpiresAt = nil
	convergence.UpdatedAt = now.UTC()
	if err := saveRuntimeConvergenceOn(ctx, tx, convergence); err != nil {
		return err
	}
	return tx.Commit()
}

func runtimeConvergenceOn(
	ctx context.Context,
	database interface {
		QueryRowContext(context.Context, string, ...any) *sql.Row
	},
	scope market.OperationScope,
	connectorKey string,
) (market.RuntimeConvergence, error) {
	accountID, connectorKey := runtimeConvergenceKey(scope, connectorKey)
	var payload string
	if err := database.QueryRowContext(ctx, `
SELECT convergence_json FROM connector_market_runtime_convergence
WHERE account_id = ? AND connector_key = ?`, accountID, connectorKey).Scan(&payload); err != nil {
		return market.RuntimeConvergence{}, mapNotFound(err)
	}
	return decodeRuntimeConvergence(payload)
}

func saveRuntimeConvergenceOn(ctx context.Context, tx *sql.Tx, convergence market.RuntimeConvergence) error {
	accountID, connectorKey := runtimeConvergenceKey(convergence.Desired.Scope, convergence.Desired.ConnectorKey)
	if connectorKey == "" || convergence.Desired.Generation == 0 {
		return errors.New("connector runtime convergence requires a connector key and desired generation")
	}
	payload, err := json.Marshal(convergence)
	if err != nil {
		return err
	}
	var leaseExpiresAt any
	if convergence.LeaseExpiresAt != nil {
		leaseExpiresAt = convergence.LeaseExpiresAt.UTC().UnixMilli()
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO connector_market_runtime_convergence (
  account_id, connector_key, desired_generation, observed_generation,
  observed_boot_epoch, next_attempt_at_unix_ms, lease_owner, lease_token,
  lease_expires_at_unix_ms, updated_at_unix_ms, convergence_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, connector_key) DO UPDATE SET
  desired_generation = excluded.desired_generation,
  observed_generation = excluded.observed_generation,
  observed_boot_epoch = excluded.observed_boot_epoch,
  next_attempt_at_unix_ms = excluded.next_attempt_at_unix_ms,
  lease_owner = excluded.lease_owner,
  lease_token = excluded.lease_token,
  lease_expires_at_unix_ms = excluded.lease_expires_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms,
  convergence_json = excluded.convergence_json`,
		accountID, connectorKey, convergence.Desired.Generation, convergence.Observed.DesiredGeneration,
		strings.TrimSpace(convergence.Observed.BootEpoch), convergence.NextAttemptAt.UTC().UnixMilli(),
		strings.TrimSpace(convergence.LeaseOwner), convergence.LeaseToken, leaseExpiresAt,
		convergence.UpdatedAt.UTC().UnixMilli(), string(payload))
	return err
}

func decodeRuntimeConvergence(payload string) (market.RuntimeConvergence, error) {
	var convergence market.RuntimeConvergence
	if err := json.Unmarshal([]byte(payload), &convergence); err != nil {
		return market.RuntimeConvergence{}, fmt.Errorf("decode connector runtime convergence: %w", err)
	}
	return convergence, nil
}

func runtimeConvergenceKey(scope market.OperationScope, connectorKey string) (string, string) {
	return strings.TrimSpace(scope.AccountID), strings.TrimSpace(connectorKey)
}
