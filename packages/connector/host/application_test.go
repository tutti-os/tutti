package host

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestApplicationInstallIsDurableAndIdempotent(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	command := ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	}

	accepted, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Connector == nil || accepted.Connector.Installation.State != InstallationStateInstalling {
		t.Fatalf("connector = %#v", accepted.Connector)
	}
	if accepted.Operation.State != OperationStateAccepted || accepted.Revision != 1 {
		t.Fatalf("result = %#v", accepted)
	}
	retried, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Operation.OperationID != accepted.Operation.OperationID {
		t.Fatalf("retry operation = %q, want %q", retried.Operation.OperationID, accepted.Operation.OperationID)
	}
	if repository.revision != 1 {
		t.Fatalf("revision = %d, want 1", repository.revision)
	}
	if len(scheduler.operationIDs) != 2 {
		t.Fatalf("scheduled operations = %#v", scheduler.operationIDs)
	}
}

func TestApplicationExecutesAcceptedInstall(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	installationHost := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, scheduler, installationHost, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	installed, err := repository.Connector(context.Background(), "github")
	if err != nil {
		t.Fatal(err)
	}
	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Installation.State != InstallationStateInstalled || installed.Installation.InstalledVersion != "1.0.0" {
		t.Fatalf("installation = %#v", installed.Installation)
	}
	if operation.State != OperationStateCompleted || installationHost.prepares != 1 || installationHost.activations != 0 {
		t.Fatalf("operation = %#v, prepares = %d, activations = %d", operation, installationHost.prepares, installationHost.activations)
	}
}

func TestApplicationExecutesTypedCLIInstallationBeforeCompletion(t *testing.T) {
	connector := testConnector("lark")
	connector.Release.Manifest.SchemaVersion = "1"
	connector.Release.Manifest.Implementation.ManagedStdio.MCP = nil
	connector.Release.Manifest.Implementation.ManagedStdio.Runtime.VersionRange = ">=22.0.0 <23.0.0"
	connector.Release.Manifest.Implementation.ManagedStdio.CLI = &ManagedCLIInterface{Entrypoint: "lark-cli", TimeoutMS: 120_000,
		Install: &CLIInstallation{Kind: "node_package", NodePackage: &NodePackageInstallation{Package: "@larksuite/cli",
			Version: "1.0.83", Integrity: "sha512-qbJYoJtNch6dV8RvYBO2wpcKO9+6Io3Cuf5alYFzvLbtkSntOKqoc+xHI7p6wRq4oH4F9fydgNJbTGy79ibPdg==",
			Launch: NodePackageLaunch{Kind: "native", Entrypoint: "bin/lark-cli", SHA256: strings.Repeat("c", 64)}}}}
	repository := newMemoryRepository(connector)
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{Mutation: Mutation{ClientRequestID: "install-lark"},
		ConnectorKey: "lark"})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if host.cliInstalls != 1 || operation.Execution.CLIInstallation == nil || operation.State != OperationStateCompleted {
		t.Fatalf("CLI installs = %d, operation = %#v", host.cliInstalls, operation)
	}
}

func TestApplicationReconcilesInstalledRuntimeAtStartup(t *testing.T) {
	connector := testConnector("github")
	connector.Revision = 7
	connector.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})

	if err := application.ReconcileInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if host.reconciles != 1 || host.lastReconcile.ConnectionID != defaultConnectorConnectionID ||
		host.lastReconcile.Generation.Generation != 7 || host.lastReconcile.Generation.BootEpoch == "" {
		t.Fatalf("startup reconcile = %#v, count=%d", host.lastReconcile, host.reconciles)
	}
}

func TestInstalledReleaseRemainsRunnableAfterCatalogAdvances(t *testing.T) {
	installedRelease := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	currentRelease := testReleaseWithImplementation("github", "2.0.0", ImplementationKindManagedStdio)
	currentRelease.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	currentRelease.ManifestDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	connector := testConnector("github")
	connector.Release = currentRelease
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: installedRelease.Version,
		InstalledReleaseID: installedRelease.ReleaseID, InstalledReleaseDigest: installedRelease.ReleaseDigest}
	repository := newMemoryRepository(connector)
	repository.operations["install-evidence"] = Operation{
		OperationID: "install-evidence", ClientRequestID: "install-request", ConnectorKey: connector.Key,
		Kind: OperationKindInstall, State: OperationStateCompleted, Stage: OperationStageCompleted,
		Target: &OperationTarget{ConnectorKey: connector.Key, Version: installedRelease.Version,
			ReleaseID: installedRelease.ReleaseID, ReleaseDigest: installedRelease.ReleaseDigest, Release: &installedRelease},
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})

	if err := application.ReconcileInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if host.reconciles != 1 || host.lastReconcile.Connector.Release.ReleaseDigest != installedRelease.ReleaseDigest {
		t.Fatalf("restart reconcile = %#v, count=%d", host.lastReconcile, host.reconciles)
	}
}

