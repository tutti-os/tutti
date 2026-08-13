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

func TestApplicationRepairInstallClearsInvalidInstalledEvidence(t *testing.T) {
	for _, failureCode := range []string{
		InstallationFailureCodePhysicallyAbsent,
		InstallationFailureCodePhysicallyInvalid,
	} {
		t.Run(failureCode, func(t *testing.T) {
			connector := testConnector("github")
			connector.Installation = Installation{
				State:                  InstallationStateFailed,
				InstalledVersion:       connector.Release.Version,
				InstalledReleaseID:     connector.Release.ReleaseID,
				InstalledReleaseDigest: connector.Release.ReleaseDigest,
				FailureCode:            failureCode,
			}
			repository := newMemoryRepository(connector)
			application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})

			accepted, err := application.Install(context.Background(), ConnectorMutation{
				Mutation:     Mutation{ClientRequestID: "repair-" + failureCode, ExpectedRevision: 0},
				ConnectorKey: connector.Key,
			})
			if err != nil {
				t.Fatal(err)
			}
			if accepted.Connector == nil {
				t.Fatal("accepted repair omitted Connector projection")
			}
			installation := accepted.Connector.Installation
			if installation.State != InstallationStateInstalling ||
				installation.InstalledVersion != "" ||
				installation.InstalledReleaseID != "" ||
				installation.InstalledReleaseDigest != "" ||
				installation.FailureCode != "" {
				t.Fatalf("accepted repair installation = %#v", installation)
			}
		})
	}
}

func TestApplicationUpdateInstallRetainsUsableInstalledEvidence(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       "0.9.0",
		InstalledReleaseID:     "github@0.9.0",
		InstalledReleaseDigest: strings.Repeat("a", 64),
	}
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})

	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "update-github", ExpectedRevision: 0},
		ConnectorKey: connector.Key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Connector == nil {
		t.Fatal("accepted update omitted Connector projection")
	}
	installation := accepted.Connector.Installation
	if installation.State != InstallationStateUpdating ||
		installation.InstalledVersion != connector.Installation.InstalledVersion ||
		installation.InstalledReleaseID != connector.Installation.InstalledReleaseID ||
		installation.InstalledReleaseDigest != connector.Installation.InstalledReleaseDigest {
		t.Fatalf("accepted update installation = %#v", installation)
	}
}

