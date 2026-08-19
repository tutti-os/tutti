package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestStoreCleanupLifecycleHonorsCutoffsBatchesAndProtectedRows(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	cutoff := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	operations := []market.Operation{
		lifecycleTestOperation("completed-before", "connector-completed", market.OperationStateCompleted, cutoff.Add(-time.Millisecond)),
		lifecycleTestOperation("failed-at", "connector-failed", market.OperationStateFailed, cutoff),
		lifecycleTestOperation("completed-after", "connector-newer", market.OperationStateCompleted, cutoff.Add(time.Millisecond)),
		lifecycleTestOperation("accepted-old", "connector-accepted", market.OperationStateAccepted, cutoff.Add(-time.Hour)),
		lifecycleTestOperation("running-old", "connector-running", market.OperationStateRunning, cutoff.Add(-time.Hour)),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		for index, operation := range operations {
			if err := tx.SaveOperation(operation); err != nil {
				return err
			}
			if err := tx.EnqueueConnectorMarketChanged(market.ChangedEvent{OperationID: operation.OperationID, Revision: uint64(index + 1)}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for sequence, publishedAt := range map[int64]time.Time{
		1: cutoff.Add(-time.Millisecond),
		2: cutoff,
		3: cutoff.Add(time.Millisecond),
		5: cutoff.Add(2 * time.Millisecond),
	} {
		if err := store.MarkChangedEventPublished(ctx, sequence, publishedAt); err != nil {
			t.Fatal(err)
		}
	}

	request := market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: cutoff,
		PublishedEventsPublishedThrough:  cutoff,
		BatchSize:                        1,
	}
	first, err := store.CleanupLifecycle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CleanupLifecycle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	third, err := store.CleanupLifecycle(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if first.TerminalOperationsDeleted != 1 || first.PublishedEventsDeleted != 1 ||
		second.TerminalOperationsDeleted != 1 || second.PublishedEventsDeleted != 1 ||
		third.TerminalOperationsDeleted != 0 || third.PublishedEventsDeleted != 0 {
		t.Fatalf("cleanup results = %#v, %#v, %#v", first, second, third)
	}
	for _, operationID := range []string{"completed-before", "failed-at"} {
		if _, err := store.Operation(ctx, operationID); !errors.Is(err, market.ErrNotFound) {
			t.Fatalf("operation %q error = %v, want not found", operationID, err)
		}
	}
	for _, operationID := range []string{"completed-after", "accepted-old", "running-old"} {
		if _, err := store.Operation(ctx, operationID); err != nil {
			t.Fatalf("protected operation %q error = %v", operationID, err)
		}
	}
	reusedRequest := lifecycleTestOperation("accepted-reused-request", "connector-reused-request", market.OperationStateAccepted, cutoff.Add(time.Minute))
	reusedRequest.ClientRequestID = operations[0].ClientRequestID
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveOperation(reusedRequest)
	}); err != nil {
		t.Fatalf("reuse expired client request ID: %v", err)
	}
	pending, err := store.PendingChangedEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Sequence != 4 {
		t.Fatalf("pending events = %#v, want only sequence 4", pending)
	}
	var publishedRows int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM connector_market_outbox WHERE published_at_unix_ms IS NOT NULL`).Scan(&publishedRows); err != nil {
		t.Fatal(err)
	}
	if publishedRows != 2 {
		t.Fatalf("published outbox rows = %d, want 2 protected newer rows", publishedRows)
	}
	if _, err := store.CleanupLifecycle(ctx, market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: cutoff,
		PublishedEventsPublishedThrough:  cutoff,
		BatchSize:                        maxLifecycleCleanupBatchSize + 1,
	}); err == nil {
		t.Fatal("oversized lifecycle cleanup batch was accepted")
	}
}

func TestStoreCleanupLifecycleIsSafeAcrossConnections(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	first, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	cutoff := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	if err := first.Transaction(ctx, func(tx market.Transaction) error {
		for index := range 20 {
			operation := lifecycleTestOperation(
				fmt.Sprintf("terminal-%02d", index),
				fmt.Sprintf("connector-%02d", index),
				market.OperationStateCompleted,
				cutoff.Add(-time.Hour),
			)
			if err := tx.SaveOperation(operation); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	request := market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: cutoff,
		PublishedEventsPublishedThrough:  cutoff,
		BatchSize:                        7,
	}
	start := make(chan struct{})
	results := make(chan market.LifecycleCleanupResult, 2)
	errorsFound := make(chan error, 2)
	var wait sync.WaitGroup
	for _, candidate := range []*Store{first, second} {
		wait.Add(1)
		go func(store *Store) {
			defer wait.Done()
			<-start
			result, cleanupErr := store.CleanupLifecycle(ctx, request)
			if cleanupErr != nil {
				errorsFound <- cleanupErr
				return
			}
			results <- result
		}(candidate)
	}
	close(start)
	wait.Wait()
	close(results)
	close(errorsFound)
	for cleanupErr := range errorsFound {
		t.Fatal(cleanupErr)
	}
	var deleted int64
	for result := range results {
		if result.TerminalOperationsDeleted > int64(request.BatchSize) {
			t.Fatalf("one cleanup deleted %d operations, batch size %d", result.TerminalOperationsDeleted, request.BatchSize)
		}
		deleted += result.TerminalOperationsDeleted
	}
	if deleted != 14 {
		t.Fatalf("concurrent cleanup deleted %d operations, want 14", deleted)
	}
	var remaining int
	if err := first.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM connector_market_operations`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 6 {
		t.Fatalf("remaining operations = %d, want 6", remaining)
	}
}

func TestStoreCleanupPreservesRecoverableWorkAcrossReopen(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	operation := lifecycleTestOperation(
		"accepted-restart",
		"connector-restart",
		market.OperationStateAccepted,
		time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC),
	)
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(market.ChangedEvent{
			ConnectorKey: operation.ConnectorKey,
			OperationID:  operation.OperationID,
			Revision:     1,
		})
	}); err != nil {
		t.Fatal(err)
	}
	cutoff := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	if _, err := store.CleanupLifecycle(ctx, market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: cutoff,
		PublishedEventsPublishedThrough:  cutoff,
		BatchSize:                        10,
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
	recoverable, err := reopened.RecoverableOperations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recoverable) != 1 || recoverable[0].OperationID != operation.OperationID {
		t.Fatalf("recoverable operations = %#v", recoverable)
	}
	pending, err := reopened.PendingChangedEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Event.OperationID != "" || pending[0].Event.ConnectorKey != operation.ConnectorKey {
		t.Fatalf("pending events = %#v", pending)
	}
}

