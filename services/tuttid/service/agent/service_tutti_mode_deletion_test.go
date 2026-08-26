package agent

import (
	"context"
	"errors"
	"slices"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestDeleteRetryIsIdempotentForMissingSession(t *testing.T) {
	t.Parallel()
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{}}
	coordinator := &fakeTuttiModeActivationCoordinator{}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)

	first, err := service.Delete(context.Background(), "workspace-1", "session-1")
	if err != nil || first.Removed {
		t.Fatalf("first Delete() result=%#v error=%v, want successful no-op", first, err)
	}
	second, err := service.Delete(context.Background(), "workspace-1", "session-1")
	if err != nil || second.Removed {
		t.Fatalf("retry Delete() result=%#v error=%v, want successful no-op", second, err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("cleanup calls = %#v, want none for a missing session", coordinator.deleteSessionIDs)
	}
}

func TestDeleteDoesNotRepeatTuttiModeCleanupAfterSessionStoreRemovedState(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("duplicate activation cleanup must not run")
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {WorkspaceID: "workspace-1", ID: "session-1"},
	}}
	coordinator := &fakeTuttiModeActivationCoordinator{deleteErrors: []error{wantErr}}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	deleteResult, err := service.Delete(context.Background(), "workspace-1", "session-1")
	if err != nil || !deleteResult.Removed {
		t.Fatalf("Delete() removed=%v error=%v", deleteResult.Removed, err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", "session-1")
}

func TestDeleteHostFailureKeepsProviderRuntimeCredentialTracking(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("delete admission rejected")
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {WorkspaceID: "workspace-1", ID: "session-1"},
	}}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.SessionDeletionGuard = &conformanceDeletionGuard{admissionErr: wantErr}
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	if _, err := service.Delete(context.Background(), "workspace-1", "session-1"); !errors.Is(err, wantErr) {
		t.Fatalf("Delete() error = %v, want %v", err, wantErr)
	}
	assertProviderRuntimeCredentialTrackingPresent(t, service, "workspace-1", "session-1")
}

func TestDeleteTerminalNotFoundClearsProviderRuntimeCredentialTracking(t *testing.T) {
	t.Parallel()
	runtime := &fakeRuntime{
		sessions: map[string]ProviderRuntimeSession{
			"workspace-1:session-1": {WorkspaceID: "workspace-1", ID: "session-1"},
		},
		closeErr: ErrSessionNotFound,
	}
	service := NewService(runtime)
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{}}
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	if _, err := service.Delete(context.Background(), "workspace-1", "session-1"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("Delete() error = %v, want %v", err, ErrSessionNotFound)
	}
	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", "session-1")
}

func TestDeleteSessionsBatchDoesNotRepeatCleanupForExpandedChildTree(t *testing.T) {
	t.Parallel()
	reader := &fakeSectionReader{
		fakeSessionReader: fakeSessionReader{sessions: map[string]PersistedSession{}},
		batchDeleteResult: agentactivitybiz.DeleteSessionsBatchResult{
			RemovedSessions:   2,
			RemovedSessionIDs: []string{"root-1", "child-1"},
		},
	}
	coordinator := &fakeTuttiModeActivationCoordinator{}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "root-1")
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "child-1")
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "unrelated-1")

	if _, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{SessionIDs: []string{"root-1"}}); err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", "root-1")
	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", "child-1")
	assertProviderRuntimeCredentialTrackingPresent(t, service, "workspace-1", "unrelated-1")
}

func TestDeleteSessionsBatchCleansRuntimeOnlyOrphanState(t *testing.T) {
	t.Parallel()
	runtime := &fakeRuntime{sessions: map[string]ProviderRuntimeSession{
		"workspace-1:orphan-1": {WorkspaceID: "workspace-1", ID: "orphan-1"},
	}}
	reader := &fakeSectionReader{fakeSessionReader: fakeSessionReader{sessions: map[string]PersistedSession{}}}
	coordinator := &fakeTuttiModeActivationCoordinator{}
	service := NewService(runtime)
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)

	if _, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{SessionIDs: []string{"orphan-1"}}); err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if !slices.Equal(coordinator.deleteSessionIDs, []string{"orphan-1"}) {
		t.Fatalf("orphan cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
}

func TestDeleteSessionsBatchFailureKeepsProviderRuntimeCredentialTracking(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("batch delete failed")
	reader := &fakeSectionReader{
		fakeSessionReader: fakeSessionReader{sessions: map[string]PersistedSession{}},
		batchDeleteErr:    wantErr,
	}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	if _, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{SessionIDs: []string{"session-1"}}); !errors.Is(err, wantErr) {
		t.Fatalf("DeleteSessionsBatch() error = %v, want %v", err, wantErr)
	}
	assertProviderRuntimeCredentialTrackingPresent(t, service, "workspace-1", "session-1")
}

func TestClearDoesNotRepeatTuttiModeCleanupAfterSessionStoreClearedState(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("duplicate activation cleanup must not run")
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {WorkspaceID: "workspace-1", ID: "session-1"},
	}}
	coordinator := &fakeTuttiModeActivationCoordinator{deleteErrors: []error{wantErr}}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	result, err := service.Clear(context.Background(), "workspace-1")
	if err != nil || result.RemovedSessions != 1 {
		t.Fatalf("Clear() result=%#v error=%v", result, err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", "session-1")
}

func TestClearFailureKeepsProviderRuntimeCredentialTracking(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("clear plan failed")
	reader := &fakeSectionReader{
		fakeSessionReader: fakeSessionReader{sessions: map[string]PersistedSession{}},
		clearPlanErr:      wantErr,
	}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	configureTestApplicationHost(service)
	seedProviderRuntimeCredentialTracking(service, "workspace-1", "session-1")

	if _, err := service.Clear(context.Background(), "workspace-1"); !errors.Is(err, wantErr) {
		t.Fatalf("Clear() error = %v, want %v", err, wantErr)
	}
	assertProviderRuntimeCredentialTrackingPresent(t, service, "workspace-1", "session-1")
}

func seedProviderRuntimeCredentialTracking(service *Service, workspaceID, sessionID string) {
	service.InvalidateProviderRuntimeCredentials("cursor")
	service.markProviderRuntimeCredentialsApplied(
		workspaceID,
		sessionID,
		"cursor",
		service.providerRuntimeCredentialGeneration("cursor"),
	)
}

func assertProviderRuntimeCredentialTrackingAbsent(
	t *testing.T,
	service *Service,
	workspaceID string,
	sessionID string,
) {
	t.Helper()
	key := providerRuntimeSessionAuthKey{workspaceID: workspaceID, sessionID: sessionID}
	service.providerRuntimeAuthMu.Lock()
	_, ok := service.providerRuntimeSessionAuth[key]
	service.providerRuntimeAuthMu.Unlock()
	if ok {
		t.Fatalf("provider credential tracking for %s/%s was not removed", workspaceID, sessionID)
	}
}

func assertProviderRuntimeCredentialTrackingPresent(
	t *testing.T,
	service *Service,
	workspaceID string,
	sessionID string,
) {
	t.Helper()
	key := providerRuntimeSessionAuthKey{workspaceID: workspaceID, sessionID: sessionID}
	service.providerRuntimeAuthMu.Lock()
	_, ok := service.providerRuntimeSessionAuth[key]
	service.providerRuntimeAuthMu.Unlock()
	if !ok {
		t.Fatalf("provider credential tracking for %s/%s was unexpectedly removed", workspaceID, sessionID)
	}
}