func TestApplicationClientRequestIDIsReusableOnlyAfterTerminalRetention(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	command := ConnectorMutation{Mutation: Mutation{ClientRequestID: "request-retained", ExpectedRevision: 0}, ConnectorKey: "github"}
	accepted, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), scheduler.operationIDs[len(scheduler.operationIDs)-1]); err != nil {
		t.Fatal(err)
	}
	retried, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Operation.OperationID != accepted.Operation.OperationID || retried.Operation.State != OperationStateCompleted {
		t.Fatalf("retained retry = %#v, want completed operation %q", retried.Operation, accepted.Operation.OperationID)
	}

	// Lifecycle cleanup removes the idempotency key with its terminal result.
	// A caller reusing that key after the documented window starts a new
	// operation and must provide the current revision like any fresh command.
	delete(repository.operations, accepted.Operation.OperationID)
	command.ExpectedRevision = repository.revision
	afterRetention, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if afterRetention.Operation.OperationID == accepted.Operation.OperationID || afterRetention.Operation.State != OperationStateAccepted {
		t.Fatalf("post-retention operation = %#v", afterRetention.Operation)
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

func TestApplicationDoesNotProjectInstalledBeforePhysicalCommit(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	physicalCommitErr := errors.New("physical commit unavailable")
	installationHost := &memoryInstallRuntime{installationCommitErr: physicalCommitErr}
	application := newTestApplication(t, repository, scheduler, installationHost, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "request-physical-commit", ExpectedRevision: 0}, ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err == nil {
		t.Fatal("physical commit failure was accepted")
	}
	connector, err := repository.Connector(context.Background(), "github")
	if err != nil {
		t.Fatal(err)
	}
	if connector.Installation.State == InstallationStateInstalled {
		t.Fatalf("installation projected before physical commit: %#v", connector.Installation)
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
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, host, CatalogSnapshot{})
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
	if host.cliInstalls != 1 || operation.Execution.ReleaseInstallation == nil ||
		operation.Execution.ReleaseInstallation.CLIInstallation == nil || operation.State != OperationStateCompleted {
		t.Fatalf("CLI installs = %d, operation = %#v", host.cliInstalls, operation)
	}
}

func TestApplicationLocalUninstallRemovesDeviceReleaseWithoutDisconnectingAuthorization(t *testing.T) {
	connector := testConnector("lark")
	connector.Release.Manifest.AuthorizationKind = "oauth2"
	connector.Release.Manifest.Implementation.ManagedStdio.MCP = nil
	connector.Release.Manifest.Implementation.ManagedStdio.CLI = &ManagedCLIInterface{Entrypoint: "lark-cli",
		Install: &CLIInstallation{Kind: "node_package", NodePackage: &NodePackageInstallation{
			Package: "@larksuite/cli", Version: "1.0.83",
			Integrity: "sha512-qbJYoJtNch6dV8RvYBO2wpcKO9+6Io3Cuf5alYFzvLbtkSntOKqoc+xHI7p6wRq4oH4F9fydgNJbTGy79ibPdg==",
			Launch:    NodePackageLaunch{Kind: "native", Entrypoint: "bin/lark-cli", SHA256: strings.Repeat("c", 64)},
		}},
	}
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{}
	provider := &countingAuthorizationProvider{}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	application.config.Authorization = provider

	accepted, err := application.Uninstall(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "uninstall-lark", ExpectedRevision: 0}, ConnectorKey: connector.Key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	stored, err := repository.Connector(context.Background(), connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Installation.State != InstallationStateNotInstalled || stored.Installation.InstalledReleaseDigest != "" {
		t.Fatalf("installation = %#v", stored.Installation)
	}
	if stored.Authorization.State != AuthorizationStateConnected {
		t.Fatalf("local uninstall changed authorization = %#v", stored.Authorization)
	}
	if runtime.deactivations != 1 || !runtime.lastDeactivation.AllConnections || runtime.removes != 1 || runtime.cliRemoves != 1 {
		t.Fatalf("cleanup counts: deactivate=%d artifact=%d cli=%d", runtime.deactivations, runtime.removes, runtime.cliRemoves)
	}
	if provider.disconnects != 0 {
		t.Fatalf("authorization disconnects = %d, want 0", provider.disconnects)
	}
}

func TestCrossMachineReceiptsUseOpaqueReferences(t *testing.T) {
	release := testReleaseWithImplementation("lark", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.Implementation.ManagedStdio.MCP = nil
	release.Manifest.Implementation.ManagedStdio.CLI = &ManagedCLIInterface{Entrypoint: "lark-cli", Install: &CLIInstallation{
		Kind: "node_package", NodePackage: &NodePackageInstallation{Package: "@larksuite/cli", Version: "1.0.83",
			Integrity: "sha512-qbJYoJtNch6dV8RvYBO2wpcKO9+6Io3Cuf5alYFzvLbtkSntOKqoc+xHI7p6wRq4oH4F9fydgNJbTGy79ibPdg==",
			Launch:    NodePackageLaunch{Kind: "native", Entrypoint: "bin/lark-cli", SHA256: strings.Repeat("c", 64)}},
	}}
	operation := Operation{OperationID: "operation-1", ConnectorKey: "lark"}
	prepared := PreparedArtifactReceipt{OperationID: operation.OperationID, ConnectorKey: "lark", Version: release.Version,
		ReleaseDigest: release.ReleaseDigest, ArtifactSHA256: release.Artifact.SHA256,
		InventoryDigest: strings.Repeat("e", 64), OpaqueArtifactRef: "guest-artifact-1"}
	if err := validatePreparedArtifact(operation, release, prepared); err != nil {
		t.Fatal(err)
	}
	install := releaseCLIInstallation(release)
	installed := CLIInstallationReceipt{SchemaVersion: "tutti.connector.cli-installation.v1", OperationID: operation.OperationID,
		ConnectorKey: "lark", ReleaseDigest: release.ReleaseDigest, RuntimeProfile: "connector-node-static",
		RuntimeABI: "node24-linux-arm64", NodeVersion: "24.18.0", NodeSHA256: strings.Repeat("1", 64),
		Package: install.Package, PackageVersion: install.Version, PackageIntegrity: install.Integrity,
		LaunchKind: install.Launch.Kind, Entrypoint: "node_modules/@larksuite/cli/bin/lark-cli",
		EntrypointSHA256: strings.Repeat("2", 64), EntrypointSize: 7, OpaqueInstallationRef: "guest-install-1"}
	receipt := ReleaseInstallationReceipt{OperationID: operation.OperationID, ConnectorKey: release.ConnectorKey,
		Version: release.Version, ReleaseID: release.ReleaseID, ReleaseDigest: release.ReleaseDigest,
		ArtifactSHA256: release.Artifact.SHA256, Artifact: prepared, CLIInstallation: &installed,
		OpaqueRuntimeRef: "guest-runtime-1"}
	if err := validateReleaseInstallationReceipt(operation, release, receipt); err != nil {
		t.Fatal(err)
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
		host.lastReconcile.Generation.Generation != 8 || host.lastReconcile.Generation.BootEpoch == "" {
		t.Fatalf("startup reconcile = %#v, count=%d", host.lastReconcile, host.reconciles)
	}
	operationID := "reconcile/" + application.config.BootEpoch + "/" + connector.Key
	operation, err := repository.Operation(context.Background(), operationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != OperationKindReconcileRuntime || operation.State != OperationStateCompleted ||
		operation.Stage != OperationStageCompleted || operation.Scope != (OperationScope{}) ||
		operation.HostGeneration != host.lastReconcile.Generation {
		t.Fatalf("startup reconcile operation = %#v", operation)
	}
}

func TestApplicationStartupReconcileAcceptsDisabledRuntimeWithoutBlockingEnabledRuntime(t *testing.T) {
	disabled := testConnector("dingtalk")
	disabled.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: disabled.Release.Version,
		InstalledReleaseID: disabled.Release.ReleaseID, InstalledReleaseDigest: disabled.Release.ReleaseDigest,
	}
	enabled := testConnector("lark")
	enabled.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: enabled.Release.Version,
		InstalledReleaseID: enabled.Release.ReleaseID, InstalledReleaseDigest: enabled.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(disabled, enabled)
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})
	application.config.RuntimeBindings = runtimeBindingResolverFunc(func(_ context.Context, request RuntimeBindingRequest) (RuntimeBinding, error) {
		return RuntimeBinding{
			ConnectionID: request.Connector.Key + "-connection",
			Enabled:      request.Connector.Key == enabled.Key,
		}, nil
	})

	if err := application.ReconcileInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(host.reconcileRequests) != 2 {
		t.Fatalf("runtime reconciles = %#v", host.reconcileRequests)
	}
	if host.reconcileRequests[0].Connector.Key != disabled.Key || host.reconcileRequests[0].Enabled ||
		host.reconcileRequests[1].Connector.Key != enabled.Key || !host.reconcileRequests[1].Enabled {
		t.Fatalf("runtime reconciles = %#v", host.reconcileRequests)
	}
}

func TestApplicationStartupReconcileContinuesAfterConnectorFailure(t *testing.T) {
	failing := testConnector("dingtalk")
	failing.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: failing.Release.Version,
		InstalledReleaseID: failing.Release.ReleaseID, InstalledReleaseDigest: failing.Release.ReleaseDigest,
	}
	healthy := testConnector("lark")
	healthy.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: healthy.Release.Version,
		InstalledReleaseID: healthy.Release.ReleaseID, InstalledReleaseDigest: healthy.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(failing, healthy)
	host := &memoryInstallRuntime{reconcileErrors: map[string]error{failing.Key: errors.New("runtime unavailable")}}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})

	err := application.ReconcileInstalledRuntimes(context.Background())
	var failures *RuntimeReconcileFailures
	if !errors.As(err, &failures) {
		t.Fatalf("startup reconcile error = %v", err)
	}
	failedKeys := failures.ConnectorKeys()
	if len(failedKeys) != 1 || failedKeys[0] != failing.Key {
		t.Fatalf("failed connector keys = %#v", failedKeys)
	}
	if len(host.reconcileRequests) != 2 || host.reconcileRequests[1].Connector.Key != healthy.Key {
		t.Fatalf("runtime reconciles = %#v", host.reconcileRequests)
	}
}

