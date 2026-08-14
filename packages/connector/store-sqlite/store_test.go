package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
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

func TestStoreRejectsLegacyConnectorTables(t *testing.T) {
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

	if _, err := Open(ctx, databasePath); err == nil || !strings.Contains(err.Error(), "legacy connector market SQLite is unsupported") {
		t.Fatalf("Open(legacy) error = %v", err)
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

	snapshot, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 1 || len(snapshot.Connectors) != 1 || len(snapshot.Operations) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	entries, err := store.PendingChangedEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Event.Revision != 1 {
		t.Fatalf("outbox = %#v", entries)
	}
}

func TestStoreAtomicallyReplacesFullCatalogSnapshot(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "connector-control-plane-v2.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	release := testConnector().Release
	snapshot := market.CatalogSnapshot{
		CatalogRevision: 9, SnapshotDigest: "sha256:" + strings.Repeat("d", 64), SourceRevision: "9:sha256:" + strings.Repeat("d", 64),
		Categories: []market.CatalogCategory{{CategoryID: "development", Kind: "category", ItemCount: 1}},
		Entries:    []market.CatalogEntry{{CategoryID: "development", Release: release}},
		Releases:   []market.Release{release},
		Revocations: []market.CatalogRevocation{{ArtifactDigest: "sha256:" + strings.Repeat("e", 64), RevocationID: "revoke-1",
			ConnectorKey: "old", Version: "0.9.0", ReasonCode: "malware", EffectiveAt: time.Unix(2, 0).UTC()}},
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		if err := tx.SaveCatalogSnapshot(snapshot); err != nil {
			return err
		}
		return tx.SaveCatalogRevision(snapshot.SourceRevision)
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := store.CatalogSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stored.CatalogRevision != 9 || stored.SnapshotDigest != snapshot.SnapshotDigest || len(stored.Entries) != 1 || len(stored.Revocations) != 1 {
		t.Fatalf("catalog snapshot = %#v", stored)
	}
}

func TestStoreResourceClaimsSerializeOnlyConflictingPhysicalWork(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "connector-control-plane-v2.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	connectorKey := "github"
	executionScope := market.OperationScope{DeviceID: "device-1", AccountID: "account-1"}
	install := market.Operation{
		OperationID: "install-1", ClientRequestID: "request-install-1", ConnectorKey: connectorKey,
		Kind: market.OperationKindInstall, Scope: executionScope, State: market.OperationStateAccepted,
		Stage: market.OperationStageAccepted, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(install) }); err != nil {
		t.Fatalf("save install claim: %v", err)
	}
	authorization := market.Operation{
		OperationID: "authorize-1", ClientRequestID: "request-authorize-1", ConnectorKey: connectorKey,
		Kind: market.OperationKindStartAuthorization, Scope: executionScope, State: market.OperationStateAccepted,
		Stage: market.OperationStageAccepted, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(authorization) }); err != nil {
		t.Fatalf("authorization should not conflict with execution: %v", err)
	}
	runtimeReconcile := market.Operation{
		OperationID: "runtime-1", ClientRequestID: "request-runtime-1", ConnectorKey: connectorKey,
		Kind: market.OperationKindReconcileRuntime, Scope: executionScope, State: market.OperationStateAccepted,
		Stage: market.OperationStageAccepted, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(runtimeReconcile) }); err == nil {
		t.Fatal("runtime reconcile acquired the execution claim while install was active")
	}
	install.State = market.OperationStateOutcomeUnknown
	install.UpdatedAt = now.Add(time.Second)
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(install) }); err != nil {
		t.Fatalf("persist outcome_unknown: %v", err)
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		active, err := tx.ActiveOperation(market.OperationKindReconcileRuntime, executionScope, connectorKey)
		if err != nil {
			return err
		}
		if active == nil || active.OperationID != install.OperationID {
			return fmt.Errorf("execution claim owner = %#v", active)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	install.State = market.OperationStateFailed
	install.Stage = market.OperationStageFailed
	install.UpdatedAt = now.Add(2 * time.Second)
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(install) }); err != nil {
		t.Fatalf("finish install: %v", err)
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(runtimeReconcile) }); err != nil {
		t.Fatalf("runtime reconcile did not acquire released execution claim: %v", err)
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
		Stage: market.OperationStageCompleted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
		Execution: market.OperationExecution{AuthorizationSession: &market.AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key,
			SessionID: "session-1", ActionType: "redirect", AuthorizationURL: "https://example.test/authorize",
			State: market.AuthorizationStatePending,
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
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	snapshot, err := reopened.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].Execution.AuthorizationSession != nil {
		t.Fatalf("public snapshot exposed authorization session: %#v", snapshot.Operations)
	}
	operations, err := reopened.UnresolvedAuthorizationSessionOperations(ctx, market.OperationScope{})
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 1 || operations[0].Execution.AuthorizationSession == nil ||
		operations[0].Execution.AuthorizationSession.SessionID != "session-1" {
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
			IconURL:       "data:image/png;base64,iVBORw0KGgo=",
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
