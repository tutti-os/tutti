package host

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestEnsureRuntimeDesiredIsLevelTriggeredAndConvergesObservedState(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	first, err := application.EnsureRuntimeDesired(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	second, err := application.EnsureRuntimeDesired(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if first.Desired.Generation != 2 || second.Desired.Generation != 2 || repository.revision != 1 {
		t.Fatalf("desired generations = %d, %d; revision = %d", first.Desired.Generation, second.Desired.Generation, repository.revision)
	}
	if err := application.ConvergeRuntime(context.Background(), OperationScope{}, connector.Key); err != nil {
		t.Fatal(err)
	}
	stored, err := repository.RuntimeConvergence(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Observed.DesiredGeneration != first.Desired.Generation ||
		stored.Observed.BootEpoch != application.config.BootEpoch ||
		stored.Observed.ReleaseDigest != connector.Release.ReleaseDigest ||
		stored.Observed.Readiness.State != RuntimeReadinessReady {
		t.Fatalf("observed convergence = %#v", stored.Observed)
	}
	if runtime.reconciles != 1 || runtime.lastReconcile.Generation.Generation != first.Desired.Generation {
		t.Fatalf("runtime reconciles = %d, request = %#v", runtime.reconciles, runtime.lastReconcile)
	}
	if repository.revision != 2 || len(repository.events) != 2 ||
		repository.events[1].ConnectorKey != connector.Key || repository.events[1].Revision != 2 {
		t.Fatalf("completion projection events = %#v, revision = %d", repository.events, repository.revision)
	}
	due, err := application.DueRuntimeConvergences(context.Background(), OperationScope{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("converged runtime remained due: %#v", due)
	}
}

func TestSetRuntimeEnabledPersistsActivationAcrossReplanning(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	if _, err := application.EnsureRuntimeDesired(context.Background(), OperationScope{}, connector.Key); err != nil {
		t.Fatal(err)
	}
	snapshot, err := application.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	disabled, err := application.SetRuntimeEnabled(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "disable-github", ExpectedRevision: snapshot.Revision},
		ConnectorKey: connector.Key,
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Runtime == nil || disabled.Runtime.State != ConnectorRuntimeStateStopped {
		t.Fatalf("disabled runtime projection = %#v", disabled.Runtime)
	}
	stored, err := repository.RuntimeConvergence(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Desired.ActivationEnabled == nil || *stored.Desired.ActivationEnabled || stored.Desired.Enabled {
		t.Fatalf("disabled desired = %#v", stored.Desired)
	}
	if _, err := application.PlanRuntimeAfterFence(context.Background(), OperationScope{}, connector.Key); err != nil {
		t.Fatal(err)
	}
	stored, err = repository.RuntimeConvergence(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if runtimeActivationEnabled(stored.Desired) || stored.Desired.Enabled {
		t.Fatalf("replanned desired lost activation preference: %#v", stored.Desired)
	}
	snapshot, err = application.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := application.SetRuntimeEnabled(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "enable-github", ExpectedRevision: snapshot.Revision},
		ConnectorKey: connector.Key,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if enabled.Runtime == nil || enabled.Runtime.State != ConnectorRuntimeStateStarting {
		t.Fatalf("enabled runtime projection = %#v", enabled.Runtime)
	}
}

func TestRuntimeConvergenceFailureRemainsRetryableDebt(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	repository := newMemoryRepository(connector)
	runtimeFailure := errors.New("runtime temporarily unavailable")
	runtime := &memoryInstallRuntime{reconcileErrors: map[string]error{connector.Key: runtimeFailure}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	if _, err := application.EnsureRuntimeDesired(context.Background(), OperationScope{}, connector.Key); err != nil {
		t.Fatal(err)
	}
	if err := application.ConvergeRuntime(context.Background(), OperationScope{}, connector.Key); !errors.Is(err, runtimeFailure) {
		t.Fatalf("converge error = %v", err)
	}
	stored, err := repository.RuntimeConvergence(context.Background(), OperationScope{}, connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Attempt != 1 || stored.Observed.DesiredGeneration != 0 || stored.LastErrorCode != string(ErrorCodeInstallFailed) ||
		!stored.NextAttemptAt.After(application.config.Now()) {
		t.Fatalf("retryable convergence = %#v", stored)
	}
	if repository.revision != 2 || len(repository.events) != 2 ||
		repository.events[1].ConnectorKey != connector.Key || repository.events[1].Revision != 2 {
		t.Fatalf("failure projection events = %#v, revision = %d", repository.events, repository.revision)
	}
}

func TestUpdateKeepsCurrentReleaseUntilCandidateRuntimeIsObserved(t *testing.T) {
	connector := testConnector("github")
	oldRelease := connector.Release
	connector.Installation = Installation{
		State: InstallationStateInstalled, InstalledVersion: oldRelease.Version,
		InstalledReleaseID: oldRelease.ReleaseID, InstalledReleaseDigest: oldRelease.ReleaseDigest,
	}
	connector.Release.Version = "2.0.0"
	connector.Release.ReleaseID = "github@2.0.0"
	connector.Release.ReleaseDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	connector.Release.ManifestDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	repository := newMemoryRepository(connector)
	// Retain immutable evidence for the previously committed release.
	repository.operations["old-install"] = Operation{
		OperationID: "old-install", ConnectorKey: connector.Key, Kind: OperationKindInstall,
		State: OperationStateCompleted, Target: &OperationTarget{
			ConnectorKey: connector.Key, ReleaseDigest: oldRelease.ReleaseDigest, Release: &oldRelease,
		},
	}
	runtimeFailure := errors.New("candidate runtime unavailable")
	runtime := &memoryInstallRuntime{reconcileErrors: map[string]error{connector.Key: runtimeFailure}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	now := application.config.Now()
	application.config.Now = func() time.Time { return now }
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "update-github"}, ConnectorKey: connector.Key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); !errors.Is(err, runtimeFailure) {
		t.Fatalf("update error = %v", err)
	}
	during, _ := repository.Connector(context.Background(), connector.Key)
	operation, _ := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if during.Installation.State != InstallationStateUpdating ||
		during.Installation.InstalledReleaseDigest != oldRelease.ReleaseDigest ||
		during.Installation.CandidateReleaseDigest != connector.Release.ReleaseDigest ||
		operation.State != OperationStateRunning || operation.Stage != OperationStageRuntimePending {
		t.Fatalf("update debt lost current/candidate truth: connector=%#v operation=%#v", during, operation)
	}
	delete(runtime.reconcileErrors, connector.Key)
	now = now.Add(10 * time.Second)
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	completed, _ := repository.Connector(context.Background(), connector.Key)
	operation, _ = repository.Operation(context.Background(), accepted.Operation.OperationID)
	if completed.Installation.State != InstallationStateInstalled ||
		completed.Installation.InstalledReleaseDigest != connector.Release.ReleaseDigest ||
		completed.Installation.CandidateReleaseDigest != "" || operation.State != OperationStateCompleted {
		t.Fatalf("update did not promote observed candidate: connector=%#v operation=%#v", completed, operation)
	}
}

func TestAuthorizedUpdateInspectsPreparedCandidateBeforePromotion(t *testing.T) {
	connector := testManagedAuthorizedConnector("lark-cli")
	connector.Authorization = Authorization{State: AuthorizationStateConnected}
	oldRelease := connector.Release
	connector.Release.Version = "2.0.0"
	connector.Release.ReleaseID = "lark-cli@2.0.0"
	connector.Release.ReleaseDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	connector.Release.ManifestDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	repository := newMemoryRepository(connector)
	repository.operations["old-install"] = Operation{
		OperationID: "old-install", ConnectorKey: connector.Key, Kind: OperationKindInstall,
		State: OperationStateCompleted, Target: &OperationTarget{
			ConnectorKey: connector.Key, ReleaseDigest: oldRelease.ReleaseDigest, Release: &oldRelease,
		},
	}
	runtime := &memoryInstallRuntime{}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})
	inspector := &candidateAuthorizationInspector{}
	application.config.Authorization = inspector

	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation: Mutation{ClientRequestID: "update-authorized-lark"}, ConnectorKey: connector.Key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	if len(inspector.requests) != 1 {
		t.Fatalf("authorization inspections = %d, want 1", len(inspector.requests))
	}
	inspected := inspector.requests[0].Connector
	if inspected.Installation.State != InstallationStateUpdating ||
		inspected.Installation.CandidateReleaseDigest != connector.Release.ReleaseDigest ||
		inspected.Release.ReleaseDigest != connector.Release.ReleaseDigest {
		t.Fatalf("inspected candidate connector = %#v", inspected)
	}
	completed, err := repository.Connector(context.Background(), connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Installation.State != InstallationStateInstalled ||
		completed.Installation.InstalledReleaseDigest != connector.Release.ReleaseDigest {
		t.Fatalf("completed authorized update = %#v", completed.Installation)
	}
}

type candidateAuthorizationInspector struct {
	authorizationProviderStub
	requests []AuthorizationInspectRequest
}

func (inspector *candidateAuthorizationInspector) InspectAuthorization(
	_ context.Context,
	request AuthorizationInspectRequest,
) (AuthorizationObservation, error) {
	inspector.requests = append(inspector.requests, request)
	return AuthorizationObservation{
		State: AuthorizationObservationConnected, ConnectorKey: request.Connector.Key,
		ReleaseDigest: request.Connector.Release.ReleaseDigest, ConnectionID: defaultConnectorConnectionID,
	}, nil
}