func TestValidateRuntimeReceiptRequiresExactDisabledReadiness(t *testing.T) {
	generation := HostGeneration{BootEpoch: "boot-1", Generation: 1}
	base := RuntimeReceipt{
		OperationID: "operation-1", ConnectionID: "connection-1", ConnectorKey: "dingtalk",
		ReleaseDigest: strings.Repeat("a", 64), Generation: generation,
	}
	tests := []struct {
		name      string
		readiness RuntimeReadiness
		wantError bool
	}{
		{name: "disabled", readiness: RuntimeReadiness{
			State: RuntimeReadinessBlocked, ReasonCode: RuntimeReadinessReasonRuntimeDisabled}},
		{name: "ready", readiness: RuntimeReadiness{State: RuntimeReadinessReady,
			Interfaces: []InterfaceReadiness{{Kind: "mcp", State: RuntimeReadinessReady}}}, wantError: true},
		{name: "unrelated block", readiness: RuntimeReadiness{
			State: RuntimeReadinessBlocked, ReasonCode: "publication_gate_closed"}, wantError: true},
		{name: "disabled with published interface", readiness: RuntimeReadiness{
			State: RuntimeReadinessBlocked, ReasonCode: RuntimeReadinessReasonRuntimeDisabled,
			Interfaces: []InterfaceReadiness{{Kind: "mcp", State: RuntimeReadinessReady}}}, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			receipt := base
			receipt.Readiness = test.readiness
			err := validateRuntimeReceipt(receipt, base.OperationID, base.ConnectionID, base.ConnectorKey,
				base.ReleaseDigest, generation, false)
			if (err != nil) != test.wantError {
				t.Fatalf("validateRuntimeReceipt() error = %v, wantError = %t", err, test.wantError)
			}
		})
	}
}

func TestApplicationInstallKeepsRuntimeReconcileSeparate(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	host := &memoryInstallRuntime{}
	resolver := &runtimeBindingResolverStub{binding: RuntimeBinding{ConnectionID: "account-connection", Enabled: false}}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})
	application.config.RuntimeBindings = resolver

	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "install-account", ExpectedRevision: 0},
		ConnectorKey: "github", AccountID: "account-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	operation := repository.operations[accepted.Operation.OperationID]
	if operation.Scope.AccountID != "account-1" || host.lastPrepare.Scope.AccountID != "account-1" ||
		host.lastPrepare.Generation != operation.HostGeneration || host.reconciles != 0 {
		t.Fatalf("operation=%#v prepare=%#v reconcile=%#v", operation, host.lastPrepare, host.lastReconcile)
	}
	if repository.connectors["github"].Installation.State != InstallationStateInstalled {
		t.Fatalf("installation = %#v", repository.connectors["github"].Installation)
	}
}

func TestApplicationCredentialGrantIsNotPersistedAndIsCleared(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	host := &memoryInstallRuntime{}
	grant := []byte("one-shot-grant")
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, host, CatalogSnapshot{})
	application.config.RuntimeBindings = &runtimeBindingResolverStub{binding: RuntimeBinding{
		ConnectionID: "account-connection", Enabled: true, CredentialBrokerGrant: grant,
	}}
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "install-grant"}, ConnectorKey: "github", AccountID: "account-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), scheduler.operationIDs[len(scheduler.operationIDs)-1]); err != nil {
		t.Fatal(err)
	}
	if host.lastCredentialGrant != "one-shot-grant" {
		t.Fatalf("runtime grant = %q", host.lastCredentialGrant)
	}
	if string(grant) != strings.Repeat("\x00", len(grant)) {
		t.Fatalf("credential grant was not cleared: %v", grant)
	}
	payload := fmt.Sprintf("%#v", repository.operations[accepted.Operation.OperationID])
	if strings.Contains(payload, "one-shot-grant") {
		t.Fatalf("operation persisted credential authority: %s", payload)
	}
}

func TestApplicationReconcileRuntimeKeepsDeviceInstallationTruth(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})
	application.config.RuntimeBindings = &runtimeBindingResolverStub{binding: RuntimeBinding{ConnectionID: "account-connection", Enabled: false}}
	accepted, err := application.ReconcileRuntime(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "reconcile-account"}, ConnectorKey: "github", AccountID: "account-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	stored := repository.connectors["github"]
	if stored.Installation.State != InstallationStateInstalled || stored.Installation.InstalledReleaseDigest != connector.Release.ReleaseDigest ||
		host.lastReconcile.Enabled {
		t.Fatalf("connector=%#v reconcile=%#v", stored, host.lastReconcile)
	}
}

func TestApplicationAuthorizationObservationReconcilesWithoutChangingInstallation(t *testing.T) {
	connector := testConnector("github")
	connector.Release.Manifest.AuthorizationKind = "oauth2"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	host := &memoryInstallRuntime{}
	projections := &recordingAuthorizationProjectionStore{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})
	application.config.AuthorizationProjections = projections
	application.config.RuntimeBindings = AccountRuntimeBindingResolver{
		Projections: projections, Credentials: &credentialGrantIssuerStub{grant: []byte("credential-grant")},
	}
	connected := AuthorizationProjection{AccountID: "account-1", ConnectorKey: "github",
		ConnectionID: "server-connection", State: AuthorizationStateConnected}
	accepted, err := application.ObserveAuthorization(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "authorization-connected"}, ConnectorKey: "github", AccountID: "account-1",
	}, connected)
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if !host.lastReconcile.Enabled || host.lastReconcile.ConnectionID != "server-connection" ||
		host.lastCredentialGrant != "credential-grant" {
		t.Fatalf("connected reconcile = %#v", host.lastReconcile)
	}
	expired := connected
	expired.State = AuthorizationStateExpired
	accepted, err = application.ObserveAuthorization(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "authorization-expired", ExpectedRevision: repository.revision},
		ConnectorKey: "github", AccountID: "account-1",
	}, expired)
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if host.lastReconcile.Enabled || repository.connectors["github"].Installation.State != InstallationStateInstalled {
		t.Fatalf("expired reconcile = %#v connector = %#v", host.lastReconcile, repository.connectors["github"])
	}
}

