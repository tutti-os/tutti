package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestConnectorMarketSQLiteDSNUsesWindowsFileURI(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-specific SQLite file URI")
	}
	for _, test := range []struct {
		name, databasePath, host, uriPath string
	}{
		{name: "drive path", databasePath: `Z:\Users\Example User\.tutti-dev\tuttid.db`, uriPath: "/Z:/Users/Example User/.tutti-dev/tuttid.db"},
		{name: "UNC path", databasePath: `\\storage-host\tutti state\tuttid.db`, host: "storage-host", uriPath: "/tutti state/tuttid.db"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dsn := connectorMarketSQLiteDSN(test.databasePath, url.Values{
				"_pragma": {"busy_timeout(5000)", "foreign_keys(1)"},
			})
			parsed, err := url.Parse(dsn)
			if err != nil {
				t.Fatal(err)
			}
			if parsed.Scheme != "file" || parsed.Host != test.host || parsed.Path != test.uriPath || len(parsed.Query()["_pragma"]) != 2 {
				t.Fatalf("connector market SQLite DSN = %q", dsn)
			}
		})
	}
}

func TestStoreMigrationDropsLegacyTrustTables(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	legacy, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE connector_market_catalog_trust (id INTEGER PRIMARY KEY, trust_json TEXT NOT NULL)`,
		`CREATE TABLE connector_market_security_revocations (connector_key TEXT NOT NULL, release_digest TEXT NOT NULL)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			_ = legacy.Close()
			t.Fatal(err)
		}
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, table := range []string{"connector_market_catalog_trust", "connector_market_security_revocations"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("legacy table %q still exists", table)
		}
	}
}

