package agent

import (
	"context"
	"errors"
	"slices"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestDeleteRetryConvergesTuttiModeCleanupForOrphanState(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("temporary activation cleanup failure")
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{}}
	coordinator := &fakeTuttiModeActivationCoordinator{deleteErrors: []error{wantErr, nil}}
	service := NewService(&fakeRuntime{sessions: map[string]ProviderRuntimeSession{}})
	service.SessionReader = reader
	service.TuttiModeActivations = coordinator
	configureTestApplicationHost(service)

	if _, err := service.Delete(context.Background(), "workspace-1", "session-1"); !errors.Is(err, wantErr) {
		t.Fatalf("first Delete() error = %v", err)
	}
	if _, err := service.Delete(context.Background(), "workspace-1", "session-1"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("retry Delete() error = %v, want ErrSessionNotFound after cleanup", err)
	}
	if !slices.Equal(coordinator.deleteSessionIDs, []string{"session-1", "session-1"}) {
		t.Fatalf("cleanup calls = %#v", coordinator.deleteSessionIDs)
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

	deleteResult, err := service.Delete(context.Background(), "workspace-1", "session-1")
	if err != nil || !deleteResult.Removed {
		t.Fatalf("Delete() removed=%v error=%v", deleteResult.Removed, err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
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

	if _, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{SessionIDs: []string{"root-1"}}); err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
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

	result, err := service.Clear(context.Background(), "workspace-1")
	if err != nil || result.RemovedSessions != 1 {
		t.Fatalf("Clear() result=%#v error=%v", result, err)
	}
	if len(coordinator.deleteSessionIDs) != 0 {
		t.Fatalf("duplicate cleanup calls = %#v", coordinator.deleteSessionIDs)
	}
}