func TestApplicationStartupReconcileAdvancesPastFence(t *testing.T) {
	connector := testConnector("github")
	connector.Revision = 7
	connector.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	host := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, host, CatalogSnapshot{})

	if err := application.FenceInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := application.ReconcileInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if host.lastDeactivation.Generation.Generation != 7 || host.lastReconcile.Generation.Generation != 8 || repository.connectors["github"].Revision < 8 {
		t.Fatalf("startup generations: fence=%#v reconcile=%#v", host.lastDeactivation.Generation, host.lastReconcile.Generation)
	}
	firstReconcileGeneration := host.lastReconcile.Generation.Generation
	if err := application.FenceInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := application.ReconcileInstalledRuntimes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if host.lastDeactivation.Generation.Generation < firstReconcileGeneration ||
		host.lastReconcile.Generation.Generation <= host.lastDeactivation.Generation.Generation {
		t.Fatalf("repeated startup generations: fence=%#v reconcile=%#v", host.lastDeactivation.Generation, host.lastReconcile.Generation)
	}
}

func TestApplicationCrossDeviceRemoteReconcileUsesAccountProjectionAuthorization(t *testing.T) {
	connector := testConnector("tencent-docs")
	connector.Release.Manifest.AuthorizationKind = "api_key"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Release.Manifest.Implementation = Implementation{Kind: ImplementationKindRemoteStreamableHTTP, RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
		ProtocolVersion: "2026-07-28", BindingRef: "tencent-docs.primary", ContractVersion: 1,
		BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}}
	connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{}
	projectionStore := &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: connector.Key, ConnectionID: "server-connection", State: AuthorizationStateConnected,
		ServerSynchronized: true,
	}}
	readiness := NewAuthorizationReadinessGate()
	readiness.SetReady("account-1", true)
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	application.config.AuthorizationProjections = projectionStore
	application.config.RuntimeBindings = AccountRuntimeBindingResolver{Projections: projectionStore, Readiness: readiness}

	if err := application.ReconcileInstalledRuntimesForScope(context.Background(), OperationScope{AccountID: "account-1"}); err != nil {
		t.Fatal(err)
	}
	if !runtime.lastReconcile.Enabled || runtime.lastReconcile.Connector.Authorization.State != AuthorizationStateConnected ||
		runtime.lastReconcile.ConnectionID != AccountRuntimeConnectionID("account-1", connector.Key) {
		t.Fatalf("remote reconcile = %#v", runtime.lastReconcile)
	}
	if repository.connectors[connector.Key].Authorization.State != AuthorizationStateDisconnected {
		t.Fatalf("device installation authorization was mutated: %#v", repository.connectors[connector.Key].Authorization)
	}
}

func TestApplicationLocalUninstallKeepsRemoteProjectionAndReusesItAfterReinstall(t *testing.T) {
	connector := testConnector("tencent-docs")
	connector.Release.Manifest.AuthorizationKind = "api_key"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Release.Manifest.Implementation = Implementation{Kind: ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
			ProtocolVersion: "2026-07-28", BindingRef: "tencent-docs.primary", ContractVersion: 1,
			BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		}}
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{}
	projection := AuthorizationProjection{AccountID: "account-1", ConnectorKey: connector.Key,
		ConnectionID: "server-connection", State: AuthorizationStateConnected, ServerSynchronized: true}
	projectionStore := &authorizationProjectionStoreStub{projection: projection}
	readiness := NewAuthorizationReadinessGate()
	readiness.SetReady("account-1", true)
	provider := &countingAuthorizationProvider{}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	application.config.Authorization = provider
	application.config.AuthorizationProjections = projectionStore
	application.config.RuntimeBindings = AccountRuntimeBindingResolver{Projections: projectionStore, Readiness: readiness}
	application.config.ImplementationRegistry = NewImplementationRegistry(map[string]ImplementationValidator{
		ImplementationKindRemoteStreamableHTTP: nil,
	})

	uninstall, err := application.Uninstall(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "uninstall-tencent-docs", ExpectedRevision: 0},
		ConnectorKey: connector.Key, AccountID: "account-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), uninstall.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if runtime.lastDeactivation.ConnectionID != AccountRuntimeConnectionID("account-1", connector.Key) {
		t.Fatalf("deactivation = %#v", runtime.lastDeactivation)
	}
	if projectionStore.projection != projection {
		t.Fatalf("authorization projection changed = %#v, want %#v", projectionStore.projection, projection)
	}
	if provider.disconnects != 0 {
		t.Fatalf("authorization disconnects = %d, want 0", provider.disconnects)
	}
	if err := application.ReconcileRemoteAuthorizedRuntimesForScope(context.Background(), OperationScope{AccountID: "account-1"}); err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 0 {
		t.Fatalf("uninstalled connector reconciles = %d, want 0", runtime.reconciles)
	}

	snapshot, err := application.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	install, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "reinstall-tencent-docs", ExpectedRevision: snapshot.Revision},
		ConnectorKey: connector.Key, AccountID: "account-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), install.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if err := application.ReconcileInstalledRuntimesForScope(context.Background(), OperationScope{AccountID: "account-1"}); err != nil {
		t.Fatal(err)
	}
	if runtime.reconciles != 1 || !runtime.lastReconcile.Enabled ||
		runtime.lastReconcile.Connector.Authorization.State != AuthorizationStateConnected {
		t.Fatalf("reinstalled runtime reconcile = %#v, count=%d", runtime.lastReconcile, runtime.reconciles)
	}
}