func TestInstallCompletionUsesFrozenReleaseAfterCatalogAdvances(t *testing.T) {
	installRelease := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	currentRelease := testReleaseWithImplementation("github", "2.0.0", ImplementationKindManagedStdio)
	currentRelease.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	currentRelease.ManifestDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	connector := testConnector("github")
	connector.Release = currentRelease
	connector.Installation = Installation{State: InstallationStateInstalling}
	repository := newMemoryRepository(connector)
	operation := Operation{
		OperationID: "install-1", ClientRequestID: "install-request", ConnectorKey: connector.Key,
		Kind: OperationKindInstall, State: OperationStateAccepted, Stage: OperationStageAccepted,
		Target: &OperationTarget{ConnectorKey: connector.Key, Version: installRelease.Version,
			ReleaseID: installRelease.ReleaseID, ReleaseDigest: installRelease.ReleaseDigest,
			ArtifactSHA256: installRelease.Artifact.SHA256, Release: &installRelease},
		HostGeneration: HostGeneration{BootEpoch: "boot-1", Generation: 1},
		CreatedAt:      time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	repository.operations[operation.OperationID] = operation
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})

	if err := application.ExecuteOperation(context.Background(), operation.OperationID); err != nil {
		t.Fatal(err)
	}
	stored := repository.connectors[connector.Key]
	if stored.Installation.InstalledReleaseDigest != installRelease.ReleaseDigest ||
		stored.Release.ReleaseDigest != currentRelease.ReleaseDigest {
		t.Fatalf("connector after frozen install = %#v", stored)
	}
}

func TestApplicationRecoveryObservesActivatedRuntimeBeforeCompleting(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	installationHost := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, installationHost, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	release := repository.connectors["github"].Release
	operation := repository.operations[accepted.Operation.OperationID]
	operation.State = OperationStateRunning
	operation.Stage = OperationStageActivating
	operation.Execution.PreparedArtifact = &PreparedArtifactReceipt{
		OperationID:    operation.OperationID,
		ConnectorKey:   release.ConnectorKey,
		Version:        release.Version,
		ReleaseDigest:  release.ReleaseDigest,
		ArtifactSHA256: release.Artifact.SHA256,
		PreparedPath:   "/prepared/" + release.ReleaseDigest,
	}
	repository.operations[operation.OperationID] = operation
	installationHost.activeDigest = release.ReleaseDigest

	if err := application.ExecuteOperation(context.Background(), operation.OperationID); err != nil {
		t.Fatal(err)
	}
	completed := repository.operations[operation.OperationID]
	if completed.State != OperationStateCompleted || installationHost.activations != 0 {
		t.Fatalf("operation = %#v, activations = %d", completed, installationHost.activations)
	}
	if repository.connectors["github"].Installation.InstalledReleaseDigest != release.ReleaseDigest {
		t.Fatalf("installation = %#v", repository.connectors["github"].Installation)
	}
}

func TestApplicationRecoveryAdoptsInstallAndUninstallIntoCurrentBootEpoch(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "request-1", ExpectedRevision: 0}, ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	install := repository.operations[accepted.Operation.OperationID]
	install.HostGeneration.BootEpoch = "previous-boot"
	repository.operations[install.OperationID] = install
	uninstall := install
	uninstall.OperationID = "recover-uninstall"
	uninstall.ClientRequestID = "request-2"
	uninstall.Kind = OperationKindUninstall
	repository.operations[uninstall.OperationID] = uninstall

	if err := application.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, operationID := range []string{install.OperationID, uninstall.OperationID} {
		operation := repository.operations[operationID]
		if operation.HostGeneration.BootEpoch == "previous-boot" || operation.HostGeneration.BootEpoch == "" {
			t.Fatalf("operation %s was not adopted: %#v", operationID, operation.HostGeneration)
		}
	}
	if len(scheduler.operationIDs) != 3 { // Install acceptance plus both recovery schedules.
		t.Fatalf("scheduled operations = %#v", scheduler.operationIDs)
	}
}