func TestStoreMigrationBackfillsOwnedOperationsAndKeepsUnknownOwnerPrivate(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	legacy, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `CREATE TABLE connector_market_operations (
  operation_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  connector_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_unix_ms INTEGER,
  updated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  operation_json TEXT NOT NULL
)`); err != nil {
		_ = legacy.Close()
		t.Fatal(err)
	}
	now := time.Unix(1, 0).UTC()
	operations := []market.Operation{
		{OperationID: "owned", ClientRequestID: "request-owned", ConnectorKey: "github", Kind: market.OperationKindInstall,
			Scope: market.OperationScope{AccountID: "account-a"}, State: market.OperationStateFailed, CreatedAt: now, UpdatedAt: now},
		{OperationID: "private", ClientRequestID: "request-private", ConnectorKey: "slack", Kind: market.OperationKindReconcileRuntime,
			Scope: market.OperationScope{AccountID: "account-a"}, State: market.OperationStateFailed, CreatedAt: now, UpdatedAt: now},
		{OperationID: "unknown-owner", ClientRequestID: "request-unknown", ConnectorKey: "notion", Kind: market.OperationKindInstall,
			State: market.OperationStateAccepted, CreatedAt: now, UpdatedAt: now},
	}
	for _, operation := range operations {
		payload, err := json.Marshal(operation)
		if err != nil {
			_ = legacy.Close()
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO connector_market_operations (
  operation_id, client_request_id, connector_key, kind, state, lease_owner, lease_token,
  lease_expires_at_unix_ms, updated_at_unix_ms, operation_json
) VALUES (?, ?, ?, ?, ?, '', 0, NULL, ?, ?)`, operation.OperationID, operation.ClientRequestID,
			operation.ConnectorKey, operation.Kind, operation.State, operation.UpdatedAt.UnixMilli(), string(payload)); err != nil {
			_ = legacy.Close()
			t.Fatal(err)
		}
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	snapshot, err := store.SnapshotForScope(ctx, market.OperationScope{AccountID: "account-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].OperationID != "owned" {
		t.Fatalf("migrated public operations = %#v", snapshot.Operations)
	}
	if _, err := store.OperationForScope(ctx, market.OperationScope{AccountID: "account-a"}, "private"); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("private operation error = %v", err)
	}
	if _, err := store.OperationForScope(ctx, market.OperationScope{AccountID: "account-a"}, "unknown-owner"); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("unknown-owner operation error = %v", err)
	}
	recoverable, err := store.RecoverableOperations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recoverable) != 1 || recoverable[0].OperationID != "unknown-owner" {
		t.Fatalf("recoverable migrated operations = %#v", recoverable)
	}
	for _, accountID := range []string{"account-a", "account-b"} {
		operation := market.Operation{
			OperationID: "reused-" + accountID, ClientRequestID: "reused-after-migration", ConnectorKey: "linear",
			Kind: market.OperationKindInstall, Scope: market.OperationScope{AccountID: accountID},
			State: market.OperationStateFailed, CreatedAt: now, UpdatedAt: now,
		}
		if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
			t.Fatalf("reuse client request after migration for %s: %v", accountID, err)
		}
	}
}

func TestStorePersistsRevisionOperationBindingAndOutboxAtomically(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connector := testConnector()
	operation := market.Operation{
		OperationID: "operation-1", ClientRequestID: "request-1", ConnectorKey: connector.Key,
		Kind: market.OperationKindInstall, State: market.OperationStateAccepted,
		Scope: market.OperationScope{AccountID: "account-1"},
		Stage: market.OperationStageAccepted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		revision := tx.AdvanceRevision()
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(market.ChangedEvent{
			ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision,
		})
	}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.SnapshotForScope(ctx, operation.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 1 || snapshot.EventCursor != 2 || len(snapshot.Connectors) != 1 || len(snapshot.Operations) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	entries, err := store.PendingChangedEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Event.OperationID != operation.OperationID ||
		entries[0].Event.OwnerAccountID != operation.Scope.AccountID || entries[1].Event.OperationID != "" {
		t.Fatalf("outbox = %#v", entries)
	}
}

func TestStoreScopedSnapshotOnlyReturnsOperationsOwnedByAccount(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1, 0).UTC()
	connector := testConnector()
	connector.Installation = market.Installation{
		State: market.InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveConnector(connector) }); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []market.Operation{
		{OperationID: "operation-a", ClientRequestID: "request-a", ConnectorKey: "github", Kind: market.OperationKindInstall,
			Scope: market.OperationScope{AccountID: "account-a"}, State: market.OperationStateAccepted, CreatedAt: now, UpdatedAt: now},
		{OperationID: "operation-b", ClientRequestID: "request-b", ConnectorKey: "github", Kind: market.OperationKindUninstall,
			Scope: market.OperationScope{AccountID: "account-b"}, State: market.OperationStateCompleted, CreatedAt: now, UpdatedAt: now},
		{OperationID: "operation-private", ClientRequestID: "request-private", ConnectorKey: "github", Kind: market.OperationKindReconcileRuntime,
			Scope: market.OperationScope{AccountID: "account-b"}, State: market.OperationStateCompleted, CreatedAt: now, UpdatedAt: now},
		{OperationID: "operation-legacy", ClientRequestID: "request-legacy", ConnectorKey: "github", Kind: market.OperationKindInstall,
			State: market.OperationStateFailed, CreatedAt: now, UpdatedAt: now},
	} {
		operation := operation
		if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
			t.Fatal(err)
		}
	}

	snapshot, err := store.SnapshotForScope(ctx, market.OperationScope{AccountID: "account-b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].OperationID != "operation-b" {
		t.Fatalf("account-b operations = %#v, want only operation-b", snapshot.Operations)
	}
	if len(snapshot.Connectors) != 1 || snapshot.Connectors[0].Installation.State != market.InstallationStateInstalled {
		t.Fatalf("account-b machine connector state = %#v", snapshot.Connectors)
	}
	if operation, err := store.OperationForScope(ctx, market.OperationScope{AccountID: "account-a"}, "operation-a"); err != nil || operation.OperationID != "operation-a" {
		t.Fatalf("account-a operation = %#v, error = %v", operation, err)
	}
	if _, err := store.OperationForScope(ctx, market.OperationScope{AccountID: "account-b"}, "operation-a"); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("account-b operation-a error = %v, want ErrNotFound", err)
	}
	recoverable, err := store.RecoverableOperations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recoverable) != 1 || recoverable[0].OperationID != "operation-a" {
		t.Fatalf("hidden account-a operation was not recoverable: %#v", recoverable)
	}
}

func TestStoreAllowsClientRequestIDReuseAcrossAccounts(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1, 0).UTC()
	for _, accountID := range []string{"account-a", "account-b"} {
		operation := market.Operation{
			OperationID: "operation-" + accountID, ClientRequestID: "shared-request", ConnectorKey: "github",
			Kind: market.OperationKindInstall, Scope: market.OperationScope{AccountID: accountID},
			State: market.OperationStateFailed, CreatedAt: now, UpdatedAt: now,
		}
		if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
			t.Fatalf("save operation for %s: %v", accountID, err)
		}
	}
}

func TestStoreKeepsActiveConnectorLifecycleUniqueAcrossAccounts(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1, 0).UTC()
	for _, accountID := range []string{"account-a", "account-b"} {
		operation := market.Operation{
			OperationID: "operation-" + accountID, ClientRequestID: "request-" + accountID, ConnectorKey: "github",
			Kind: market.OperationKindInstall, Scope: market.OperationScope{AccountID: accountID},
			State: market.OperationStateAccepted, CreatedAt: now, UpdatedAt: now,
		}
		err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) })
		if accountID == "account-a" && err != nil {
			t.Fatal(err)
		}
		if accountID == "account-b" && err == nil {
			t.Fatal("second account started a concurrent physical lifecycle operation for the same connector")
		}
	}
}

func TestStoreScopesActiveOperationsToExactLane(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1, 0).UTC()
	operations := []market.Operation{
		{
			OperationID: "refresh", ClientRequestID: "refresh", ConnectorKey: "",
			Kind: market.OperationKindRefreshCatalog, State: market.OperationStateRunning,
			CreatedAt: now, UpdatedAt: now,
		},
		{
			OperationID: "authorization", ClientRequestID: "authorization", ConnectorKey: "google-sheets",
			Kind: market.OperationKindStartAuthorization, State: market.OperationStateAccepted,
			Scope: market.OperationScope{AccountID: "account-a"}, CreatedAt: now, UpdatedAt: now,
		},
	}
	for _, operation := range operations {
		operation := operation
		if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
			t.Fatalf("save %s operation: %v", operation.OperationID, err)
		}
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		catalog, err := tx.ActiveOperationInLane("")
		if err != nil {
			return err
		}
		connector, err := tx.ActiveOperationInLane("google-sheets")
		if err != nil {
			return err
		}
		if catalog == nil || catalog.OperationID != "refresh" {
			return fmt.Errorf("catalog lane operation = %#v", catalog)
		}
		if connector == nil || connector.OperationID != "authorization" {
			return fmt.Errorf("connector lane operation = %#v", connector)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	secondRefresh := market.Operation{
		OperationID: "refresh-2", ClientRequestID: "refresh-2", ConnectorKey: "",
		Kind: market.OperationKindRefreshCatalog, State: market.OperationStateAccepted,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(secondRefresh) }); err == nil {
		t.Fatal("second active catalog refresh unexpectedly entered the catalog lane")
	}
}

func TestStorePrivateOperationEventDoesNotExposeOperationID(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	operation := market.Operation{
		OperationID: "reconcile-1", ClientRequestID: "reconcile-request", ConnectorKey: "github",
		Kind: market.OperationKindReconcileRuntime, Scope: market.OperationScope{AccountID: "account-a"},
		State: market.OperationStateAccepted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(market.ChangedEvent{
			ConnectorKey: operation.ConnectorKey, OperationID: operation.OperationID, Revision: tx.AdvanceRevision(),
		})
	}); err != nil {
		t.Fatal(err)
	}
	events, err := store.PendingChangedEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Event.OperationID != "" {
		t.Fatalf("private operation event = %#v, want one machine event without operation id", events)
	}
}

func TestStoreKeepsAuthorizationSessionPrivateAndAvailableAfterReopen(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	connector := testConnector()
	connector.Authorization = market.Authorization{State: market.AuthorizationStatePending}
	operation := market.Operation{
		OperationID: "authorization-1", ClientRequestID: "request-1", ConnectorKey: connector.Key,
		Kind: market.OperationKindStartAuthorization, State: market.OperationStateCompleted,
		Scope: market.OperationScope{AccountID: "account-1"},
		Stage: market.OperationStageCompleted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
		Execution: market.OperationExecution{AuthorizationSession: &market.AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key,
			SessionID: "session-1", ActionType: "redirect", AuthorizationURL: "https://example.test/authorize",
			StepRevision: 3, State: market.AuthorizationStatePending,
		}},
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.SaveOperation(operation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.ResolveAuthorizationSession(
		ctx, operation.OperationID, market.AuthorizationSessionResolutionCanceling,
	); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	snapshot, err := reopened.SnapshotForScope(ctx, operation.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].Execution.AuthorizationSession != nil {
		t.Fatalf("public snapshot exposed authorization session: %#v", snapshot.Operations)
	}
	operations, err := reopened.UnresolvedAuthorizationSessionOperations(ctx, operation.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 1 || operations[0].Execution.AuthorizationSession == nil ||
		operations[0].Execution.AuthorizationSession.SessionID != "session-1" ||
		operations[0].Execution.AuthorizationSession.StepRevision != 3 ||
		operations[0].Execution.AuthorizationSession.AuthorizationURL != "" ||
		operations[0].Execution.AuthorizationSession.Resolution != market.AuthorizationSessionResolutionCanceling {
		t.Fatalf("authorization operations = %#v", operations)
	}
}

func TestStorePersistsAuthorizationProjectionByAccount(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first := market.AuthorizationProjection{AccountID: "account-1", ConnectorKey: "github",
		ConnectionID: "connection-1", State: market.AuthorizationStateConnected, UpdatedAt: time.Unix(1, 0).UTC()}
	second := market.AuthorizationProjection{AccountID: "account-2", ConnectorKey: "github",
		ConnectionID: "connection-2", State: market.AuthorizationStateExpired, UpdatedAt: time.Unix(2, 0).UTC()}
	for _, projection := range []market.AuthorizationProjection{first, second} {
		if err := store.SaveAuthorizationProjection(ctx, projection); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := store.AuthorizationProjection(ctx, first.AccountID, first.ConnectorKey)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != first {
		t.Fatalf("projection = %#v, want %#v", loaded, first)
	}
	loaded, err = store.AuthorizationProjection(ctx, second.AccountID, second.ConnectorKey)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != second {
		t.Fatalf("projection = %#v, want %#v", loaded, second)
	}
}

func TestStoreScopedSnapshotAtomicallyIncludesAuthorizationRevisionAndEventCursor(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connector := testConnector()
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		return tx.SaveConnector(connector)
	}); err != nil {
		t.Fatal(err)
	}
	projection := market.AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: connector.Key, ConnectionID: "connection-1",
		State: market.AuthorizationStateConnected, UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := store.SaveAuthorizationProjection(ctx, projection); err != nil {
		t.Fatal(err)
	}

	snapshot, err := store.SnapshotForScope(ctx, market.OperationScope{AccountID: projection.AccountID})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 2 || snapshot.EventCursor != 1 || len(snapshot.Connectors) != 1 ||
		snapshot.Connectors[0].Revision != 2 || snapshot.Connectors[0].Authorization.State != market.AuthorizationStateConnected {
		t.Fatalf("scoped snapshot = %#v", snapshot)
	}
	projection.UpdatedAt = projection.UpdatedAt.Add(time.Minute)
	if err := store.SaveAuthorizationProjection(ctx, projection); err != nil {
		t.Fatal(err)
	}
	unchanged, err := store.SnapshotForScope(ctx, market.OperationScope{AccountID: projection.AccountID})
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Revision != snapshot.Revision || unchanged.EventCursor != snapshot.EventCursor {
		t.Fatalf("non-public projection update advanced snapshot: %#v", unchanged)
	}
}

func TestStoreAuthorizationSnapshotIsMonotonicAndDisconnectsMissingConnectors(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	applied, err := store.ApplyAuthorizationSnapshot(ctx, "account-1", market.AuthorizationSnapshot{Revision: 8, Connectors: []market.AuthorizationProjection{{
		ConnectorKey: "tencent-docs", ConnectorVersion: "0.2.0", ConnectionID: "connection-1", ConnectionVersion: 3,
		State: market.AuthorizationStateConnected,
	}}})
	if err != nil || len(applied.ChangedConnectorKeys) != 1 || applied.ChangedConnectorKeys[0] != "tencent-docs" {
		t.Fatalf("initial snapshot applied=%#v error=%v", applied, err)
	}
	if err := store.SaveAuthorizationProjection(ctx, market.AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: "tencent-docs", State: market.AuthorizationStateDisconnected,
	}); err != nil {
		t.Fatal(err)
	}
	projection, err := store.AuthorizationProjection(ctx, "account-1", "tencent-docs")
	if err != nil || projection.State != market.AuthorizationStateConnected || projection.ServerRevision != 8 {
		t.Fatalf("provisional write replaced server snapshot: %#v, %v", projection, err)
	}
	applied, err = store.ApplyAuthorizationSnapshot(ctx, "account-1", market.AuthorizationSnapshot{Revision: 7})
	if err != nil || len(applied.ChangedConnectorKeys) != 0 {
		t.Fatalf("stale snapshot applied=%#v error=%v", applied, err)
	}
	applied, err = store.ApplyAuthorizationSnapshot(ctx, "account-1", market.AuthorizationSnapshot{Revision: 9})
	if err != nil || len(applied.ChangedConnectorKeys) != 1 || applied.ChangedConnectorKeys[0] != "tencent-docs" {
		t.Fatalf("removal snapshot applied=%#v error=%v", applied, err)
	}
	projection, err = store.AuthorizationProjection(ctx, "account-1", "tencent-docs")
	if err != nil || projection.State != market.AuthorizationStateDisconnected || projection.ConnectionID != "" || projection.ServerRevision != 9 {
		t.Fatalf("removed projection = %#v, %v", projection, err)
	}
}

func TestStoreAuthorizationSnapshotAtomicallyResolvesOnlyMatchingAccountReceipts(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connected := market.AuthorizationSnapshot{Revision: 8, Connectors: []market.AuthorizationProjection{{
		ConnectorKey: "tencent-docs", ConnectorVersion: "0.2.0", ConnectionID: "connection-1",
		ConnectionVersion: 3, State: market.AuthorizationStateConnected,
	}}}
	if _, err := store.ApplyAuthorizationSnapshot(ctx, "account-1", connected); err != nil {
		t.Fatal(err)
	}
	for _, accountID := range []string{"account-1", "account-2"} {
		operation := market.Operation{
			OperationID: "authorization-" + accountID, ClientRequestID: "request-" + accountID,
			ConnectorKey: "tencent-docs", Kind: market.OperationKindStartAuthorization,
			Scope: market.OperationScope{AccountID: accountID}, State: market.OperationStateCompleted,
			Stage: market.OperationStageCompleted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
			Execution: market.OperationExecution{AuthorizationSession: &market.AuthorizationSession{
				OperationID: "authorization-" + accountID, ConnectorKey: "tencent-docs", SessionID: "session-" + accountID,
				ActionType: "redirect", State: market.AuthorizationStatePending,
				Resolution: market.AuthorizationSessionResolutionUnresolved,
			}},
		}
		if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
			t.Fatal(err)
		}
	}

	// Reapplying the same server revision must still surface a receipt created
	// after the projection was first stored, without terminalizing it before
	// the daemon has awaited Runtime Reconcile.
	applied, err := store.ApplyAuthorizationSnapshot(ctx, "account-1", connected)
	if err != nil || len(applied.ChangedConnectorKeys) != 0 ||
		len(applied.PendingReceiptConnectorKeys) != 1 || applied.PendingReceiptConnectorKeys[0] != "tencent-docs" {
		t.Fatalf("same-revision apply = %#v, error = %v", applied, err)
	}
	accountOne, err := store.Operation(ctx, "authorization-account-1")
	if err != nil {
		t.Fatal(err)
	}
	if accountOne.Execution.AuthorizationSession == nil ||
		accountOne.Execution.AuthorizationSession.Resolution != market.AuthorizationSessionResolutionUnresolved {
		t.Fatalf("account one receipt = %#v", accountOne.Execution.AuthorizationSession)
	}
	unresolvedOne, err := store.UnresolvedAuthorizationSessionOperations(ctx, market.OperationScope{AccountID: "account-1"})
	if err != nil || len(unresolvedOne) != 1 {
		t.Fatalf("account one unresolved = %#v, error = %v", unresolvedOne, err)
	}
	unresolvedTwo, err := store.UnresolvedAuthorizationSessionOperations(ctx, market.OperationScope{AccountID: "account-2"})
	if err != nil || len(unresolvedTwo) != 1 || unresolvedTwo[0].Execution.AuthorizationSession == nil ||
		unresolvedTwo[0].Execution.AuthorizationSession.SessionID != "session-account-2" {
		t.Fatalf("account two unresolved = %#v, error = %v", unresolvedTwo, err)
	}
}

func TestStoreOperationLeaseFencesOtherWorkersAndExpires(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	operation := market.Operation{
		OperationID: "operation-1", ClientRequestID: "request-1", ConnectorKey: "github",
		Kind: market.OperationKindInstall, State: market.OperationStateAccepted,
		Stage: market.OperationStageAccepted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(10, 0).UTC()
	if _, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-a", now, now.Add(time.Minute)); err != nil || !claimed {
		t.Fatalf("first claim: claimed=%v err=%v", claimed, err)
	}
	if _, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-b", now, now.Add(time.Minute)); err != nil || claimed {
		t.Fatalf("fenced claim: claimed=%v err=%v", claimed, err)
	}
	if _, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-b", now.Add(2*time.Minute), now.Add(3*time.Minute)); err != nil || !claimed {
		t.Fatalf("expired claim: claimed=%v err=%v", claimed, err)
	}
}

func TestStoreOperationLeaseTokenFencesStaleRenewSaveAndRelease(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	operation := market.Operation{OperationID: "operation-1", ClientRequestID: "request-1", ConnectorKey: "github",
		Kind: market.OperationKindInstall, State: market.OperationStateAccepted, Stage: market.OperationStageAccepted,
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC()}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(10, 0).UTC()
	first, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-a", now, now.Add(time.Minute))
	if err != nil || !claimed {
		t.Fatalf("first claim = %#v, %v, %v", first, claimed, err)
	}
	secondNow := now.Add(2 * time.Minute)
	second, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-b", secondNow, secondNow.Add(time.Minute))
	if err != nil || !claimed || second.LeaseToken <= first.LeaseToken {
		t.Fatalf("second claim = %#v, %v, %v", second, claimed, err)
	}
	if err := store.RenewOperationLease(ctx, operation.OperationID, "worker-a", first.LeaseToken, secondNow, secondNow.Add(time.Minute)); !errors.Is(err, market.ErrOperationLeaseLost) {
		t.Fatalf("stale renew error = %v", err)
	}
	first.State = market.OperationStateCompleted
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(first) }); !errors.Is(err, market.ErrOperationLeaseLost) {
		t.Fatalf("stale save error = %v", err)
	}
	if err := store.ReleaseOperationLease(ctx, operation.OperationID, "worker-a", first.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := store.ClaimOperation(ctx, operation.OperationID, "worker-c", secondNow, secondNow.Add(time.Minute)); err != nil || claimed {
		t.Fatalf("stale release cleared current lease: claimed=%v err=%v", claimed, err)
	}
}

func TestStoreOperationLeaseHasSingleWinnerAcrossConnections(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	firstStore, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer firstStore.Close()
	secondStore, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer secondStore.Close()
	operation := market.Operation{
		OperationID: "operation-1", ClientRequestID: "request-1", ConnectorKey: "github",
		Kind: market.OperationKindInstall, State: market.OperationStateAccepted,
		Stage: market.OperationStageAccepted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	if err := firstStore.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
		t.Fatal(err)
	}

	type claimResult struct {
		claimed bool
		err     error
	}
	start := make(chan struct{})
	results := make(chan claimResult, 2)
	var workers sync.WaitGroup
	for index, store := range []*Store{firstStore, secondStore} {
		workers.Add(1)
		go func(workerIndex int, workerStore *Store) {
			defer workers.Done()
			<-start
			now := time.Unix(10, 0).UTC()
			_, claimed, claimErr := workerStore.ClaimOperation(
				ctx, operation.OperationID, fmt.Sprintf("worker-%d", workerIndex), now, now.Add(time.Minute),
			)
			results <- claimResult{claimed: claimed, err: claimErr}
		}(index, store)
	}
	close(start)
	workers.Wait()
	close(results)

	winners := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.claimed {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("lease winners = %d, want 1", winners)
	}
}

func testConnector() market.Connector {
	release := market.Release{
		SchemaVersion: "1", ReleaseID: "42", ConnectorKey: "github", Version: "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: market.Manifest{
			IconURL:       "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
			SchemaVersion: "1",
			DisplayName:   "GitHub",
			Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64"}, MCP: &market.ManagedMCPInterface{Entrypoint: "bin/github.js"}}},
			AuthorizationKind: "none",
		},
		Artifact: market.Artifact{
			Key:       "connectors/github/1.0.0.zip",
			SHA256:    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			SizeBytes: 123, MediaType: "application/vnd.tutti.connector+zip",
		},
		PublishedAt: time.Unix(1, 0).UTC(), Status: market.ReleaseStatusAvailable,
	}
	return market.Connector{
		Key: "github", Release: release,
		Installation:  market.Installation{State: market.InstallationStateNotInstalled},
		Authorization: market.Authorization{State: market.AuthorizationStateNotRequired},
		Compatibility: market.Compatibility{State: market.CompatibilityStateSupported},
	}
}
