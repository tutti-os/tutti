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
	reconciles              int
	reconcileFailures       int
	installationInspections int
	installationState       market.ReleaseInstallationObservationState
	deactivations           int
	failClosed              int
	lastReconcile           market.RuntimeReconcileRequest
}

func (delegate *activationGateDelegate) InspectReleaseInstallation(
	_ context.Context,
	request market.InspectReleaseInstallationRequest,
) (market.ReleaseInstallationObservation, error) {
	delegate.installationInspections++
	state := delegate.installationState
	if state == "" {
		state = market.ReleaseInstallationPresent
	}
	return market.ReleaseInstallationObservation{State: state, ConnectorKey: request.Release.ConnectorKey,
		ReleaseDigest: request.Release.ReleaseDigest}, nil
}

func (*activationGateDelegate) InstallRelease(context.Context, market.InstallReleaseRequest) (market.ReleaseInstallationReceipt, error) {
	return market.ReleaseInstallationReceipt{}, errors.New("not implemented")
}
func (*activationGateDelegate) CommitReleaseInstallation(context.Context, market.CommitReleaseInstallationRequest) error {
	return nil
}
func (*activationGateDelegate) UninstallRelease(context.Context, market.UninstallReleaseRequest) error {
	return nil
}

func (delegate *activationGateDelegate) Reconcile(_ context.Context, request market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	delegate.reconciles++
	delegate.lastReconcile = request
	if delegate.reconcileFailures > 0 {
		delegate.reconcileFailures--
		return market.RuntimeReceipt{}, errors.New("simulated runtime reconcile failure")
	}
	return market.RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation,
		Readiness: market.RuntimeReadiness{State: market.RuntimeReadinessReady,
			Interfaces: []market.InterfaceReadiness{{Kind: "mcp", State: market.RuntimeReadinessReady}}},
		Summary: &market.ConnectorSummary{Key: request.Connector.Key, Name: request.Connector.Key,
			Interfaces: []market.ConnectorInterfaceSummary{{Kind: "mcp", ServerName: "connector", Status: string(market.RuntimeReadinessReady)}}}}, nil
}

type runtimeBindingResolverFunc func(context.Context, market.RuntimeBindingRequest) (market.RuntimeBinding, error)

func (resolve runtimeBindingResolverFunc) ResolveRuntimeBinding(ctx context.Context, request market.RuntimeBindingRequest) (market.RuntimeBinding, error) {
	return resolve(ctx, request)
}

type connectedAuthorizationObserver struct{}

func (connectedAuthorizationObserver) Begin(context.Context, market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	return market.AuthorizationSession{}, errors.New("not implemented")
}

func (connectedAuthorizationObserver) Disconnect(context.Context, market.AuthorizationDisconnectRequest) error {
	return errors.New("not implemented")
}