func TestStoreInstalledReleaseEvidenceSurvivesTerminalCleanupAndReopen(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	release := testConnector().Release
	connector := testConnector()
	connector.Installation = market.Installation{
		State:                  market.InstallationStateInstalled,
		InstalledVersion:       release.Version,
		InstalledReleaseID:     release.ReleaseID,
		InstalledReleaseDigest: release.ReleaseDigest,
	}
	completedAt := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	operation := lifecycleTestOperation("install-evidence", connector.Key, market.OperationStateCompleted, completedAt)
	operation.Kind = market.OperationKindInstall
	operation.Target = &market.OperationTarget{
		ConnectorKey: connector.Key, Version: release.Version, ReleaseID: release.ReleaseID,
		ReleaseDigest: release.ReleaseDigest, ArtifactSHA256: release.Artifact.SHA256, Release: &release,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.SaveOperation(operation)
	}); err != nil {
		t.Fatal(err)
	}
	connector.Release.Version = "2.0.0"
	connector.Release.ReleaseID = "43"
	connector.Release.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	connector.Release.ManifestDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		return tx.SaveConnector(connector)
	}); err != nil {
		t.Fatal(err)
	}
	result, err := store.CleanupLifecycle(ctx, market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: completedAt,
		PublishedEventsPublishedThrough:  completedAt,
		BatchSize:                        10,
	})
	if err != nil || result.TerminalOperationsDeleted != 1 {
		t.Fatalf("cleanup result = %#v, error = %v", result, err)
	}
	if _, err := store.Operation(ctx, operation.OperationID); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("cleaned operation error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := reopened.InstalledRelease(ctx, connector.Key, release.ReleaseDigest)
	if err != nil || got.ReleaseDigest != release.ReleaseDigest || got.ManifestDigest != release.ManifestDigest {
		t.Fatalf("installed release = %#v, error = %v", got, err)
	}
}