func TestApplicationRemoteAuthorizationStartUsesAccountProjectionInsteadOfDeviceState(t *testing.T) {
	connector := testConnector("tencent-docs")
	connector.Release.Manifest.AuthorizationKind = "oauth2"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Release.Manifest.Implementation = Implementation{
		Kind: ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
			ProtocolVersion: "2026-07-28", BindingRef: "tencent-docs.primary", ContractVersion: 1,
			BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
	// This device field may have been written while another account was active.
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.AuthorizationProjections = &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-new", ConnectorKey: connector.Key, State: AuthorizationStateDisconnected,
		ServerSynchronized: true,
	}}

	result, err := application.BeginAuthorization(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "authorization-new-account"},
		ConnectorKey: connector.Key, AccountID: "account-new",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.AuthorizationURL == "" || repository.connectors[connector.Key].Authorization.State != AuthorizationStateConnected {
		t.Fatalf("result=%#v device authorization=%#v", result, repository.connectors[connector.Key].Authorization)
	}
	receipt := repository.operations[result.Operation.OperationID].Execution.AuthorizationSession
	if receipt == nil || receipt.Resolution != AuthorizationSessionResolutionUnresolved {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestApplicationManagedAuthorizationStartRepairsMissingAccountProjection(t *testing.T) {
	connector := testManagedAuthorizedConnector("lark-cli")
	// This device state predates account-scoped authorization projections.
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	repository := newMemoryRepository(connector)
	projections := &recordingAuthorizationProjectionStore{}
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.Authorization = connectedAuthorizationProviderStub{}
	application.config.AuthorizationProjections = projections

	result, err := application.BeginAuthorization(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "authorization-bind-existing-login"},
		ConnectorKey: connector.Key, AccountID: "account-1",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Connector.Authorization.State != AuthorizationStateConnected ||
		projections.projection.State != AuthorizationStateConnected ||
		projections.projection.AccountID != "account-1" {
		t.Fatalf("result=%#v projection=%#v", result, projections.projection)
	}
	if repository.connectors[connector.Key].Authorization.State != AuthorizationStateConnected {
		t.Fatalf("device authorization = %#v", repository.connectors[connector.Key].Authorization)
	}
}

func TestApplicationManagedAuthorizationStartCanChallengeAnotherAccount(t *testing.T) {
	connector := testManagedAuthorizedConnector("lark-cli")
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	repository := newMemoryRepository(connector)
	projections := &recordingAuthorizationProjectionStore{}
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.AuthorizationProjections = projections

	result, err := application.BeginAuthorization(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "authorization-select-account"},
		ConnectorKey: connector.Key, AccountID: "account-2",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.AuthorizationURL == "" || result.Connector.Authorization.State != AuthorizationStatePending ||
		projections.projection.State != AuthorizationStatePending {
		t.Fatalf("result=%#v projection=%#v", result, projections.projection)
	}
	if repository.connectors[connector.Key].Authorization.State != AuthorizationStateConnected {
		t.Fatalf("device authorization = %#v", repository.connectors[connector.Key].Authorization)
	}
}

func TestApplicationManagedAuthorizationContinuationReplaysBeforeProjectionTransitionValidation(t *testing.T) {
	connector := testManagedAuthorizedConnector("lark-cli")
	connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
	repository := newMemoryRepository(connector)
	projections := &recordingAuthorizationProjectionStore{}
	provider := &continuingAuthorizationProviderStub{}
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.Authorization = provider
	application.config.AuthorizationProjections = projections
	mutation := ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "one-authorization-request", ExpectedRevision: 0},
		ConnectorKey: connector.Key,
		AccountID:    "account-1",
	}

	first, err := application.BeginAuthorization(context.Background(), mutation, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.AuthorizationURL != "https://open.feishu.cn/page/cli" ||
		projections.projection.State != AuthorizationStatePending {
		t.Fatalf("first result=%#v projection=%#v", first, projections.projection)
	}
	continued, err := application.BeginAuthorization(context.Background(), mutation, nil)
	if err != nil {
		t.Fatalf("continue authorization: %v", err)
	}
	if continued.Operation.OperationID != first.Operation.OperationID ||
		continued.AuthorizationURL != "https://accounts.feishu.cn/device" || provider.begins != 2 {
		t.Fatalf("continued=%#v first=%#v provider begins=%d", continued, first, provider.begins)
	}
	if len(scheduler.operationIDs) != 0 {
		t.Fatalf("pending authorization scheduled runtime operations: %v", scheduler.operationIDs)
	}

	snapshot, err := application.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = application.BeginAuthorization(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "different-authorization-request", ExpectedRevision: snapshot.Revision},
		ConnectorKey: connector.Key,
		AccountID:    "account-1",
	}, nil)
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeOperationInProgress {
		t.Fatalf("different authorization error = %#v, want operation in progress", err)
	}
}

