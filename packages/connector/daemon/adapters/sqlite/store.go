package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	_ "modernc.org/sqlite"
)

const metadataID = 1

type Store struct {
	db *sql.DB
}

var _ market.Repository = (*Store)(nil)
var _ market.ChangedEventOutbox = (*Store)(nil)
var _ market.LifecycleCleanupStore = (*Store)(nil)
var _ market.AuthorizationProjectionStore = (*Store)(nil)
var _ market.AuthorizationSnapshotStore = (*Store)(nil)

func Open(ctx context.Context, dbPath string) (*Store, error) {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		return nil, errors.New("connector market database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, fmt.Errorf("create connector market database directory: %w", err)
	}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(1)")
	dsn := connectorMarketSQLiteDSN(dbPath, query)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open connector market database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func connectorMarketSQLiteDSN(dbPath string, query url.Values) string {
	databaseURL := &url.URL{Scheme: "file", Path: dbPath, RawQuery: query.Encode()}
	if runtime.GOOS == "windows" && filepath.IsAbs(dbPath) {
		slashPath := filepath.ToSlash(dbPath)
		if uncPath := strings.TrimPrefix(slashPath, "//"); uncPath != slashPath {
			host, path, found := strings.Cut(uncPath, "/")
			if found {
				databaseURL.Host = host
				databaseURL.Path = "/" + path
			}
		} else {
			databaseURL.Path = "/" + slashPath
		}
	}
	return databaseURL.String()
}

func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	return store.db.Close()
}

func (store *Store) migrate(ctx context.Context) error {
	statements := []string{
		`DROP TABLE IF EXISTS connector_market_catalog_trust`,
		`DROP TABLE IF EXISTS connector_market_security_revocations`,
		`CREATE TABLE IF NOT EXISTS connector_market_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  catalog_state TEXT NOT NULL,
  source_revision TEXT NOT NULL
)`,
		`INSERT INTO connector_market_metadata (id, revision, catalog_state, source_revision)
VALUES (1, 0, 'stale', '') ON CONFLICT(id) DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS connector_market_connectors (
  connector_key TEXT PRIMARY KEY,
  connector_json TEXT NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS connector_market_installed_releases (
  connector_key TEXT PRIMARY KEY,
  release_digest TEXT NOT NULL,
  release_json TEXT NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS connector_market_authorization_projections (
  account_id TEXT NOT NULL,
  connector_key TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  PRIMARY KEY (account_id, connector_key)
)`,
		`CREATE TABLE IF NOT EXISTS connector_market_authorization_snapshot_revisions (
  account_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0)
)`,
		`CREATE TABLE IF NOT EXISTS connector_market_operations (
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
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS connector_market_one_active_operation
ON connector_market_operations(connector_key)
WHERE state IN ('accepted', 'running')`,
		`CREATE TABLE IF NOT EXISTS connector_market_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  published_at_unix_ms INTEGER
)`,
		`CREATE INDEX IF NOT EXISTS connector_market_outbox_pending
ON connector_market_outbox(published_at_unix_ms, sequence)`,
	}
	for _, statement := range statements {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate connector market store: %w", err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `ALTER TABLE connector_market_operations ADD COLUMN lease_token INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate connector market operation lease token: %w", err)
	}
	if err := store.migrateLifecycle(ctx); err != nil {
		return err
	}
	if err := store.migrateOperationOwnership(ctx); err != nil {
		return err
	}
	return store.migrateRuntimeConvergence(ctx)
}

func (store *Store) Snapshot(ctx context.Context) (market.Snapshot, error) {
	return store.snapshot(ctx, "")
}

// SnapshotForScope reads market state and the account authorization overlay
// from one SQLite snapshot, so its revision/event cursor describe exactly the
// projection returned to the renderer.
func (store *Store) SnapshotForScope(ctx context.Context, scope market.OperationScope) (market.Snapshot, error) {
	return store.snapshot(ctx, strings.TrimSpace(scope.AccountID))
}