func TestApplicationWritesChangedEventsInsideRepositoryTransactions(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.events) != 1 || repository.events[0].OperationID != accepted.Operation.OperationID ||
		repository.events[0].Revision != accepted.Revision {
		t.Fatalf("events = %#v", repository.events)
	}
}

func TestApplicationDoesNotExecuteOperationHeldByAnotherWorker(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	installationHost := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, installationHost, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	operation := repository.operations[accepted.Operation.OperationID]
	expiresAt := time.Date(2026, 8, 3, 1, 0, 0, 0, time.UTC)
	operation.LeaseOwner = "other-worker"
	operation.LeaseExpiresAt = &expiresAt
	repository.operations[operation.OperationID] = operation

	if err := application.ExecuteOperation(context.Background(), operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if installationHost.prepares != 0 || installationHost.activations != 0 {
		t.Fatalf("prepares = %d, activations = %d", installationHost.prepares, installationHost.activations)
	}
}

func TestApplicationSingleFlightsConcurrentOperationExecution(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	installer := newBlockingInstaller()
	application := newTestApplication(t, repository, scheduler, installer, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case <-installer.started:
	case <-time.After(time.Second):
		t.Fatal("first operation did not reach installer")
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second execution returned before the first completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(installer.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first execution error = %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second execution error = %v", err)
	}
	if installs := installer.installs.Load(); installs != 1 {
		t.Fatalf("installer calls = %d, want 1", installs)
	}
}

func TestApplicationSharesConcurrentOperationFailureAndClearsFlight(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	cause := errors.New("installer unavailable")
	installer := newBlockingInstallerWithError(cause)
	application := newTestApplication(t, repository, scheduler, installer, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case <-installer.started:
	case <-time.After(time.Second):
		t.Fatal("first operation did not reach installer")
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second execution returned before the first completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(installer.release)
	firstErr := <-firstDone
	secondErr := <-secondDone
	for name, err := range map[string]error{"first": firstErr, "second": secondErr} {
		var domainError *DomainError
		if !errors.As(err, &domainError) || !errors.Is(err, cause) {
			t.Errorf("%s error = %#v, want install domain error caused by %v", name, err, cause)
		}
	}
	if installs := installer.installs.Load(); installs != 1 {
		t.Fatalf("installer calls = %d, want 1", installs)
	}

	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != OperationStateFailed {
		t.Fatalf("operation state = %q, want failed", operation.State)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatalf("terminal operation after flight cleanup = %v", err)
	}
}

func TestApplicationRejectsConcurrentConnectorOperation(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	if _, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "install-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := application.Uninstall(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "uninstall-1", ExpectedRevision: 1},
		ConnectorKey: "github",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeOperationInProgress {
		t.Fatalf("error = %#v", err)
	}
}

func TestApplicationRefreshRejectsUnknownImplementation(t *testing.T) {
	repository := newMemoryRepository()
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{
		SourceRevision: "catalog-2",
		Releases:       []Release{testReleaseWithImplementation("future-connector", "2.0.0", "future_runtime")},
	})
	accepted, err := application.RefreshCatalog(context.Background(), Mutation{
		ClientRequestID:  "refresh-1",
		ExpectedRevision: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err == nil {
		t.Fatal("ExecuteOperation() expected strict manifest rejection")
	}
}

func TestApplicationRejectsStaleRevisionBeforeMutation(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	repository.revision = 4
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	_, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 3},
		ConnectorKey: "github",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeRevisionConflict {
		t.Fatalf("error = %#v", err)
	}
	if len(repository.operations) != 0 {
		t.Fatalf("operations = %#v", repository.operations)
	}
}

func TestApplicationCatalogPageCachesNewConnectorForImmediateInstall(t *testing.T) {
	repository := newMemoryRepository()
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	source := catalogSourceStub{page: CatalogSourcePage{
		SectionID:     "development",
		Entries:       []CatalogEntry{{CategoryID: "development", Release: release}},
		NextPageToken: "next-page",
	}}
	application := newTestApplicationWithCatalogSource(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, source)

	page, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID: "development", PageSize: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Revision != 1 || page.NextPageToken != "next-page" || len(page.Items) != 1 || page.Items[0].Connector.Key != "github" {
		t.Fatalf("page = %#v", page)
	}
	if _, err := repository.Connector(context.Background(), "github"); err != nil {
		t.Fatalf("cached connector: %v", err)
	}

	repeated, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{SectionID: "development", PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Revision != 1 || repository.revision != 1 {
		t.Fatalf("repeated page revision = %d, repository revision = %d", repeated.Revision, repository.revision)
	}
}

func TestApplicationCatalogPagePreservesManifestErrors(t *testing.T) {
	repository := newMemoryRepository()
	sourceError := invalidManifest("permission scope is invalid", nil)
	application := newTestApplicationWithCatalogSource(
		t,
		repository,
		&memoryScheduler{},
		&memoryInstallRuntime{},
		failingCatalogSource{pageError: sourceError},
	)

	_, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID: "development", PageSize: 20,
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) {
		t.Fatalf("error = %v, want DomainError", err)
	}
	if domainError.Code != ErrorCodeInvalidManifest || domainError.Retryable {
		t.Fatalf("domain error = %#v", domainError)
	}
}

func TestApplicationCatalogPageClassifiesTransportErrorsAsRetryable(t *testing.T) {
	repository := newMemoryRepository()
	application := newTestApplicationWithCatalogSource(
		t,
		repository,
		&memoryScheduler{},
		&memoryInstallRuntime{},
		failingCatalogSource{pageError: errors.New("request timeout")},
	)

	_, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID: "development", PageSize: 20,
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) {
		t.Fatalf("error = %v, want DomainError", err)
	}
	if domainError.Code != ErrorCodeUpstreamUnavailable || !domainError.Retryable {
		t.Fatalf("domain error = %#v", domainError)
	}
}

func TestApplicationRefreshPreservesManifestFailureCode(t *testing.T) {
	repository := newMemoryRepository()
	application := newTestApplicationWithCatalogSource(
		t,
		repository,
		&memoryScheduler{},
		&memoryInstallRuntime{},
		failingCatalogSource{refreshError: invalidManifest("permission scope is invalid", nil)},
	)
	accepted, err := application.RefreshCatalog(context.Background(), Mutation{
		ClientRequestID: "refresh-invalid-manifest", ExpectedRevision: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeInvalidManifest {
		t.Fatalf("error = %#v, want invalid manifest", err)
	}
	operation, err := application.GetOperation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != OperationStateFailed || operation.FailureCode != string(ErrorCodeInvalidManifest) {
		t.Fatalf("operation = %#v", operation)
	}
}

func newTestApplication(
	t *testing.T,
	repository *memoryRepository,
	scheduler *memoryScheduler,
	installationHost interface {
		ArtifactPreparer
		CLIInstallationManager
		ImplementationHost
	},
	catalog CatalogSnapshot,
) *Application {
	return newTestApplicationWithCatalogSource(
		t,
		repository,
		scheduler,
		installationHost,
		catalogSourceFunc(func(context.Context) (CatalogSnapshot, error) { return catalog, nil }),
	)
}

func newTestApplicationWithCatalogSource(
	t *testing.T,
	repository *memoryRepository,
	scheduler *memoryScheduler,
	installationHost interface {
		ArtifactPreparer
		CLIInstallationManager
		ImplementationHost
	},
	catalogSource CatalogSource,
) *Application {
	t.Helper()
	nextID := 0
	application, err := NewApplication(ApplicationConfig{
		Repository:             repository,
		CatalogSource:          catalogSource,
		ArtifactPreparer:       installationHost,
		CLIInstallations:       installationHost,
		Host:                   installationHost,
		Authorization:          authorizationProviderStub{},
		Compatibility:          compatibilityEvaluatorStub{},
		Scheduler:              scheduler,
		ImplementationRegistry: NewImplementationRegistry(map[string]ImplementationValidator{ImplementationKindManagedStdio: nil}),
		Now:                    func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) },
		NewID: func() (string, error) {
			nextID++
			return fmt.Sprintf("operation-%d", nextID), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return application
}

func testConnector(key string) Connector {
	return Connector{
		Key:           key,
		Release:       testReleaseWithImplementation(key, "1.0.0", "mcp_stdio"),
		Installation:  Installation{State: InstallationStateNotInstalled},
		Authorization: Authorization{State: AuthorizationStateNotRequired},
		Compatibility: Compatibility{State: CompatibilityStateSupported},
	}
}

func testReleaseWithImplementation(key, version, implementationKind string) Release {
	implementation := Implementation{Kind: implementationKind, Builtin: &BuiltinImplementation{ProviderID: key, MCP: true}}
	if implementationKind == "mcp_stdio" || implementationKind == ImplementationKindManagedStdio {
		implementation = Implementation{Kind: ImplementationKindManagedStdio, ManagedStdio: &ManagedStdioImplementation{
			Runtime: RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64"},
			MCP:     &ManagedMCPInterface{Entrypoint: "bin/connector.js"},
		}}
	}
	return Release{
		SchemaVersion:  "1",
		ReleaseID:      key + "@" + version,
		ConnectorKey:   key,
		Version:        version,
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: Manifest{
			SchemaVersion:     "1",
			DisplayName:       key,
			IconURL:           testConnectorIconURL,
			Implementation:    implementation,
			AuthorizationKind: "none",
		},
		Artifact:    testArtifact(),
		PublishedAt: time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC),
		Status:      ReleaseStatusAvailable,
	}
}

type catalogSourceFunc func(context.Context) (CatalogSnapshot, error)

func (catalogSourceFunc) ListCategories(context.Context) ([]CatalogCategory, error) {
	return nil, nil
}

func (catalogSourceFunc) ListPage(context.Context, CatalogSourcePageQuery) (CatalogSourcePage, error) {
	return CatalogSourcePage{}, nil
}

func (source catalogSourceFunc) Refresh(ctx context.Context) (CatalogSnapshot, error) {
	return source(ctx)
}

type catalogSourceStub struct {
	categories []CatalogCategory
	page       CatalogSourcePage
	snapshot   CatalogSnapshot
}

type failingCatalogSource struct {
	categoriesError error
	pageError       error
	refreshError    error
}

func (source failingCatalogSource) ListCategories(context.Context) ([]CatalogCategory, error) {
	return nil, source.categoriesError
}

func (source failingCatalogSource) ListPage(context.Context, CatalogSourcePageQuery) (CatalogSourcePage, error) {
	return CatalogSourcePage{}, source.pageError
}

func (source failingCatalogSource) Refresh(context.Context) (CatalogSnapshot, error) {
	return CatalogSnapshot{}, source.refreshError
}

func (source catalogSourceStub) ListCategories(context.Context) ([]CatalogCategory, error) {
	return source.categories, nil
}

func (source catalogSourceStub) ListPage(context.Context, CatalogSourcePageQuery) (CatalogSourcePage, error) {
	return source.page, nil
}

func (source catalogSourceStub) Refresh(context.Context) (CatalogSnapshot, error) {
	return source.snapshot, nil
}

type memoryScheduler struct {
	operationIDs []string
}

func (scheduler *memoryScheduler) Schedule(_ context.Context, operationID string) error {
	scheduler.operationIDs = append(scheduler.operationIDs, operationID)
	return nil
}

type memoryInstallRuntime struct {
	prepares        int
	removes         int
	activations     int
	deactivations   int
	activeDigest    string
	reconciles      int
	lastReconcile   RuntimeReconcileRequest
	deactivationErr error
	failClosed      int
	cliInstalls     int
	cliRemoves      int
}

func (host *memoryInstallRuntime) Reconcile(_ context.Context, request RuntimeReconcileRequest) (RuntimeReceipt, error) {
	host.reconciles++
	host.lastReconcile = request
	return RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation}, nil
}

func (host *memoryInstallRuntime) DeactivateRuntime(context.Context, RuntimeDeactivationRequest) error {
	host.deactivations++
	if host.deactivationErr != nil {
		return host.deactivationErr
	}
	host.activeDigest = ""
	return nil
}

func (host *memoryInstallRuntime) FailClosed(context.Context, time.Time) error {
	host.failClosed++
	return nil
}

func (host *memoryInstallRuntime) Prepare(_ context.Context, request PrepareArtifactRequest) (PreparedArtifactReceipt, error) {
	host.prepares++
	return PreparedArtifactReceipt{
		OperationID:     request.OperationID,
		ConnectorKey:    request.Release.ConnectorKey,
		Version:         request.Release.Version,
		ReleaseDigest:   request.Release.ReleaseDigest,
		ArtifactSHA256:  request.Release.Artifact.SHA256,
		InventoryDigest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		PreparedPath:    "/prepared/" + request.Release.ReleaseDigest,
	}, nil
}

func (host *memoryInstallRuntime) Remove(context.Context, RemoveArtifactRequest) error {
	host.removes++
	return nil
}

func (host *memoryInstallRuntime) InstallCLI(_ context.Context, request InstallCLIRequest) (CLIInstallationReceipt, error) {
	host.cliInstalls++
	install := releaseCLIInstallation(request.Release)
	return CLIInstallationReceipt{SchemaVersion: "tutti.connector.cli-installation.v1", OperationID: request.OperationID,
		ConnectorKey: request.Release.ConnectorKey, ReleaseDigest: request.Release.ReleaseDigest,
		RuntimeProfile: "connector-node-static", RuntimeABI: request.Release.Manifest.Implementation.ManagedStdio.Runtime.ABI,
		NodeVersion: "22.22.3", NodeSHA256: "1111111111111111111111111111111111111111111111111111111111111111",
		Package: install.Package, PackageVersion: install.Version, PackageIntegrity: install.Integrity, LaunchKind: install.Launch.Kind,
		InstallRoot: "/installed/" + request.Release.ReleaseDigest, StoreRoot: "/store",
		Entrypoint:       "node_modules/@larksuite/cli/bin/lark-cli",
		EntrypointSHA256: "2222222222222222222222222222222222222222222222222222222222222222",
		EntrypointSize:   7, LockSHA256: "3333333333333333333333333333333333333333333333333333333333333333"}, nil
}

func (*memoryInstallRuntime) ResolveCLI(context.Context, Release) (CLIInstallationReceipt, error) {
	return CLIInstallationReceipt{}, nil
}

func (host *memoryInstallRuntime) RemoveCLI(context.Context, RemoveCLIRequest) error {
	host.cliRemoves++
	return nil
}

type blockingInstaller struct {
	memoryInstallRuntime
	started  chan struct{}
	release  chan struct{}
	once     sync.Once
	installs atomic.Int32
	err      error
}

func newBlockingInstaller() *blockingInstaller {
	return newBlockingInstallerWithError(nil)
}

func newBlockingInstallerWithError(err error) *blockingInstaller {
	return &blockingInstaller{
		started: make(chan struct{}),
		release: make(chan struct{}),
		err:     err,
	}
}

func (installer *blockingInstaller) Prepare(ctx context.Context, request PrepareArtifactRequest) (PreparedArtifactReceipt, error) {
	installer.installs.Add(1)
	installer.once.Do(func() { close(installer.started) })
	select {
	case <-installer.release:
		if installer.err != nil {
			return PreparedArtifactReceipt{}, installer.err
		}
		return PreparedArtifactReceipt{
			OperationID:     request.OperationID,
			ConnectorKey:    request.Release.ConnectorKey,
			Version:         request.Release.Version,
			ReleaseDigest:   request.Release.ReleaseDigest,
			ArtifactSHA256:  request.Release.Artifact.SHA256,
			InventoryDigest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			PreparedPath:    "/prepared/" + request.Release.ReleaseDigest,
		}, nil
	case <-ctx.Done():
		return PreparedArtifactReceipt{}, ctx.Err()
	}
}

type authorizationProviderStub struct{}

func (authorizationProviderStub) Begin(_ context.Context, request AuthorizationStartRequest) (AuthorizationSession, error) {
	return AuthorizationSession{
		OperationID:      request.OperationID,
		ConnectorKey:     request.Connector.Key,
		SessionID:        "session-1",
		AuthorizationURL: "https://example.test/authorize",
	}, nil
}

func (authorizationProviderStub) Disconnect(context.Context, AuthorizationDisconnectRequest) error {
	return nil
}

type compatibilityEvaluatorStub struct{}

func (compatibilityEvaluatorStub) Evaluate(Manifest) Compatibility {
	return Compatibility{State: CompatibilityStateSupported}
}

type memoryRepository struct {
	revision            uint64
	catalogState        CatalogState
	sourceRevision      string
	connectors          map[string]Connector
	operations          map[string]Operation
	events              []ChangedEvent
	transactionErr      error
	transactionCalls    int
	failTransactionCall int
	failTransactionErr  error
}

func newMemoryRepository(connectors ...Connector) *memoryRepository {
	repository := &memoryRepository{
		catalogState: CatalogStateStale,
		connectors:   map[string]Connector{},
		operations:   map[string]Operation{},
	}
	for _, connector := range connectors {
		repository.connectors[connector.Key] = connector
	}
	return repository
}

func (repository *memoryRepository) Snapshot(_ context.Context) (Snapshot, error) {
	connectors := make([]Connector, 0, len(repository.connectors))
	for _, connector := range repository.connectors {
		connectors = append(connectors, connector)
	}
	sort.Slice(connectors, func(left, right int) bool { return connectors[left].Key < connectors[right].Key })
	operations := make([]Operation, 0, len(repository.operations))
	for _, operation := range repository.operations {
		operations = append(operations, operation)
	}
	return Snapshot{
		CatalogState:   repository.catalogState,
		Connectors:     connectors,
		Operations:     operations,
		Revision:       repository.revision,
		SourceRevision: repository.sourceRevision,
	}, nil
}

func (repository *memoryRepository) Connector(_ context.Context, connectorKey string) (Connector, error) {
	connector, ok := repository.connectors[connectorKey]
	if !ok {
		return Connector{}, ErrNotFound
	}
	return connector, nil
}

func (repository *memoryRepository) Operation(_ context.Context, operationID string) (Operation, error) {
	operation, ok := repository.operations[operationID]
	if !ok {
		return Operation{}, ErrNotFound
	}
	return operation, nil
}

func (repository *memoryRepository) ClaimOperation(
	_ context.Context,
	operationID string,
	owner string,
	now time.Time,
	leaseExpiresAt time.Time,
) (Operation, bool, error) {
	operation, ok := repository.operations[operationID]
	if !ok {
		return Operation{}, false, ErrNotFound
	}
	if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
		return operation, false, nil
	}
	if operation.LeaseOwner != "" && operation.LeaseOwner != owner &&
		operation.LeaseExpiresAt != nil && operation.LeaseExpiresAt.After(now) {
		return operation, false, nil
	}
	expiresAt := leaseExpiresAt
	operation.LeaseOwner = owner
	operation.LeaseToken++
	operation.LeaseExpiresAt = &expiresAt
	repository.operations[operationID] = operation
	return operation, true, nil
}

func (repository *memoryRepository) RenewOperationLease(_ context.Context, operationID, owner string, token uint64, now, leaseExpiresAt time.Time) error {
	operation, ok := repository.operations[operationID]
	if !ok {
		return ErrNotFound
	}
	if operation.LeaseOwner != owner || operation.LeaseToken != token || operation.LeaseExpiresAt == nil || !operation.LeaseExpiresAt.After(now) {
		return ErrOperationLeaseLost
	}
	expiresAt := leaseExpiresAt
	operation.LeaseExpiresAt = &expiresAt
	repository.operations[operationID] = operation
	return nil
}

func (repository *memoryRepository) ReleaseOperationLease(_ context.Context, operationID, owner string, token uint64) error {
	operation, ok := repository.operations[operationID]
	if !ok {
		return ErrNotFound
	}
	if operation.LeaseOwner == owner && operation.LeaseToken == token {
		operation.LeaseOwner = ""
		operation.LeaseExpiresAt = nil
		repository.operations[operationID] = operation
	}
	return nil
}

func (repository *memoryRepository) InstalledRelease(_ context.Context, connectorKey, releaseDigest string) (Release, error) {
	for _, operation := range repository.operations {
		if operation.Kind == OperationKindInstall && operation.State == OperationStateCompleted && operation.ConnectorKey == connectorKey &&
			operation.Target != nil && operation.Target.Release != nil && operation.Target.ReleaseDigest == releaseDigest {
			return *operation.Target.Release, nil
		}
	}
	connector, ok := repository.connectors[connectorKey]
	if ok && connector.Release.ReleaseDigest == releaseDigest {
		return connector.Release, nil
	}
	return Release{}, ErrNotFound
}

func (repository *memoryRepository) Transaction(_ context.Context, fn func(Transaction) error) error {
	repository.transactionCalls++
	if repository.failTransactionCall == repository.transactionCalls {
		if repository.failTransactionErr != nil {
			return repository.failTransactionErr
		}
		return errors.New("simulated transaction failure")
	}
	if repository.transactionErr != nil {
		err := repository.transactionErr
		repository.transactionErr = nil
		return err
	}
	transaction := &memoryTransaction{
		revision:       repository.revision,
		catalogState:   repository.catalogState,
		sourceRevision: repository.sourceRevision,
		connectors:     cloneConnectors(repository.connectors),
		operations:     cloneOperations(repository.operations),
		events:         append([]ChangedEvent(nil), repository.events...),
	}
	if err := fn(transaction); err != nil {
		return err
	}
	repository.revision = transaction.revision
	repository.catalogState = transaction.catalogState
	repository.sourceRevision = transaction.sourceRevision
	repository.connectors = transaction.connectors
	repository.operations = transaction.operations
	repository.events = transaction.events
	return nil
}

func (repository *memoryRepository) RecoverableOperations(context.Context) ([]Operation, error) {
	var operations []Operation
	for _, operation := range repository.operations {
		if operation.State == OperationStateAccepted || operation.State == OperationStateRunning {
			operations = append(operations, operation)
		}
	}
	return operations, nil
}

type memoryTransaction struct {
	revision       uint64
	catalogState   CatalogState
	sourceRevision string
	connectors     map[string]Connector
	operations     map[string]Operation
	events         []ChangedEvent
}

func (transaction *memoryTransaction) Revision() uint64 { return transaction.revision }

func (transaction *memoryTransaction) AdvanceRevision() uint64 {
	transaction.revision++
	return transaction.revision
}

func (transaction *memoryTransaction) Connectors() ([]Connector, error) {
	connectors := make([]Connector, 0, len(transaction.connectors))
	for _, connector := range transaction.connectors {
		connectors = append(connectors, connector)
	}
	return connectors, nil
}

func (transaction *memoryTransaction) Connector(connectorKey string) (Connector, error) {
	connector, ok := transaction.connectors[connectorKey]
	if !ok {
		return Connector{}, ErrNotFound
	}
	return connector, nil
}

func (transaction *memoryTransaction) Operation(operationID string) (Operation, error) {
	operation, ok := transaction.operations[operationID]
	if !ok {
		return Operation{}, ErrNotFound
	}
	return operation, nil
}

func (transaction *memoryTransaction) OperationByClientRequestID(clientRequestID string) (*Operation, error) {
	for _, operation := range transaction.operations {
		if operation.ClientRequestID == clientRequestID {
			copy := operation
			return &copy, nil
		}
	}
	return nil, nil
}

func (transaction *memoryTransaction) ActiveOperation(connectorKey string) (*Operation, error) {
	for _, operation := range transaction.operations {
		if (connectorKey == "" || operation.ConnectorKey == "" || operation.ConnectorKey == connectorKey) &&
			(operation.State == OperationStateAccepted || operation.State == OperationStateRunning) {
			copy := operation
			return &copy, nil
		}
	}
	return nil, nil
}

func (transaction *memoryTransaction) SaveCatalogRevision(sourceRevision string) error {
	transaction.sourceRevision = sourceRevision
	return nil
}

func (transaction *memoryTransaction) SetCatalogState(state CatalogState) error {
	transaction.catalogState = state
	return nil
}

func (transaction *memoryTransaction) SaveConnector(connector Connector) error {
	transaction.connectors[connector.Key] = connector
	return nil
}

func (transaction *memoryTransaction) DeleteConnector(connectorKey string) error {
	delete(transaction.connectors, connectorKey)
	return nil
}

func (transaction *memoryTransaction) SaveOperation(operation Operation) error {
	transaction.operations[operation.OperationID] = operation
	return nil
}

func (transaction *memoryTransaction) EnqueueConnectorMarketChanged(event ChangedEvent) error {
	transaction.events = append(transaction.events, event)
	return nil
}

func cloneConnectors(source map[string]Connector) map[string]Connector {
	cloned := make(map[string]Connector, len(source))
	for key, connector := range source {
		cloned[key] = connector
	}
	return cloned
}

func cloneOperations(source map[string]Operation) map[string]Operation {
	cloned := make(map[string]Operation, len(source))
	for key, operation := range source {
		cloned[key] = operation
	}
	return cloned
}