func TestStoreCompletedLocalUninstallDeletesReleaseEvidenceButKeepsAuthorizationProjection(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	release := testConnector().Release
	connector := testConnector()
	connector.Installation = market.Installation{State: market.InstallationStateInstalled,
		InstalledVersion: release.Version, InstalledReleaseID: release.ReleaseID, InstalledReleaseDigest: release.ReleaseDigest}
	installedAt := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	install := lifecycleTestOperation("install-before-local-uninstall", connector.Key, market.OperationStateCompleted, installedAt)
	install.Kind = market.OperationKindInstall
	install.Target = &market.OperationTarget{ConnectorKey: connector.Key, Version: release.Version, ReleaseID: release.ReleaseID,
		ReleaseDigest: release.ReleaseDigest, ArtifactSHA256: release.Artifact.SHA256, Release: &release}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.SaveOperation(install)
	}); err != nil {
		t.Fatal(err)
	}
	projection := market.AuthorizationProjection{AccountID: "account-1", ConnectorKey: connector.Key,
		ConnectionID: "connection-1", State: market.AuthorizationStateConnected, ServerRevision: 8,
		ServerSynchronized: true, UpdatedAt: installedAt}
	if err := store.SaveAuthorizationProjection(ctx, projection); err != nil {
		t.Fatal(err)
	}
	uninstall := lifecycleTestOperation("local-uninstall", connector.Key, market.OperationStateCompleted, installedAt.Add(time.Minute))
	uninstall.Kind = market.OperationKindUninstall
	uninstall.Target = &market.OperationTarget{ConnectorKey: connector.Key, Version: release.Version,
		ReleaseID: release.ReleaseID, ReleaseDigest: release.ReleaseDigest}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Installation = market.Installation{State: market.InstallationStateNotInstalled}
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.SaveOperation(uninstall)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InstalledRelease(ctx, connector.Key, release.ReleaseDigest); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("installed release error = %v, want not found", err)
	}
	storedProjection, err := store.AuthorizationProjection(ctx, projection.AccountID, projection.ConnectorKey)
	if err != nil || storedProjection != projection {
		t.Fatalf("authorization projection = %#v, error = %v", storedProjection, err)
	}
}

func TestStoreRetainsCurrentAndPreparedCandidateReleaseEvidence(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	connector := testConnector()
	current := connector.Release
	connector.Installation = market.Installation{
		State: market.InstallationStateUpdating, InstalledVersion: current.Version,
		InstalledReleaseID: current.ReleaseID, InstalledReleaseDigest: current.ReleaseDigest,
	}
	candidate := current
	candidate.Version = "2.0.0"
	candidate.ReleaseID = connector.Key + "@2.0.0"
	candidate.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	candidate.ManifestDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	installedAt := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	currentOperation := lifecycleTestOperation("current-release", connector.Key, market.OperationStateCompleted, installedAt)
	currentOperation.Kind = market.OperationKindInstall
	currentOperation.Target = &market.OperationTarget{
		ConnectorKey: connector.Key, Version: current.Version, ReleaseID: current.ReleaseID,
		ReleaseDigest: current.ReleaseDigest, ArtifactSHA256: current.Artifact.SHA256, Release: &current,
	}
	candidateOperation := lifecycleTestOperation("candidate-release", connector.Key, market.OperationStateRunning, installedAt.Add(time.Minute))
	candidateOperation.Kind = market.OperationKindInstall
	candidateOperation.Stage = market.OperationStageRuntimePending
	candidateOperation.Target = &market.OperationTarget{
		ConnectorKey: connector.Key, Version: candidate.Version, ReleaseID: candidate.ReleaseID,
		ReleaseDigest: candidate.ReleaseDigest, ArtifactSHA256: candidate.Artifact.SHA256, Release: &candidate,
	}
	candidateOperation.Execution.ReleaseInstallation = &market.ReleaseInstallationReceipt{
		OperationID: candidateOperation.OperationID, ConnectorKey: connector.Key,
		Version: candidate.Version, ReleaseID: candidate.ReleaseID, ReleaseDigest: candidate.ReleaseDigest,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(currentOperation); err != nil {
			return err
		}
		return tx.SaveOperation(candidateOperation)
	}); err != nil {
		t.Fatal(err)
	}
	var currentDigest string
	if err := store.db.QueryRowContext(ctx, `SELECT release_digest FROM connector_market_installed_releases
WHERE connector_key = ?`, connector.Key).Scan(&currentDigest); err != nil {
		t.Fatal(err)
	}
	if currentDigest != current.ReleaseDigest {
		t.Fatalf("current release pointer = %q, want %q", currentDigest, current.ReleaseDigest)
	}

	for name, expected := range map[string]market.Release{"current": current, "candidate": candidate} {
		got, err := store.InstalledRelease(ctx, connector.Key, expected.ReleaseDigest)
		if err != nil || got.ReleaseDigest != expected.ReleaseDigest || got.ManifestDigest != expected.ManifestDigest {
			t.Fatalf("%s release = %#v, error = %v", name, got, err)
		}
	}

	candidateOperation.State = market.OperationStateCompleted
	candidateOperation.Stage = market.OperationStageCompleted
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveOperation(candidateOperation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT release_digest FROM connector_market_installed_releases
WHERE connector_key = ?`, connector.Key).Scan(&currentDigest); err != nil {
		t.Fatal(err)
	}
	if currentDigest != candidate.ReleaseDigest {
		t.Fatalf("promoted release pointer = %q, want %q", currentDigest, candidate.ReleaseDigest)
	}
}

func TestStoreMigrationBackfillsLifecycleTimestampAndInstalledReleaseEvidence(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	legacy, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE connector_market_connectors (connector_key TEXT PRIMARY KEY, connector_json TEXT NOT NULL)`,
		`CREATE TABLE connector_market_installed_releases (
  connector_key TEXT PRIMARY KEY,
  release_digest TEXT NOT NULL,
  release_json TEXT NOT NULL
)`,
		`CREATE TABLE connector_market_operations (
  operation_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  connector_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_unix_ms INTEGER,
  operation_json TEXT NOT NULL
)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			_ = legacy.Close()
			t.Fatal(err)
		}
	}
	installedRelease := testConnector().Release
	connector := testConnector()
	connector.Installation = market.Installation{
		State:                  market.InstallationStateInstalled,
		InstalledVersion:       installedRelease.Version,
		InstalledReleaseID:     installedRelease.ReleaseID,
		InstalledReleaseDigest: installedRelease.ReleaseDigest,
	}
	connector.Release.Version = "2.0.0"
	connector.Release.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	operation := lifecycleTestOperation(
		"legacy-install",
		connector.Key,
		market.OperationStateCompleted,
		time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC),
	)
	operation.Kind = market.OperationKindInstall
	operation.Target = &market.OperationTarget{
		ConnectorKey: connector.Key, Version: installedRelease.Version, ReleaseID: installedRelease.ReleaseID,
		ReleaseDigest: installedRelease.ReleaseDigest, ArtifactSHA256: installedRelease.Artifact.SHA256, Release: &installedRelease,
	}
	connectorPayload, err := json.Marshal(connector)
	if err != nil {
		t.Fatal(err)
	}
	operationPayload, err := json.Marshal(operation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO connector_market_connectors (connector_key, connector_json) VALUES (?, ?)`,
		connector.Key, string(connectorPayload)); err != nil {
		t.Fatal(err)
	}
	installedReleasePayload, err := json.Marshal(installedRelease)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO connector_market_installed_releases
