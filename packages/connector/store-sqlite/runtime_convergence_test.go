package storesqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestRuntimeConvergencePersistsAndReconcilesPerBootEpoch(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)
	scope := market.OperationScope{AccountID: "account-1"}
	desired := runtimeConvergenceFixture(scope, "github", 1, now)
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveRuntimeConvergence(desired)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	due, err := store.DueRuntimeConvergences(ctx, scope, "boot-1", now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].Desired.Generation != 1 {
		t.Fatalf("due convergence = %#v", due)
	}
	claimed, ok, err := store.ClaimRuntimeConvergence(
		ctx, scope, "github", "boot-1", "worker-1", now, now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || claimed.LeaseToken == 0 {
		t.Fatalf("claimed convergence = %#v, claimed = %v", claimed, ok)
	}
	observed := market.RuntimeObserved{
		DesiredGeneration: 1,
		BootEpoch:         "boot-1",
		Enabled:           true,
		ConnectionID:      desired.Desired.ConnectionID,
		ReleaseDigest:     desired.Desired.ReleaseDigest,
		Readiness:         market.RuntimeReadiness{State: market.RuntimeReadinessReady},
		ObservedAt:        now.Add(time.Second),
	}
	if err := store.CompleteRuntimeConvergence(
		ctx, scope, "github", "worker-1", claimed.LeaseToken, 1, observed, now.Add(time.Second),
	); err != nil {
		t.Fatal(err)
	}
	due, err = store.DueRuntimeConvergences(ctx, scope, "boot-1", now.Add(2*time.Second), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("same-boot convergence remained due: %#v", due)
	}
	due, err = store.DueRuntimeConvergences(ctx, scope, "boot-2", now.Add(2*time.Second), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 {
		t.Fatalf("new boot due convergence = %#v", due)
	}
}

func TestRuntimeConvergenceRejectsStaleGenerationCompletion(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 15, 3, 0, 0, 0, time.UTC)
	scope := market.OperationScope{AccountID: "account-1"}
	first := runtimeConvergenceFixture(scope, "github", 1, now)
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveRuntimeConvergence(first)
	}); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.ClaimRuntimeConvergence(
		ctx, scope, "github", "boot-1", "worker-1", now, now.Add(time.Minute),
	)
	if err != nil || !ok {
		t.Fatalf("claim = %#v, %v, %v", claimed, ok, err)
	}
	second := first
	second.Desired.Generation = 2
	second.Desired.Enabled = false
	second.Desired.UpdatedAt = now.Add(time.Second)
	second.NextAttemptAt = now.Add(time.Second)
	second.LeaseOwner = ""
	second.LeaseToken = claimed.LeaseToken + 1
	second.LeaseExpiresAt = nil
	second.UpdatedAt = now.Add(time.Second)
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveRuntimeConvergence(second)
	}); err != nil {
		t.Fatal(err)
	}
	err = store.CompleteRuntimeConvergence(ctx, scope, "github", "worker-1", claimed.LeaseToken, 1,
		market.RuntimeObserved{DesiredGeneration: 1, BootEpoch: "boot-1"}, now.Add(2*time.Second))
	if !errors.Is(err, market.ErrOperationLeaseLost) {
		t.Fatalf("stale completion error = %v", err)
	}
	stored, err := store.RuntimeConvergence(ctx, scope, "github")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Desired.Generation != 2 || stored.Observed.DesiredGeneration != 0 {
		t.Fatalf("stored convergence = %#v", stored)
	}
}

func TestRuntimeConvergenceLeaseCannotBeReenteredBySameWorker(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 15, 4, 0, 0, 0, time.UTC)
	scope := market.OperationScope{AccountID: "account-1"}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveRuntimeConvergence(runtimeConvergenceFixture(scope, "github", 1, now))
	}); err != nil {
		t.Fatal(err)
	}
	first, claimed, err := store.ClaimRuntimeConvergence(
		ctx, scope, "github", "boot-1", "worker-1", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("first claim = %#v, %v, %v", first, claimed, err)
	}
	second, claimed, err := store.ClaimRuntimeConvergence(
		ctx, scope, "github", "boot-1", "worker-1", now.Add(time.Second), now.Add(time.Minute),
	)
	if err != nil || claimed {
		t.Fatalf("reentrant claim = %#v, %v, %v", second, claimed, err)
	}
	if second.LeaseToken != first.LeaseToken || second.LeaseOwner != first.LeaseOwner {
		t.Fatalf("lease changed after rejected reentry: first=%#v second=%#v", first, second)
	}
}

func TestSnapshotHidesLegacyRuntimeReconcileOperations(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 15, 5, 0, 0, 0, time.UTC)
	operation := market.Operation{
		OperationID: "runtime-legacy", ClientRequestID: "runtime-legacy", ConnectorKey: "github",
		Kind: market.OperationKindReconcileRuntime, State: market.OperationStateCompleted,
		Stage: market.OperationStageCompleted, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error { return tx.SaveOperation(operation) }); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Operations) != 0 {
		t.Fatalf("public snapshot leaked private operations: %#v", snapshot.Operations)
	}
	if _, err := store.Operation(ctx, operation.OperationID); err != nil {
		t.Fatalf("legacy recovery record was deleted: %v", err)
	}
}

func runtimeConvergenceFixture(
	scope market.OperationScope,
	connectorKey string,
	generation uint64,
	now time.Time,
) market.RuntimeConvergence {
	return market.RuntimeConvergence{
		Desired: market.RuntimeDesired{
			Scope: scope, ConnectorKey: connectorKey, Generation: generation, Enabled: true,
			ConnectionID: "account-connection", ReleaseDigest: "sha256:release", AuthorizationState: market.AuthorizationStateConnected,
			UpdatedAt: now,
		},
		NextAttemptAt: now,
		UpdatedAt:     now,
	}
}
