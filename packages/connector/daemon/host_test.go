package daemon

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	marketdata "github.com/tutti-os/tutti/packages/connector/store-sqlite"
)

type activationGateDelegate struct {
	reconciles        int
	reconcileFailures int
	deactivations     int
	failClosed        int
	lastReconcile     market.RuntimeReconcileRequest
}

func (delegate *activationGateDelegate) Reconcile(_ context.Context, request market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	delegate.reconciles++
	delegate.lastReconcile = request
	if delegate.reconcileFailures > 0 {
		delegate.reconcileFailures--
		return market.RuntimeReceipt{}, errors.New("simulated runtime reconcile failure")
	}
	return market.RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation}, nil
}

type runtimeBindingResolverFunc func(context.Context, market.RuntimeBindingRequest) (market.RuntimeBinding, error)

func (resolve runtimeBindingResolverFunc) ResolveRuntimeBinding(ctx context.Context, request market.RuntimeBindingRequest) (market.RuntimeBinding, error) {
	return resolve(ctx, request)
}
func (delegate *activationGateDelegate) DeactivateRuntime(context.Context, market.RuntimeDeactivationRequest) error {
	delegate.deactivations++
	return nil
}
func (delegate *activationGateDelegate) FailClosed(context.Context, time.Time) error {
	delegate.failClosed++
	return nil
}

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
	release    market.Release
	refreshes  int
	refreshErr error
}

func (*countingCatalogSource) ListCategories(context.Context) ([]market.CatalogCategory, error) {
	return nil, nil
}

func (*countingCatalogSource) ListPage(context.Context, market.CatalogSourcePageQuery) (market.CatalogSourcePage, error) {
	return market.CatalogSourcePage{}, nil
}

func (source *countingCatalogSource) Refresh(context.Context) (market.CatalogSnapshot, error) {
	source.refreshes++
	if source.refreshErr != nil {
		return market.CatalogSnapshot{}, source.refreshErr
	}
	return market.CatalogSnapshot{SourceRevision: "source-1", Releases: []market.Release{source.release}}, nil
}

type discardChangedEventPublisher struct{}

func (discardChangedEventPublisher) PublishConnectorMarketChanged(context.Context, market.ChangedEvent) error {
	return nil
}

type recordingPublicationController struct {
	values []bool
}

func (controller *recordingPublicationController) ApplyCapabilityPublication(_ context.Context, _ market.OperationScope, enabled bool) error {
	controller.values = append(controller.values, enabled)
	return nil
}

func TestBootstrapRestoresInstalledRuntimeWithoutRefreshingCatalog(t *testing.T) {
	ctx := context.Background()
	store, err := marketdata.Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	release := hostTestRelease()
	// Presentation policy may evolve after installation. Runtime recovery must
	// not depend on the currently accepted icon shape.
	release.Manifest.IconURL = "https://legacy.example/icon.svg"
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
	cleanup, err := store.CleanupLifecycle(ctx, market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: time.Now().UTC(),
		PublishedEventsPublishedThrough:  time.Now().UTC(),
		BatchSize:                        10,
	})
	if err != nil || cleanup.TerminalOperationsDeleted != 1 {
		t.Fatalf("pre-restart lifecycle cleanup = %#v, error = %v", cleanup, err)
	}
	if _, err := store.Operation(ctx, operation.OperationID); !errors.Is(err, market.ErrNotFound) {
		t.Fatalf("terminal operation survived cleanup: %v", err)
	}

	source := &countingCatalogSource{release: release, refreshErr: errors.New("catalog returned 403")}
	runtime := &activationGateDelegate{reconcileFailures: 1}
	publication := &recordingPublicationController{}
	bindings := runtimeBindingResolverFunc(func(_ context.Context, request market.RuntimeBindingRequest) (market.RuntimeBinding, error) {
		connectionID := "device-github"
		if request.Scope.AccountID != "" {
			connectionID = "account-" + request.Scope.AccountID
		}
		return market.RuntimeBinding{ConnectionID: connectionID, Enabled: true}, nil
	})
	host, err := NewHost(ctx, HostConfig{
		Repository:             store,
		CatalogSource:          source,
		ArtifactPreparer:       unavailableArtifactPreparer{},
		ImplementationHost:     runtime,
		RuntimeBindings:        bindings,
		Authorization:          unavailableAuthorization{},
		Compatibility:          rejectingCompatibility{},
		ImplementationRegistry: market.NewImplementationRegistry(nil),
		Outbox:                 store,
		Lifecycle:              store,
		Publisher:              discardChangedEventPublisher{},
		Publication:            publication,
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
	if source.refreshes != 0 || runtime.reconciles != 2 {
		t.Fatalf("bootstrap refreshes=%d reconciles=%d, want 0 and 2", source.refreshes, runtime.reconciles)
	}
	if err := host.BootstrapForScope(ctx, market.OperationScope{AccountID: "account-1"}); err != nil {
		t.Fatalf("account bootstrap failed: %v", err)
	}
	if runtime.reconciles != 3 || runtime.lastReconcile.ConnectionID != "account-account-1" {
		t.Fatalf("account reconcile = %#v, count = %d", runtime.lastReconcile, runtime.reconciles)
	}
	if err := host.BootstrapForScope(ctx, market.OperationScope{AccountID: "account-1"}); err != nil {
		t.Fatalf("idempotent account bootstrap failed: %v", err)
	}
	if runtime.reconciles != 3 {
		t.Fatalf("unchanged account scope reconciled %d times", runtime.reconciles)
	}
	if len(publication.values) == 0 || !publication.values[len(publication.values)-1] {
		t.Fatalf("publication transitions = %#v, want final open", publication.values)
	}

	if err := host.refreshAndWait(ctx); err == nil || !strings.Contains(err.Error(), "refresh failed") {
		t.Fatalf("refresh error = %v, want catalog failure", err)
	}
	if source.refreshes != 1 || runtime.reconciles != 3 {
		t.Fatalf("refreshes=%d reconciles=%d, want catalog retry isolated from runtime", source.refreshes, runtime.reconciles)
	}

	accountScope := market.OperationScope{AccountID: "account-1"}
	if err := host.FenceForScope(ctx, accountScope); err != nil {
		t.Fatalf("account fence failed: %v", err)
	}
	if len(publication.values) == 0 || publication.values[len(publication.values)-1] || runtime.failClosed == 0 {
		t.Fatalf("fence publication=%#v failClosed=%d", publication.values, runtime.failClosed)
	}
	if err := host.BootstrapForScope(ctx, accountScope); err != nil {
		t.Fatalf("same-account bootstrap after fence failed: %v", err)
	}
	if runtime.reconciles != 4 || !publication.values[len(publication.values)-1] {
		t.Fatalf("same-account recovery reconciles=%d publication=%#v", runtime.reconciles, publication.values)
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