func (store *Store) snapshot(ctx context.Context, accountID string) (market.Snapshot, error) {
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return market.Snapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var result market.Snapshot
	if err := tx.QueryRowContext(ctx, `
SELECT revision, catalog_state, source_revision
FROM connector_market_metadata WHERE id = ?`, metadataID).
		Scan(&result.Revision, &result.CatalogState, &result.SourceRevision); err != nil {
		return market.Snapshot{}, fmt.Errorf("read connector market metadata: %w", err)
	}
	connectors, err := listConnectorsOn(ctx, tx)
	if err != nil {
		return market.Snapshot{}, err
	}
	if accountID != "" {
		connectors, err = overlayAuthorizationProjectionsOn(ctx, tx, accountID, connectors)
		if err != nil {
			return market.Snapshot{}, err
		}
	}
	operations, err := listOperationsOn(ctx, tx, accountID)
	if err != nil {
		return market.Snapshot{}, err
	}
	result.Connectors = connectors
	result.Operations = operations
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence), 0) FROM connector_market_outbox`).Scan(&result.EventCursor); err != nil {
		return market.Snapshot{}, fmt.Errorf("read connector market event cursor: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return market.Snapshot{}, err
	}
	return result, nil
}

func (store *Store) Connector(ctx context.Context, connectorKey string) (market.Connector, error) {
	var payload string
	if err := store.db.QueryRowContext(ctx, `
SELECT connector_json FROM connector_market_connectors WHERE connector_key = ?`, connectorKey).Scan(&payload); err != nil {
		return market.Connector{}, mapNotFound(err)
	}
	connector, err := decodeConnector(payload)
	if err != nil {
		return market.Connector{}, err
	}
	return connector, nil
}

func (store *Store) Operation(ctx context.Context, operationID string) (market.Operation, error) {
	var payload string
	if err := store.db.QueryRowContext(ctx, `
SELECT operation_json FROM connector_market_operations WHERE operation_id = ?`, operationID).Scan(&payload); err != nil {
		return market.Operation{}, mapNotFound(err)
	}
	return decodeOperation(payload)
}

func (store *Store) ClaimOperation(
	ctx context.Context,
	operationID string,
	owner string,
	now time.Time,
	leaseExpiresAt time.Time,
) (market.Operation, bool, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return market.Operation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE connector_market_operations
SET lease_owner = ?, lease_token = lease_token + 1, lease_expires_at_unix_ms = ?
WHERE operation_id = ?
  AND state IN ('accepted', 'running')
  AND (
    lease_owner = '' OR lease_expires_at_unix_ms IS NULL OR
    lease_expires_at_unix_ms <= ?
  )`, owner, leaseExpiresAt.UTC().UnixMilli(), operationID, now.UTC().UnixMilli())
	if err != nil {
		return market.Operation{}, false, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return market.Operation{}, false, err
	}
	operation, err := operationOn(ctx, tx, operationID)
	if err != nil {
		return market.Operation{}, false, err
	}
	if changed == 0 {
		return operation, false, tx.Commit()
	}
	if err := tx.QueryRowContext(ctx, `SELECT lease_token FROM connector_market_operations WHERE operation_id = ?`, operationID).Scan(&operation.LeaseToken); err != nil {
		return market.Operation{}, false, err
	}
	expiresAt := leaseExpiresAt.UTC()
	operation.LeaseOwner = owner
	operation.LeaseExpiresAt = &expiresAt
	if err := saveOperationOn(ctx, tx, operation); err != nil {
		return market.Operation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return market.Operation{}, false, err
	}
	return operation, true, nil
}

