package daemon

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	marketdata "github.com/tutti-os/tutti/packages/connector/daemon/adapters/sqlite"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestRuntimeConvergenceWorkerAppliesDurableDesiredState(t *testing.T) {
	ctx := context.Background()
	store, err := marketdata.Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	release := hostTestRelease()
	connector := market.Connector{
		Key: release.ConnectorKey, Release: release,
		Installation: market.Installation{
			State: market.InstallationStateInstalled, InstalledVersion: release.Version,
			InstalledReleaseID: release.ReleaseID, InstalledReleaseDigest: release.ReleaseDigest,
		},
		Authorization: market.Authorization{State: market.AuthorizationStateNotRequired},
		Compatibility: market.Compatibility{State: market.CompatibilityStateSupported},
	}
	now := time.Date(2026, 8, 15, 4, 0, 0, 0, time.UTC)
	install := market.Operation{
		OperationID: "install-1", ClientRequestID: "install-request-1", ConnectorKey: connector.Key,
		Kind: market.OperationKindInstall, State: market.OperationStateCompleted, Stage: market.OperationStageCompleted,
		Target: &market.OperationTarget{
			ConnectorKey: connector.Key, Version: release.Version, ReleaseID: release.ReleaseID,
			ReleaseDigest: release.ReleaseDigest, Release: &release,
		},
		CreatedAt: now, UpdatedAt: now,
	}
	desired := market.RuntimeConvergence{
		Desired: market.RuntimeDesired{
			ConnectorKey: connector.Key, Generation: 1, Enabled: true,
			ConnectionID: "device-github", ReleaseDigest: release.ReleaseDigest,
			AuthorizationState: market.AuthorizationStateNotRequired, UpdatedAt: now,
		},
		NextAttemptAt: now,
		UpdatedAt:     now,
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(install); err != nil {
			return err
		}
		return tx.SaveRuntimeConvergence(desired)
	}); err != nil {
		t.Fatal(err)
	}

	runtime := &activationGateDelegate{}
	gate := newActivationGateHost(runtime)
	gate.setOpen(market.OperationScope{}, true)
	scheduler := NewOperationScheduler(ctx)
	application, err := market.NewApplication(market.ApplicationConfig{
		Repository: store, CatalogSource: &countingCatalogSource{release: release},
		ReleaseInstallations: runtime, Host: gate, Authorization: unavailableAuthorization{},
		RuntimeBindings: runtimeBindingResolverFunc(func(context.Context, market.RuntimeBindingRequest) (market.RuntimeBinding, error) {
			return market.RuntimeBinding{
				ConnectionID: "device-github", Enabled: true, AuthorizationState: market.AuthorizationStateNotRequired,
			}, nil
		}),
		Compatibility: rejectingCompatibility{}, Scheduler: scheduler,
		ImplementationRegistry: market.NewImplementationRegistry(nil),
		Now:                    func() time.Time { return now },
		BootEpoch:              "boot-1",
		WorkerID:               "worker-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Bind(application); err != nil {
		t.Fatal(err)
	}
	host := &Host{Application: application, bootstrapped: true,
		runtimeRecoveryPending: map[string]struct{}{connector.Key: {}}}
	if err := host.convergeDueRuntimes(ctx); err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 0 {
		t.Fatalf("runtime converged before post-fence planning completed: %d", runtime.reconciles)
	}
	delete(host.runtimeRecoveryPending, connector.Key)
	if err := host.convergeDueRuntimes(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := store.RuntimeConvergence(ctx, market.OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 1 || stored.Observed.DesiredGeneration != 1 ||
		stored.Observed.BootEpoch != "boot-1" || stored.Observed.Readiness.State != market.RuntimeReadinessReady {
		t.Fatalf("runtime reconciles = %d, convergence = %#v", runtime.reconciles, stored)
	}
}