func TestApplicationConnectedProjectionConvergesReceiptWithoutProviderPolling(t *testing.T) {
	connector := testConnector("tencent-docs")
	connector.Release.Manifest.AuthorizationKind = "oauth2"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Release.Manifest.Implementation = Implementation{
		Kind: ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
			ProtocolVersion: "2026-07-28", BindingRef: "tencent-docs.primary", ContractVersion: 1,
			BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
	repository := newMemoryRepository(connector)
	repository.operations["authorization-1"] = Operation{
		OperationID: "authorization-1", ClientRequestID: "request-1", ConnectorKey: connector.Key,
		Kind: OperationKindStartAuthorization, Scope: OperationScope{AccountID: "account-1"},
		State: OperationStateCompleted, Stage: OperationStageCompleted,
		Target: operationTarget(OperationKindStartAuthorization, connector),
		Execution: OperationExecution{AuthorizationSession: &AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key, SessionID: "session-1",
			ActionType: "redirect", State: AuthorizationStatePending,
			Resolution: AuthorizationSessionResolutionUnresolved,
		}},
	}
	provider := &countingAuthorizationObserver{}
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.Authorization = provider
	application.config.AuthorizationProjections = &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: connector.Key, ConnectionID: "connection-1",
		State: AuthorizationStateConnected, ServerSynchronized: true,
	}}

	intents, err := application.ReconcileAuthorizations(context.Background(), OperationScope{AccountID: "account-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(intents) != 1 || intents[0].OperationID != "authorization-1" || intents[0].Resolution != AuthorizationSessionResolutionAccountStateConverged {
		t.Fatalf("reconcile intents = %#v", intents)
	}
	if provider.observations != 0 {
		t.Fatalf("provider observations = %d, want 0", provider.observations)
	}
	receipt := repository.operations["authorization-1"].Execution.AuthorizationSession
	if receipt == nil || receipt.Resolution != AuthorizationSessionResolutionUnresolved {
		t.Fatalf("receipt = %#v", receipt)
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
	operation.Stage = OperationStageInstalled
	operation.Execution.ReleaseInstallation = &ReleaseInstallationReceipt{
		OperationID:    operation.OperationID,
		ConnectorKey:   release.ConnectorKey,
		Version:        release.Version,
		ReleaseID:      release.ReleaseID,
		ReleaseDigest:  release.ReleaseDigest,
		ArtifactSHA256: release.Artifact.SHA256,
		Artifact: PreparedArtifactReceipt{OperationID: operation.OperationID, ConnectorKey: release.ConnectorKey,
			Version: release.Version, ReleaseDigest: release.ReleaseDigest, ArtifactSHA256: release.Artifact.SHA256,
			InventoryDigest: strings.Repeat("e", 64), PreparedPath: "/prepared/" + release.ReleaseDigest},
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

func TestApplicationRecordsFailureAfterLeaseRenewalCancelsExecution(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	repository.renewOperationLeaseErr = errors.New("lease store temporarily unavailable")
	repository.rejectCanceledTransactionContext = true
	installer := newBlockingInstaller()
	application := newTestApplication(t, repository, &memoryScheduler{}, installer, CatalogSnapshot{})
	application.config.LeaseDuration = 30 * time.Millisecond
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "lease-cancel-install", ExpectedRevision: 0}, ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err == nil {
		t.Fatal("ExecuteOperation() error = nil, want lease cancellation")
	}
	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != OperationStateFailed || operation.Stage != OperationStageFailed {
		t.Fatalf("operation after canceled execution = %#v", operation)
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

func TestApplicationEnsureRuntimeReconcileCreatesOrJoinsCurrentScope(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	repository.revision = 7
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	scope := OperationScope{AccountID: "account-1"}

	created, err := application.EnsureRuntimeReconcile(context.Background(), scope, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	running := repository.operations[created.Operation.OperationID]
	running.State = OperationStateRunning
	repository.operations[running.OperationID] = running
	joined, err := application.EnsureRuntimeReconcile(context.Background(), scope, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if joined.Operation.OperationID != created.Operation.OperationID {
		t.Fatalf("joined operation = %q, want %q", joined.Operation.OperationID, created.Operation.OperationID)
	}
	if !created.Created || joined.Created {
		t.Fatalf("created=%t joined=%t", created.Created, joined.Created)
	}
	if repository.revision != 8 || len(repository.operations) != 1 {
		t.Fatalf("revision=%d operations=%#v", repository.revision, repository.operations)
	}
	if len(scheduler.operationIDs) != 1 || scheduler.operationIDs[0] != created.Operation.OperationID {
		t.Fatalf("scheduled operations = %#v", scheduler.operationIDs)
	}
	completed := repository.operations[created.Operation.OperationID]
	completed.State = OperationStateCompleted
	completed.Stage = OperationStageCompleted
	repository.operations[completed.OperationID] = completed
	followup, err := application.EnsureRuntimeReconcile(context.Background(), scope, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if !followup.Created || followup.Operation.OperationID == created.Operation.OperationID || repository.revision != 9 {
		t.Fatalf("followup=%#v revision=%d", followup, repository.revision)
	}
}

func TestApplicationEnsureRuntimeReconcileDoesNotJoinDifferentScope(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	repository.operations["old-account-reconcile"] = Operation{
		OperationID: "old-account-reconcile", ConnectorKey: connector.Key,
		Kind: OperationKindReconcileRuntime, Scope: OperationScope{AccountID: "account-old"},
		State: OperationStateRunning, Stage: OperationStageAccepted,
	}
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})

	_, err := application.EnsureRuntimeReconcile(context.Background(), OperationScope{AccountID: "account-new"}, connector.Key)
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeOperationInProgress {
		t.Fatalf("error = %#v, want operation in progress", err)
	}
	if len(repository.operations) != 1 {
		t.Fatalf("operations = %#v", repository.operations)
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

func TestApplicationReconcilesCompletedAuthorizationSession(t *testing.T) {
	connector := testConnector("gmail")
	connector.Authorization = Authorization{State: AuthorizationStatePending}
	repository := newMemoryRepository(connector)
	repository.operations["authorization-1"] = Operation{
		OperationID: "authorization-1", ConnectorKey: connector.Key,
		Kind: OperationKindStartAuthorization, State: OperationStateCompleted,
		Target: operationTarget(OperationKindStartAuthorization, connector),
		Execution: OperationExecution{AuthorizationSession: &AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key,
			SessionID: "session-1", AuthorizationURL: "https://example.test/authorize",
		}},
		UpdatedAt: time.Date(2026, 8, 3, 0, 1, 0, 0, time.UTC),
	}
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.Authorization = observingAuthorizationProvider{observation: AuthorizationObservation{State: AuthorizationObservationConnected}}
	if _, err := application.ReconcileAuthorizations(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	updated, err := repository.Connector(context.Background(), connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Authorization.State != AuthorizationStateConnected || len(repository.events) != 1 {
		t.Fatalf("connector=%#v events=%#v", updated, repository.events)
	}
}

func TestApplicationAuthorizationRecoveryProjectsWithoutSchedulingRuntime(t *testing.T) {
	connector := testManagedAuthorizedConnector("gmail")
	connector.Authorization = Authorization{State: AuthorizationStatePending}
	repository := newMemoryRepository(connector)
	repository.operations["authorization-1"] = Operation{
		OperationID: "authorization-1", ConnectorKey: connector.Key,
		Kind: OperationKindStartAuthorization, Scope: OperationScope{AccountID: "account-1"},
		State: OperationStateCompleted, Stage: OperationStageCompleted,
		Target: operationTarget(OperationKindStartAuthorization, connector),
		Execution: OperationExecution{AuthorizationSession: &AuthorizationSession{
			OperationID: "authorization-1", ConnectorKey: connector.Key,
			SessionID: "session-1", State: AuthorizationStatePending,
			Resolution: AuthorizationSessionResolutionUnresolved,
		}},
	}
	scheduler := &memoryScheduler{}
	projections := &recordingAuthorizationProjectionStore{}
	application := newTestApplication(t, repository, scheduler, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.Authorization = observingAuthorizationProvider{observation: AuthorizationObservation{
		State: AuthorizationObservationConnected, ConnectionID: "connection-1",
	}}
	application.config.AuthorizationProjections = projections

	intents, err := application.ReconcileAuthorizations(context.Background(), OperationScope{AccountID: "account-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(intents) != 1 || intents[0].OperationID != "authorization-1" {
		t.Fatalf("intents = %#v", intents)
	}
	if len(scheduler.operationIDs) != 0 {
		t.Fatalf("recovery scheduled runtime operations = %#v", scheduler.operationIDs)
	}
	if projections.projection.State != AuthorizationStateConnected || projections.projection.ConnectionID != "connection-1" {
		t.Fatalf("projection = %#v", projections.projection)
	}
}

func newTestApplication(
	t *testing.T,
	repository *memoryRepository,
	scheduler *memoryScheduler,
	installationHost interface {
		ReleaseInstallationManager
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
		ReleaseInstallationManager
		ImplementationHost
	},
	catalogSource CatalogSource,
) *Application {
	t.Helper()
	nextID := 0
	application, err := NewApplication(ApplicationConfig{
		Repository:             repository,
		CatalogSource:          catalogSource,
		ReleaseInstallations:   installationHost,
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

func testManagedAuthorizedConnector(key string) Connector {
	connector := testConnector(key)
	connector.Release.Manifest.AuthorizationKind = "oauth2"
	connector.Release.Manifest.RequiredCapabilities = []string{"tools"}
	connector.Release.Manifest.Implementation.ManagedStdio.Runtime.VersionRange = ">=20.0.0 <21.0.0"
	connector.Release.Manifest.Implementation.ManagedStdio.CLI = &ManagedCLIInterface{Entrypoint: "bin/lark-cli", TimeoutMS: 120_000}
	connector.Release.Manifest.Implementation.ManagedStdio.CredentialBroker = &ManagedCredentialBroker{
		Protocol: CredentialBrokerProtocolV1, Entrypoint: "authorization/broker.mjs", TimeoutMS: 30_000,
		AllowedHosts: []string{"open.larksuite.com"},
	}
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: connector.Release.Version,
		InstalledReleaseID: connector.Release.ReleaseID, InstalledReleaseDigest: connector.Release.ReleaseDigest}
	return connector
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
	prepares                int
	removes                 int
	activations             int
	deactivations           int
	activeDigest            string
	reconciles              int
	reconcileRequests       []RuntimeReconcileRequest
	lastReconcile           RuntimeReconcileRequest
	lastDeactivation        RuntimeDeactivationRequest
	lastPrepare             PrepareArtifactRequest
	lastCredentialGrant     string
	deactivationErr         error
	failClosed              int
	cliInstalls             int
	cliRemoves              int
	installationInspections int
	installationResult      ReleaseInstallationObservation
	installationInspectErr  error
	installationCommitErr   error
	reconcileErrors         map[string]error
}

func (host *memoryInstallRuntime) Reconcile(_ context.Context, request RuntimeReconcileRequest) (RuntimeReceipt, error) {
	host.reconciles++
	host.reconcileRequests = append(host.reconcileRequests, request)
	host.lastReconcile = request
	host.lastCredentialGrant = string(request.CredentialBrokerGrant)
	if err := host.reconcileErrors[request.Connector.Key]; err != nil {
		return RuntimeReceipt{}, err
	}
	readiness := RuntimeReadiness{State: RuntimeReadinessReady,
		Interfaces: []InterfaceReadiness{{Kind: "mcp", State: RuntimeReadinessReady}}}
	summary := &ConnectorSummary{Key: request.Connector.Key, Name: request.Connector.Key,
		Interfaces: []ConnectorInterfaceSummary{{Kind: "mcp", ServerName: "connector", Status: string(RuntimeReadinessReady)}}}
	if !request.Enabled {
		readiness = RuntimeReadiness{State: RuntimeReadinessBlocked, ReasonCode: RuntimeReadinessReasonRuntimeDisabled}
		summary = nil
	}
	return RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation,
		Readiness: readiness, Summary: summary}, nil
}

func (host *memoryInstallRuntime) InspectReleaseInstallation(_ context.Context, request InspectReleaseInstallationRequest) (ReleaseInstallationObservation, error) {
	host.installationInspections++
	if host.installationInspectErr != nil {
		return ReleaseInstallationObservation{}, host.installationInspectErr
	}
	result := host.installationResult
	if result.State == "" {
		result.State = ReleaseInstallationPresent
	}
	if result.ConnectorKey == "" {
		result.ConnectorKey = request.Release.ConnectorKey
	}
	if result.ReleaseDigest == "" {
		result.ReleaseDigest = request.Release.ReleaseDigest
	}
	return result, nil
}

func (host *memoryInstallRuntime) DeactivateRuntime(_ context.Context, request RuntimeDeactivationRequest) error {
	host.deactivations++
	host.lastDeactivation = request
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
	host.lastPrepare = request
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

func (host *memoryInstallRuntime) InstallRelease(
	ctx context.Context,
	request InstallReleaseRequest,
) (ReleaseInstallationReceipt, error) {
	prepared, err := host.Prepare(ctx, PrepareArtifactRequest(request))
	if err != nil {
		return ReleaseInstallationReceipt{}, err
	}
	receipt := ReleaseInstallationReceipt{OperationID: request.OperationID, ConnectorKey: request.Release.ConnectorKey,
		Version: request.Release.Version, ReleaseID: request.Release.ReleaseID, ReleaseDigest: request.Release.ReleaseDigest,
		ArtifactSHA256: request.Release.Artifact.SHA256, Artifact: prepared}
	if releaseCLIInstallation(request.Release) != nil {
		installed, err := host.InstallCLI(ctx, InstallCLIRequest(request))
		if err != nil {
			return ReleaseInstallationReceipt{}, err
		}
		receipt.CLIInstallation = &installed
	}
	return receipt, nil
}

func (host *memoryInstallRuntime) UninstallRelease(ctx context.Context, request UninstallReleaseRequest) error {
	if releaseCLIInstallation(request.Release) != nil {
		if err := host.RemoveCLI(ctx, RemoveCLIRequest{OperationID: request.OperationID, Scope: request.Scope,
			Generation: request.Generation, ConnectorKey: request.Release.ConnectorKey,
			ReleaseDigest: request.Release.ReleaseDigest}); err != nil {
			return err
		}
	}
	return host.Remove(ctx, RemoveArtifactRequest{OperationID: request.OperationID, Scope: request.Scope,
		Generation: request.Generation, ConnectorKey: request.Release.ConnectorKey, Version: request.Release.Version,
		ReleaseDigest: request.Release.ReleaseDigest})
}

func (host *memoryInstallRuntime) CommitReleaseInstallation(context.Context, CommitReleaseInstallationRequest) error {
	return host.installationCommitErr
}

type runtimeBindingResolverStub struct {
	binding RuntimeBinding
}

type runtimeBindingResolverFunc func(context.Context, RuntimeBindingRequest) (RuntimeBinding, error)

type recordingAuthorizationProjectionStore struct {
	projection AuthorizationProjection
}

func (store *recordingAuthorizationProjectionStore) AuthorizationProjection(context.Context, string, string) (AuthorizationProjection, error) {
	if store.projection.AccountID == "" {
		return AuthorizationProjection{}, ErrNotFound
	}
	return store.projection, nil
}

func (store *recordingAuthorizationProjectionStore) SaveAuthorizationProjection(_ context.Context, projection AuthorizationProjection) error {
	store.projection = projection
	return nil
}

func (resolver *runtimeBindingResolverStub) ResolveRuntimeBinding(context.Context, RuntimeBindingRequest) (RuntimeBinding, error) {
	return resolver.binding, nil
}

func (resolver runtimeBindingResolverFunc) ResolveRuntimeBinding(ctx context.Context, request RuntimeBindingRequest) (RuntimeBinding, error) {
	return resolver(ctx, request)
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

func (installer *blockingInstaller) InstallRelease(ctx context.Context, request InstallReleaseRequest) (ReleaseInstallationReceipt, error) {
	installer.installs.Add(1)
	installer.once.Do(func() { close(installer.started) })
	select {
	case <-installer.release:
		if installer.err != nil {
			return ReleaseInstallationReceipt{}, installer.err
		}
		return ReleaseInstallationReceipt{
			OperationID: request.OperationID, ConnectorKey: request.Release.ConnectorKey,
			Version: request.Release.Version, ReleaseID: request.Release.ReleaseID,
			ReleaseDigest: request.Release.ReleaseDigest, ArtifactSHA256: request.Release.Artifact.SHA256,
			Artifact: PreparedArtifactReceipt{OperationID: request.OperationID, ConnectorKey: request.Release.ConnectorKey,
				Version: request.Release.Version, ReleaseDigest: request.Release.ReleaseDigest,
				ArtifactSHA256:  request.Release.Artifact.SHA256,
				InventoryDigest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				PreparedPath:    "/prepared/" + request.Release.ReleaseDigest},
		}, nil
	case <-ctx.Done():
		return ReleaseInstallationReceipt{}, ctx.Err()
	}
}

type authorizationProviderStub struct{}

func (authorizationProviderStub) Begin(_ context.Context, request AuthorizationStartRequest) (AuthorizationSession, error) {
	return AuthorizationSession{
		OperationID:      request.OperationID,
		ConnectorKey:     request.Connector.Key,
		SessionID:        "session-1",
		ActionType:       "redirect",
		AuthorizationURL: "https://example.test/authorize",
		State:            AuthorizationStatePending,
	}, nil
}

func (authorizationProviderStub) Disconnect(context.Context, AuthorizationDisconnectRequest) error {
	return nil
}

type connectedAuthorizationProviderStub struct {
	authorizationProviderStub
}

func (connectedAuthorizationProviderStub) Begin(_ context.Context, request AuthorizationStartRequest) (AuthorizationSession, error) {
	return AuthorizationSession{
		OperationID:  request.OperationID,
		ConnectorKey: request.Connector.Key,
		SessionID:    "session-connected",
		ConnectionID: "existing-cli-login",
		State:        AuthorizationStateConnected,
	}, nil
}

type continuingAuthorizationProviderStub struct {
	authorizationProviderStub
	begins int
}

func (provider *continuingAuthorizationProviderStub) Begin(
	_ context.Context,
	request AuthorizationStartRequest,
) (AuthorizationSession, error) {
	provider.begins++
	authorizationURL := "https://open.feishu.cn/page/cli"
	if provider.begins > 1 {
		authorizationURL = "https://accounts.feishu.cn/device"
	}
	return AuthorizationSession{
		OperationID:      request.OperationID,
		ConnectorKey:     request.Connector.Key,
		SessionID:        request.OperationID + "/credential-broker",
		ActionType:       "redirect",
		AuthorizationURL: authorizationURL,
		State:            AuthorizationStatePending,
	}, nil
}

type countingAuthorizationProvider struct {
	authorizationProviderStub
	disconnects int
}

func (provider *countingAuthorizationProvider) Disconnect(context.Context, AuthorizationDisconnectRequest) error {
	provider.disconnects++
	return nil
}

type observingAuthorizationProvider struct {
	authorizationProviderStub
	observation AuthorizationObservation
}

type countingAuthorizationObserver struct {
	authorizationProviderStub
	observations int
}

func (provider *countingAuthorizationObserver) Observe(context.Context, AuthorizationObserveRequest) (AuthorizationObservation, error) {
	provider.observations++
	return AuthorizationObservation{State: AuthorizationObservationPending}, nil
}

func (provider observingAuthorizationProvider) Observe(context.Context, AuthorizationObserveRequest) (AuthorizationObservation, error) {
	return provider.observation, nil
}

type compatibilityEvaluatorStub struct{}

func (compatibilityEvaluatorStub) Evaluate(Manifest) Compatibility {
	return Compatibility{State: CompatibilityStateSupported}
}

type memoryRepository struct {
	revision                         uint64
	catalogState                     CatalogState
	sourceRevision                   string
	connectors                       map[string]Connector
	operations                       map[string]Operation
	events                           []ChangedEvent
	transactionErr                   error
	transactionCalls                 int
	failTransactionCall              int
	failTransactionErr               error
	renewOperationLeaseErr           error
	rejectCanceledTransactionContext bool
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
		operation.Execution = OperationExecution{}
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

func (repository *memoryRepository) UnresolvedAuthorizationSessionOperations(_ context.Context, scope OperationScope) ([]Operation, error) {
	var operations []Operation
	for _, operation := range repository.operations {
		if operation.Kind == OperationKindStartAuthorization && operation.State == OperationStateCompleted &&
			operation.Scope == scope && operation.Execution.AuthorizationSession != nil &&
			!operation.Execution.AuthorizationSession.IsResolved() {
			operations = append(operations, operation)
		}
	}
	return operations, nil
}

func (repository *memoryRepository) ResolveAuthorizationSession(
	_ context.Context,
	operationID string,
	resolution AuthorizationSessionResolution,
) error {
	operation, ok := repository.operations[operationID]
	if !ok {
		return ErrNotFound
	}
	if operation.Execution.AuthorizationSession != nil && !operation.Execution.AuthorizationSession.IsResolved() {
		operation.Execution.AuthorizationSession.Resolution = resolution
		repository.operations[operationID] = operation
	}
	return nil
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
	if repository.renewOperationLeaseErr != nil {
		return repository.renewOperationLeaseErr
	}
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

func (repository *memoryRepository) Transaction(ctx context.Context, fn func(Transaction) error) error {
	if repository.rejectCanceledTransactionContext && ctx.Err() != nil {
		return ctx.Err()
	}
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