(connector_key, release_digest, release_json) VALUES (?, ?, ?)`, connector.Key, installedRelease.ReleaseDigest,
		string(installedReleasePayload)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO connector_market_operations (
operation_id, client_request_id, connector_key, kind, state, lease_owner, lease_token, lease_expires_at_unix_ms, operation_json
) VALUES (?, ?, ?, ?, ?, '', 0, NULL, ?)`, operation.OperationID, operation.ClientRequestID, operation.ConnectorKey,
		operation.Kind, operation.State, string(operationPayload)); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var updatedAtMS int64
	if err := store.db.QueryRowContext(ctx, `SELECT updated_at_unix_ms FROM connector_market_operations WHERE operation_id = ?`, operation.OperationID).Scan(&updatedAtMS); err != nil {
		t.Fatal(err)
	}
	if updatedAtMS != operation.UpdatedAt.UnixMilli() {
		t.Fatalf("migrated updated timestamp = %d, want %d", updatedAtMS, operation.UpdatedAt.UnixMilli())
	}
	release, err := store.InstalledRelease(ctx, connector.Key, installedRelease.ReleaseDigest)
	if err != nil || release.ReleaseDigest != installedRelease.ReleaseDigest {
		t.Fatalf("migrated installed release = %#v, error = %v", release, err)
	}
	var historicalCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM connector_market_release_installations
WHERE connector_key = ? AND release_digest = ?`, connector.Key, installedRelease.ReleaseDigest).Scan(&historicalCount); err != nil {
		t.Fatal(err)
	}
	if historicalCount != 1 {
		t.Fatalf("migrated release installation evidence count = %d, want 1", historicalCount)
	}
}

func TestStoreReopenToleratesMissingLegacyInstalledReleaseEvidence(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	connector := testConnector()
	installedRelease := connector.Release
	connector.Installation = market.Installation{
		State: market.InstallationStateInstalled, InstalledVersion: installedRelease.Version,
		InstalledReleaseID: installedRelease.ReleaseID, InstalledReleaseDigest: installedRelease.ReleaseDigest,
	}
	connector.Release.Version = "2.0.0"
	connector.Release.ReleaseID = connector.Key + "@2.0.0"
	connector.Release.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	connector.Release.ManifestDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		return tx.SaveConnector(connector)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatalf("reopen with missing legacy evidence: %v", err)
	}
	defer reopened.Close()
	if _, err := reopened.Connector(ctx, connector.Key); err != nil {
		t.Fatalf("load connector after compatible reopen: %v", err)
	}
	if _, err := reopened.InstalledRelease(ctx, connector.Key, installedRelease.ReleaseDigest); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("missing release evidence error = %v, want not found", err)
	}
}

func lifecycleTestOperation(operationID, connectorKey string, state market.OperationState, updatedAt time.Time) market.Operation {
	return market.Operation{
		OperationID: operationID, ClientRequestID: "request-" + operationID, ConnectorKey: connectorKey,
		Kind: market.OperationKindRefreshCatalog, State: state, Stage: market.OperationStageCompleted,
		CreatedAt: updatedAt.Add(-time.Minute), UpdatedAt: updatedAt,
	}
}
