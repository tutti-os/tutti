package connectormarket

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

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
		if _, err := tx.SetWorkspaceBinding(connector.Key, market.WorkspaceBinding{WorkspaceID: "workspace-1", Enabled: true}); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(market.ChangedEvent{
			ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision,
		})
	}); err != nil {
		t.Fatal(err)
	}

	snapshot, err := store.Snapshot(ctx, "workspace-1")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 1 || len(snapshot.Connectors) != 1 || len(snapshot.Operations) != 1 ||
		snapshot.Connectors[0].WorkspaceBinding == nil || !snapshot.Connectors[0].WorkspaceBinding.Enabled {
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