func (store *Store) RenewOperationLease(ctx context.Context, operationID, owner string, token uint64, now, leaseExpiresAt time.Time) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	operation, err := operationOn(ctx, tx, operationID)
	if err != nil {
		return err
	}
	var currentOwner string
	var currentToken uint64
	var currentExpiry sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT lease_owner, lease_token, lease_expires_at_unix_ms FROM connector_market_operations WHERE operation_id = ?`, operationID).
		Scan(&currentOwner, &currentToken, &currentExpiry); err != nil {
		return err
	}
	if currentOwner != owner || currentToken != token || !currentExpiry.Valid || currentExpiry.Int64 <= now.UTC().UnixMilli() {
		return market.ErrOperationLeaseLost
	}
	expiresAt := leaseExpiresAt.UTC()
	operation.LeaseOwner, operation.LeaseToken, operation.LeaseExpiresAt = owner, token, &expiresAt
	payload, err := json.Marshal(operation)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE connector_market_operations SET lease_expires_at_unix_ms = ?, operation_json = ? WHERE operation_id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at_unix_ms > ?`,
		expiresAt.UnixMilli(), string(payload), operationID, owner, token, now.UTC().UnixMilli())
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		return market.ErrOperationLeaseLost
	}
	return tx.Commit()
}

func (store *Store) ReleaseOperationLease(ctx context.Context, operationID, owner string, token uint64) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE connector_market_operations
SET lease_owner = '', lease_expires_at_unix_ms = NULL
WHERE operation_id = ? AND lease_owner = ? AND lease_token = ?`, operationID, owner, token)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return tx.Commit()
	}
	operation, err := operationOn(ctx, tx, operationID)
	if err != nil {
		return err
	}
	operation.LeaseOwner = ""
	operation.LeaseExpiresAt = nil
	if err := saveOperationOn(ctx, tx, operation); err != nil {
		return err
	}
	return tx.Commit()
}

func (store *Store) InstalledRelease(ctx context.Context, connectorKey, releaseDigest string) (market.Release, error) {
	var payload string
	err := store.db.QueryRowContext(ctx, `
SELECT release_json FROM connector_market_release_installations
WHERE connector_key = ? AND release_digest = ?`, connectorKey, releaseDigest).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		err = store.db.QueryRowContext(ctx, `
SELECT release_json FROM connector_market_installed_releases
WHERE connector_key = ? AND release_digest = ?`, connectorKey, releaseDigest).Scan(&payload)
	}
	if err != nil {
		return market.Release{}, mapNotFound(err)
	}
	var release market.Release
	if err := json.Unmarshal([]byte(payload), &release); err != nil {
		return market.Release{}, fmt.Errorf("decode installed connector release: %w", err)
	}
	return release, nil
}

func (store *Store) RecoverableOperations(ctx context.Context) ([]market.Operation, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE state IN ('accepted', 'running')
ORDER BY operation_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	operations := make([]market.Operation, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}

func (store *Store) UnresolvedAuthorizationSessionOperations(
	ctx context.Context,
	scope market.OperationScope,
) ([]market.Operation, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE kind = 'start_authorization' AND state = 'completed'
ORDER BY operation_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	operations := make([]market.Operation, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			return nil, err
		}
		if operation.Scope.AccountID != scope.AccountID || operation.Execution.AuthorizationSession == nil ||
			operation.Execution.AuthorizationSession.IsResolved() {
			continue
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}

func (store *Store) ResolveAuthorizationSession(
	ctx context.Context,
	operationID string,
	resolution market.AuthorizationSessionResolution,
) error {
	if !validAuthorizationSessionResolutionTransition(resolution) {
		return errors.New("valid authorization session resolution is required")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	operation, err := operationOn(ctx, tx, operationID)
	if err != nil {
		return err
	}
	if operation.Execution.AuthorizationSession == nil || operation.Execution.AuthorizationSession.IsResolved() {
		return tx.Commit()
	}
	operation.Execution.AuthorizationSession.Resolution = resolution
	operation.UpdatedAt = time.Now().UTC()
	if err := saveOperationOn(ctx, tx, operation); err != nil {
		return err
	}
	return tx.Commit()
}

func validAuthorizationSessionResolutionTransition(resolution market.AuthorizationSessionResolution) bool {
	switch resolution {
	case market.AuthorizationSessionResolutionCanceling,
		market.AuthorizationSessionResolutionProviderConnected,
		market.AuthorizationSessionResolutionProviderFailed,
		market.AuthorizationSessionResolutionAccountStateConverged,
		market.AuthorizationSessionResolutionSuperseded:
		return true
	default:
		return false
	}
}

func (store *Store) Transaction(ctx context.Context, fn func(market.Transaction) error) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var revision uint64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM connector_market_metadata WHERE id = ?`, metadataID).Scan(&revision); err != nil {
		return err
	}
	transaction := &transaction{ctx: ctx, tx: tx, revision: revision}
	if err := fn(transaction); err != nil {
		return err
	}
	if transaction.revision != revision {
		result, err := tx.ExecContext(ctx, `
UPDATE connector_market_metadata SET revision = ? WHERE id = ? AND revision = ?`,
			transaction.revision, metadataID, revision)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed != 1 {
			return errors.New("connector market revision changed during transaction")
		}
	}
	return tx.Commit()
}