func (connectedAuthorizationObserver) Observe(_ context.Context, request market.AuthorizationObserveRequest) (market.AuthorizationObservation, error) {
	return market.AuthorizationObservation{
		AccountID: request.Scope.AccountID, ConnectorKey: request.Connector.Key,
		ConnectionID: "connection-1", State: market.AuthorizationObservationConnected,
	}, nil
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
	gate.setOpen(market.OperationScope{}, true)
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

func TestActivationGateRejectsInactiveAccountScope(t *testing.T) {
	delegate := &activationGateDelegate{}
	gate := newActivationGateHost(delegate)
	activeScope := market.OperationScope{AccountID: "account-new"}
	gate.setOpen(activeScope, true)
	request := market.RuntimeReconcileRequest{OperationID: "late-old-account", Scope: market.OperationScope{AccountID: "account-old"},
		ConnectionID: "connection-old", Enabled: true, Connector: market.Connector{Key: "tencent-docs"}}
	if _, err := gate.Reconcile(context.Background(), request); err == nil {
		t.Fatal("inactive account runtime request was accepted")
	}
	if delegate.reconciles != 0 {
		t.Fatalf("inactive account delegated reconciles = %d", delegate.reconciles)
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
		ReleaseInstallations:   runtime,
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

	if err := host.Bootstrap(ctx); err != nil {
		t.Fatalf("partial bootstrap failed: %v", err)
	}
	if len(host.runtimeRecoveryPending) != 1 || len(publication.values) == 0 || !publication.values[len(publication.values)-1] {
		t.Fatalf("partial bootstrap pending=%#v publication=%#v", host.runtimeRecoveryPending, publication.values)
	}
	if err := host.Bootstrap(ctx); err != nil {
		t.Fatalf("degraded runtime recovery failed: %v", err)
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
	accountScope := market.OperationScope{AccountID: "account-1"}
	if err := host.ReconcileRuntimeForScope(ctx, accountScope, connector.Key); err != nil {
		t.Fatalf("observed runtime repair failed: %v", err)
	}
	if runtime.reconciles != 4 {
		t.Fatalf("observed runtime repair reconciles = %d, want 4", runtime.reconciles)
	}
	if len(publication.values) == 0 || !publication.values[len(publication.values)-1] {
		t.Fatalf("publication transitions = %#v, want final open", publication.values)
	}

	if err := host.refreshAndWait(ctx); err == nil || !strings.Contains(err.Error(), "refresh failed") {
		t.Fatalf("refresh error = %v, want catalog failure", err)
	}
	if source.refreshes != 1 || runtime.reconciles != 4 {
		t.Fatalf("refreshes=%d reconciles=%d, want catalog retry isolated from runtime", source.refreshes, runtime.reconciles)
	}

	if err := host.FenceForScope(ctx, accountScope); err != nil {
		t.Fatalf("account fence failed: %v", err)
	}
	if len(publication.values) == 0 || publication.values[len(publication.values)-1] || runtime.failClosed == 0 {
		t.Fatalf("fence publication=%#v failClosed=%d", publication.values, runtime.failClosed)
	}
	if err := host.ReconcileRuntimeForScope(ctx, accountScope, connector.Key); err != nil {
		t.Fatalf("closed-gate runtime repair failed: %v", err)
	}
	if runtime.reconciles != 4 {
		t.Fatalf("closed-gate runtime repair reconciles = %d, want 4", runtime.reconciles)
	}
	if err := host.BootstrapForScope(ctx, accountScope); err != nil {
		t.Fatalf("same-account bootstrap after fence failed: %v", err)
	}
	if runtime.reconciles != 5 || !publication.values[len(publication.values)-1] {
		t.Fatalf("same-account recovery reconciles=%d publication=%#v", runtime.reconciles, publication.values)
	}
	if runtime.installationInspections != 3 {
		t.Fatalf("installation inspections = %d, want one per full bootstrap", runtime.installationInspections)
	}

	if err := host.FenceForScope(ctx, accountScope); err != nil {
		t.Fatal(err)
	}
	runtime.installationState = market.ReleaseInstallationAbsent
	if err := host.BootstrapForScope(ctx, accountScope); err != nil {
		t.Fatalf("bootstrap with explicitly absent installation failed: %v", err)
	}
	calibrated, err := store.Connector(ctx, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if calibrated.Installation.State != market.InstallationStateFailed ||
		calibrated.Installation.FailureCode != market.InstallationFailureCodePhysicallyAbsent || runtime.reconciles != 5 {
		t.Fatalf("calibrated connector=%#v reconciles=%d", calibrated, runtime.reconciles)
	}
}

func TestAuthorizationRecoverySchedulesOneRuntimeBeforeResolvingReceipt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	store, err := marketdata.Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	release := hostTestRelease()
	release.Manifest.AuthorizationKind = "oauth2"
	release.Manifest.RequiredCapabilities = []string{"tools"}
	release.Manifest.Implementation.ManagedStdio.Runtime.VersionRange = ">=22.0.0 <23.0.0"
	release.Manifest.Implementation.ManagedStdio.CLI = &market.ManagedCLIInterface{
		Entrypoint: "bin/github-cli.mjs", TimeoutMS: 120_000,
	}
	release.Manifest.Implementation.ManagedStdio.CredentialBroker = &market.ManagedCredentialBroker{
		Protocol: market.CredentialBrokerProtocolV1, Entrypoint: "authorization/broker.mjs",
		TimeoutMS: 30_000, AllowedHosts: []string{"api.example.test"},
	}
	connector := market.Connector{
		Key: release.ConnectorKey, Release: release,
		Installation: market.Installation{
			State: market.InstallationStateInstalled, InstalledVersion: release.Version,
			InstalledReleaseID: release.ReleaseID, InstalledReleaseDigest: release.ReleaseDigest,
		},
		Authorization: market.Authorization{State: market.AuthorizationStatePending},
		Compatibility: market.Compatibility{State: market.CompatibilityStateSupported},
	}
	authorizationOperation := market.Operation{
		OperationID: "authorization-1", ClientRequestID: "authorization-request-1", ConnectorKey: connector.Key,
		Kind: market.OperationKindStartAuthorization, Scope: market.OperationScope{AccountID: "account-1"},
		State: market.OperationStateCompleted, Stage: market.OperationStageCompleted,
		Target: &market.OperationTarget{
			ConnectorKey: release.ConnectorKey, Version: release.Version, ReleaseID: release.ReleaseID,
			ReleaseDigest: release.ReleaseDigest, Release: &release,
		},
		Execution: market.OperationExecution{AuthorizationSession: &market.AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key, SessionID: "session-1",
			State: market.AuthorizationStatePending, Resolution: market.AuthorizationSessionResolutionUnresolved,
		}},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		connector.Revision = tx.AdvanceRevision()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.SaveOperation(authorizationOperation)
	}); err != nil {
		t.Fatal(err)
	}

	runtime := &activationGateDelegate{}
	scope := market.OperationScope{AccountID: "account-1"}
	scheduler := NewOperationScheduler(ctx)
	activationGate := newActivationGateHost(runtime)
	activationGate.setOpen(scope, true)
	application, err := market.NewApplication(market.ApplicationConfig{
		Repository: store, CatalogSource: &countingCatalogSource{release: release},
		ReleaseInstallations: runtime, Host: activationGate,
		Authorization: connectedAuthorizationObserver{}, AuthorizationProjections: store,
		RuntimeBindings: runtimeBindingResolverFunc(func(_ context.Context, request market.RuntimeBindingRequest) (market.RuntimeBinding, error) {
			return market.RuntimeBinding{ConnectionID: "device-" + request.Connector.Key, Enabled: true}, nil
		}),
		Compatibility: rejectingCompatibility{}, Scheduler: scheduler,
		ImplementationRegistry: market.NewImplementationRegistry(nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Bind(application); err != nil {
		t.Fatal(err)
	}
	host := &Host{Application: application, scheduler: scheduler, repository: store, activationGate: activationGate}

	host.bootstrapMu.Lock()
	err = host.reconcileAuthorizationsLocked(ctx, scope)
	host.bootstrapMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 1 {
		t.Fatalf("runtime reconciles = %d, want 1", runtime.reconciles)
	}
	operation, err := store.Operation(ctx, authorizationOperation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.Execution.AuthorizationSession == nil ||
		operation.Execution.AuthorizationSession.Resolution != market.AuthorizationSessionResolutionProviderConnected {
		t.Fatalf("authorization receipt = %#v", operation.Execution.AuthorizationSession)
	}
	if err := host.ObserveAuthorizationForScope(ctx, scope, market.AuthorizationProjection{
		AccountID: scope.AccountID, ConnectorKey: connector.Key,
		ConnectionID: "connection-2", State: market.AuthorizationStateConnected,
	}); err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 2 {
		t.Fatalf("runtime reconciles after live observation = %d, want 2", runtime.reconciles)
	}
	projection, err := store.AuthorizationProjection(ctx, scope.AccountID, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if projection.ConnectionID != "connection-2" || projection.State != market.AuthorizationStateConnected {
		t.Fatalf("live authorization projection = %#v", projection)
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
			Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{
					Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node22-darwin-arm64"},
					MCP:     &market.ManagedMCPInterface{Entrypoint: "bin/github.mjs"},
				}},
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
