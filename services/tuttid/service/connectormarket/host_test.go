package connectormarket

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
	marketdata "github.com/tutti-os/tutti/services/tuttid/data/connectormarket"
)

type activationGateDelegate struct {
	reconciles        int
	reconcileFailures int
	deactivations     int
}

func (delegate *activationGateDelegate) Reconcile(_ context.Context, request market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	delegate.reconciles++
	if delegate.reconcileFailures > 0 {
		delegate.reconcileFailures--
		return market.RuntimeReceipt{}, errors.New("simulated runtime reconcile failure")
	}
	return market.RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation}, nil
}
func (delegate *activationGateDelegate) DeactivateRuntime(context.Context, market.RuntimeDeactivationRequest) error {
	delegate.deactivations++
	return nil
}
func (*activationGateDelegate) FailClosed(context.Context, time.Time) error { return nil }

func TestActivationGateStagesRecoveryUntilInitialCatalogRefresh(t *testing.T) {
	delegate := &activationGateDelegate{}
	gate := newActivationGateHost(delegate)
	request := market.RuntimeReconcileRequest{OperationID: "recover-1", ConnectionID: "workspace-1", Enabled: true,
		Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 7}, Connector: market.Connector{Key: "github",
			Release: market.Release{ReleaseDigest: "release-1"}}}
	receipt, err := gate.Reconcile(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if delegate.reconciles != 0 || receipt.Generation != request.Generation {
		t.Fatalf("closed gate delegated recovery: reconciles=%d receipt=%#v", delegate.reconciles, receipt)
	}
	gate.setOpen(true)
	if _, err := gate.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if delegate.reconciles != 1 {
		t.Fatalf("open gate reconciles = %d, want 1", delegate.reconciles)
	}
}

func TestActivationGateNeverStagesWorkspaceDeactivation(t *testing.T) {
	delegate := &activationGateDelegate{}
	gate := newActivationGateHost(delegate)
	if err := gate.DeactivateRuntime(context.Background(), market.RuntimeDeactivationRequest{ConnectionID: "workspace-1", ConnectorKey: "github"}); err != nil {
		t.Fatal(err)
	}
	if delegate.deactivations != 1 {
		t.Fatalf("deactivations = %d, want 1", delegate.deactivations)
	}
}

type countingCatalogSource struct {
	release   market.Release
	refreshes int
}

func (*countingCatalogSource) ListCategories(context.Context) ([]market.CatalogCategory, error) {
	return nil, nil
}

func (*countingCatalogSource) ListPage(context.Context, market.CatalogSourcePageQuery) (market.CatalogSourcePage, error) {
	return market.CatalogSourcePage{}, nil
}

func (source *countingCatalogSource) Refresh(context.Context) (market.CatalogSnapshot, error) {
	source.refreshes++
	return market.CatalogSnapshot{SourceRevision: "source-1", Releases: []market.Release{source.release}}, nil
}

type discardChangedEventPublisher struct{}

func (discardChangedEventPublisher) PublishConnectorMarketChanged(context.Context, market.ChangedEvent) error {
	return nil
}

func TestBootstrapAndScheduledRetryReuseAcceptedCatalogAfterReconcileFailure(t *testing.T) {
	ctx := context.Background()
	store, err := marketdata.Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	release := hostTestRelease()
	connector := market.Connector{
		Key:     release.ConnectorKey,
		Release: release,
		Installation: market.Installation{
			State:                  market.InstallationStateInstalled,
			InstalledVersion:       release.Version,
			InstalledReleaseID:     release.ReleaseID,
			InstalledReleaseDigest: release.ReleaseDigest,
		},
		Authorization: market.Authorization{State: market.AuthorizationStateNotRequired},
		Compatibility: market.Compatibility{State: market.CompatibilityStateSupported},
	}
	installedRelease := release
	operation := market.Operation{
		OperationID:     "install-1",
		ClientRequestID: "install-request-1",
		ConnectorKey:    connector.Key,
		Kind:            market.OperationKindInstall,
		State:           market.OperationStateCompleted,
		Stage:           market.OperationStageCompleted,
		Target: &market.OperationTarget{
			ConnectorKey:   release.ConnectorKey,
			Version:        release.Version,
			ReleaseID:      release.ReleaseID,
			ReleaseDigest:  release.ReleaseDigest,
			ArtifactSHA256: release.Artifact.SHA256,
			Release:        &installedRelease,
		},
		CreatedAt: time.Unix(1, 0).UTC(),
		UpdatedAt: time.Unix(1, 0).UTC(),
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

	source := &countingCatalogSource{release: release}
	runtime := &activationGateDelegate{reconcileFailures: 1}
	host, err := NewHost(ctx, HostConfig{
		Repository:             store,
		CatalogSource:          source,
		ArtifactPreparer:       unavailableArtifactPreparer{},
		ImplementationHost:     runtime,
		Authorization:          unavailableAuthorization{},
		Compatibility:          rejectingCompatibility{},
		ImplementationRegistry: market.NewImplementationRegistry(nil),
		Outbox:                 store,
		Publisher:              discardChangedEventPublisher{},
	})
	if err != nil {
		t.Fatal(err)
	}
	host.refreshWorkerStarted = true
	t.Cleanup(host.Close)

	if err := host.Bootstrap(ctx); err == nil {
		t.Fatal("first bootstrap unexpectedly reconciled the runtime")
	}
	if err := host.Bootstrap(ctx); err != nil {
		t.Fatalf("second bootstrap failed: %v", err)
	}
	if source.refreshes != 1 || runtime.reconciles != 2 {
		t.Fatalf("bootstrap refreshes=%d reconciles=%d, want 1 and 2", source.refreshes, runtime.reconciles)
	}

	runtime.reconcileFailures = 1
	catalogAccepted := false
	catalogAccepted, err = host.refreshAndReconcileInstalled(ctx, catalogAccepted)
	if err == nil || !catalogAccepted {
		t.Fatalf("scheduled first retry accepted=%v error=%v, want accepted catalog and reconcile error", catalogAccepted, err)
	}
	catalogAccepted, err = host.refreshAndReconcileInstalled(ctx, catalogAccepted)
	if err != nil || catalogAccepted {
		t.Fatalf("scheduled second retry accepted=%v error=%v, want completed cycle", catalogAccepted, err)
	}
	if source.refreshes != 2 || runtime.reconciles != 4 {
		t.Fatalf("total refreshes=%d reconciles=%d, want 2 and 4", source.refreshes, runtime.reconciles)
	}
}

func hostTestRelease() market.Release {
	return market.Release{
		SchemaVersion:  "1",
		ReleaseID:      "github@1.0.0",
		ConnectorKey:   "github",
		Version:        "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: market.Manifest{
			SchemaVersion:     "1",
			DisplayName:       "GitHub",
			IconURL:           "data:image/png;base64,iVBORw0KGgo=",
			AuthorizationKind: "none",
			Implementation: market.Implementation{
				Kind:    market.ImplementationKindBuiltin,
				Builtin: &market.BuiltinImplementation{ProviderID: "github", MCP: true},
			},
		},
		Artifact: market.Artifact{
			Key:       "connectors/github/1.0.0.tgz",
			SHA256:    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			SizeBytes: 1024,
			MediaType: "application/vnd.tutti.connector+tar+gzip",
		},
		PublishedAt: time.Unix(1, 0).UTC(),
		Status:      market.ReleaseStatusAvailable,
	}
}