func (store *Store) PendingChangedEvents(ctx context.Context, limit int) ([]market.ChangedEventRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := store.db.QueryContext(ctx, `
SELECT sequence, event_json FROM connector_market_outbox
WHERE published_at_unix_ms IS NULL ORDER BY sequence LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]market.ChangedEventRecord, 0)
	for rows.Next() {
		var entry market.ChangedEventRecord
		var payload string
		if err := rows.Scan(&entry.Sequence, &payload); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(payload), &entry.Event); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (store *Store) MarkChangedEventPublished(ctx context.Context, sequence int64, publishedAt time.Time) error {
	_, err := store.db.ExecContext(ctx, `
UPDATE connector_market_outbox
SET published_at_unix_ms = COALESCE(published_at_unix_ms, ?)
WHERE sequence = ?`, publishedAt.UTC().UnixMilli(), sequence)
	return err
}

type transaction struct {
	ctx      context.Context
	tx       *sql.Tx
	revision uint64
}

func (transaction *transaction) Revision() uint64 { return transaction.revision }

func (transaction *transaction) AdvanceRevision() uint64 {
	transaction.revision++
	return transaction.revision
}

func (transaction *transaction) Connectors() ([]market.Connector, error) {
	rows, err := transaction.tx.QueryContext(transaction.ctx, `
SELECT connector_json FROM connector_market_connectors ORDER BY connector_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	connectors := make([]market.Connector, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		connector, err := decodeConnector(payload)
		if err != nil {
			return nil, err
		}
		connectors = append(connectors, connector)
	}
	return connectors, rows.Err()
}

func (transaction *transaction) Connector(connectorKey string) (market.Connector, error) {
	var payload string
	if err := transaction.tx.QueryRowContext(transaction.ctx, `
SELECT connector_json FROM connector_market_connectors WHERE connector_key = ?`, connectorKey).Scan(&payload); err != nil {
		return market.Connector{}, mapNotFound(err)
	}
	return decodeConnector(payload)
}

func (transaction *transaction) Operation(operationID string) (market.Operation, error) {
	return operationOn(transaction.ctx, transaction.tx, operationID)
}

func (transaction *transaction) OperationByClientRequestID(ownerAccountID, clientRequestID string) (*market.Operation, error) {
	var payload string
	if err := transaction.tx.QueryRowContext(transaction.ctx, `
SELECT operation_json FROM connector_market_operations
WHERE owner_account_id = ? AND client_request_id = ?`,
		strings.TrimSpace(ownerAccountID), clientRequestID).Scan(&payload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	operation, err := decodeOperation(payload)
	return &operation, err
}

func (transaction *transaction) ActiveOperationInLane(connectorKey string) (*market.Operation, error) {
	var payload string
	if err := transaction.tx.QueryRowContext(transaction.ctx, `
SELECT operation_json FROM connector_market_operations
WHERE connector_key = ? AND state IN ('accepted', 'running') LIMIT 1`,
		strings.TrimSpace(connectorKey)).Scan(&payload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	operation, err := decodeOperation(payload)
	return &operation, err
}

func (transaction *transaction) SaveCatalogRevision(sourceRevision string) error {
	_, err := transaction.tx.ExecContext(transaction.ctx, `
UPDATE connector_market_metadata SET source_revision = ? WHERE id = ?`, sourceRevision, metadataID)
	return err
}

func (transaction *transaction) SetCatalogState(state market.CatalogState) error {
	_, err := transaction.tx.ExecContext(transaction.ctx, `
UPDATE connector_market_metadata SET catalog_state = ? WHERE id = ?`, state, metadataID)
	return err
}

func (transaction *transaction) SaveConnector(connector market.Connector) error {
	payload, err := json.Marshal(connector)
	if err != nil {
		return err
	}
	_, err = transaction.tx.ExecContext(transaction.ctx, `
INSERT INTO connector_market_connectors (connector_key, connector_json)
VALUES (?, ?)
ON CONFLICT(connector_key) DO UPDATE SET connector_json = excluded.connector_json`,
		connector.Key, string(payload))
	return err
}

func (transaction *transaction) DeleteConnector(connectorKey string) error {
	_, err := transaction.tx.ExecContext(transaction.ctx, `
DELETE FROM connector_market_connectors WHERE connector_key = ?`, connectorKey)
	return err
}

func (transaction *transaction) SaveOperation(operation market.Operation) error {
	return saveOperationOn(transaction.ctx, transaction.tx, operation)
}

func (transaction *transaction) RuntimeConvergence(
	scope market.OperationScope,
	connectorKey string,
) (market.RuntimeConvergence, error) {
	return runtimeConvergenceOn(transaction.ctx, transaction.tx, scope, connectorKey)
}

func (transaction *transaction) SaveRuntimeConvergence(convergence market.RuntimeConvergence) error {
	return saveRuntimeConvergenceOn(transaction.ctx, transaction.tx, convergence)
}

func (transaction *transaction) DeleteRuntimeConvergence(scope market.OperationScope, connectorKey string) error {
	_, err := transaction.tx.ExecContext(transaction.ctx, `
DELETE FROM connector_market_runtime_convergence
WHERE account_id = ? AND connector_key = ?`, strings.TrimSpace(scope.AccountID), strings.TrimSpace(connectorKey))
	return err
}

func (transaction *transaction) EnqueueConnectorMarketChanged(event market.ChangedEvent) error {
	if strings.TrimSpace(event.OperationID) != "" {
		operation, err := transaction.Operation(event.OperationID)
		if err != nil && !errors.Is(err, market.ErrNotFound) {
			return err
		}
		if err == nil {
			operation = market.NormalizeOperationOwnership(operation)
			if operation.Visibility == market.OperationVisibilityAccount {
				accountEvent := event
				accountEvent.OwnerAccountID = operation.OwnerAccountID
				accountEvent.Visibility = market.OperationVisibilityAccount
				if err := transaction.appendChangedEvent(accountEvent); err != nil {
					return err
				}
			}
		}
	}
	event.OperationID = ""
	event.OwnerAccountID = ""
	event.Visibility = market.OperationVisibilitySystemPrivate
	return transaction.appendChangedEvent(event)
}

func (transaction *transaction) appendChangedEvent(event market.ChangedEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = transaction.tx.ExecContext(transaction.ctx, `
INSERT INTO connector_market_outbox (revision, event_json, published_at_unix_ms)
VALUES (?, ?, NULL)`, event.Revision, string(payload))
	return err
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func listConnectorsOn(ctx context.Context, database queryer) ([]market.Connector, error) {
	rows, err := database.QueryContext(ctx, `
SELECT connector_json FROM connector_market_connectors ORDER BY connector_key`)
	if err != nil {
		return nil, err
	}
	connectors := make([]market.Connector, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		connector, err := decodeConnector(payload)
		if err != nil {
			return nil, err
		}
		connectors = append(connectors, connector)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return connectors, nil
}

func listOperationsOn(ctx context.Context, database queryer, accountID string) ([]market.Operation, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return []market.Operation{}, nil
	}
	rows, err := database.QueryContext(ctx, `
SELECT operation_json FROM connector_market_operations
WHERE owner_account_id = ? AND visibility = ? ORDER BY operation_id`,
		accountID, market.OperationVisibilityAccount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	operations := make([]market.Operation, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		operation, err := decodeOperation(payload)
		if err != nil {
			return nil, err
		}
		operations = append(operations, publicOperation(operation))
	}
	return operations, rows.Err()
}

func operationOn(ctx context.Context, tx *sql.Tx, operationID string) (market.Operation, error) {
	var payload string
	if err := tx.QueryRowContext(ctx, `
SELECT operation_json FROM connector_market_operations WHERE operation_id = ?`, operationID).Scan(&payload); err != nil {
		return market.Operation{}, mapNotFound(err)
	}
	return decodeOperation(payload)
}

func saveOperationOn(ctx context.Context, tx *sql.Tx, operation market.Operation) error {
	operation = market.NormalizeOperationOwnership(operation)
	payload, err := json.Marshal(operation)
	if err != nil {
		return err
	}
	var leaseExpiresAt any
	if operation.LeaseExpiresAt != nil {
		leaseExpiresAt = operation.LeaseExpiresAt.UTC().UnixMilli()
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO connector_market_operations (
  operation_id, client_request_id, owner_account_id, visibility, connector_key, kind, state,
  lease_owner, lease_token, lease_expires_at_unix_ms, updated_at_unix_ms, operation_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(operation_id) DO UPDATE SET
	owner_account_id = excluded.owner_account_id,
	visibility = excluded.visibility,
  state = excluded.state,
  lease_owner = excluded.lease_owner,
	lease_token = excluded.lease_token,
  lease_expires_at_unix_ms = excluded.lease_expires_at_unix_ms,
	updated_at_unix_ms = excluded.updated_at_unix_ms,
	operation_json = excluded.operation_json
WHERE excluded.lease_token = 0 OR (
  connector_market_operations.lease_owner = excluded.lease_owner AND
  connector_market_operations.lease_token = excluded.lease_token
)`,
		operation.OperationID, operation.ClientRequestID, operation.OwnerAccountID, operation.Visibility, operation.ConnectorKey,
		operation.Kind, operation.State, operation.LeaseOwner, operation.LeaseToken, leaseExpiresAt,
		operation.UpdatedAt.UTC().UnixMilli(), string(payload))
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if operation.LeaseToken > 0 && changed != 1 {
		return market.ErrOperationLeaseLost
	}
	return saveInstalledReleaseEvidenceOn(ctx, tx, operation)
}

func decodeConnector(payload string) (market.Connector, error) {
	var connector market.Connector
	if err := json.Unmarshal([]byte(payload), &connector); err != nil {
		return market.Connector{}, fmt.Errorf("decode connector market connector: %w", err)
	}
	return connector, nil
}

func decodeOperation(payload string) (market.Operation, error) {
	var operation market.Operation
	if err := json.Unmarshal([]byte(payload), &operation); err != nil {
		return market.Operation{}, fmt.Errorf("decode connector market operation: %w", err)
	}
	return operation, nil
}

func publicOperation(operation market.Operation) market.Operation {
	operation.Execution = market.OperationExecution{}
	operation.LeaseOwner = ""
	operation.LeaseToken = 0
	operation.LeaseExpiresAt = nil
	if operation.Target != nil {
		target := *operation.Target
		target.Release = nil
		operation.Target = &target
	}
	return operation
}

func mapNotFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return market.ErrNotFound
	}
	return err
}
