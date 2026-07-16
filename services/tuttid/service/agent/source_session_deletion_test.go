package agent

import (
	"context"
	"errors"
	"slices"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestServiceDeleteDelegatesToSourceSessionDeletionCoordinatorAndPublishesOnce(t *testing.T) {
	t.Parallel()

	coordinator := &sourceSessionDeletionCoordinatorStub{deleteResult: agentactivitybiz.DeleteSessionsBatchResult{
		RemovedSessions: 2, RemovedSessionIDs: []string{"session-1", "child-1"},
	}}
	events := &sessionDeletionEventPublisherStub{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SourceSessionDeletions = coordinator
	service.SessionDeletionEvents = events

	result, err := service.Delete(context.Background(), " workspace-1 ", " session-1 ")
	if err != nil || !result.Removed {
		t.Fatalf("Delete() removed=%v error=%v", result.Removed, err)
	}
	if coordinator.deleteCalls != 1 || coordinator.deleteWorkspaceID != "workspace-1" || coordinator.deleteSessionID != "session-1" {
		t.Fatalf("coordinator delete = calls %d workspace %q session %q", coordinator.deleteCalls, coordinator.deleteWorkspaceID, coordinator.deleteSessionID)
	}
	if !slices.Equal(events.sessionIDs, []string{"session-1", "child-1"}) {
		t.Fatalf("session deletion events = %#v", events.sessionIDs)
	}
}

func TestServiceDeleteSessionsBatchDelegatesToCoordinatorAndPublishesEachRemovedSessionOnce(t *testing.T) {
	t.Parallel()

	coordinator := &sourceSessionDeletionCoordinatorStub{batchResult: agentactivitybiz.DeleteSessionsBatchResult{
		RemovedMessages:   3,
		RemovedSessions:   2,
		RemovedSessionIDs: []string{"session-1", "child-1", "session-1"},
	}}
	events := &sessionDeletionEventPublisherStub{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SourceSessionDeletions = coordinator
	service.SessionDeletionEvents = events

	result, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{
		SessionIDs: []string{" session-1 "},
	})
	if err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if result.RemovedSessions != 2 || coordinator.batchCalls != 1 || !slices.Equal(coordinator.batchInput.SessionIDs, []string{"session-1"}) {
		t.Fatalf("result=%#v coordinator=%#v", result, coordinator)
	}
	if !slices.Equal(events.sessionIDs, []string{"session-1", "child-1"}) {
		t.Fatalf("session deletion events = %#v", events.sessionIDs)
	}
}

func TestServiceClearDelegatesToCoordinatorAndPublishesEachRemovedSessionOnce(t *testing.T) {
	t.Parallel()

	coordinator := &sourceSessionDeletionCoordinatorStub{clearResult: agentactivitybiz.ClearSessionsResult{
		RemovedMessages:   4,
		RemovedSessions:   2,
		RemovedSessionIDs: []string{"session-1", "session-2"},
	}}
	events := &sessionDeletionEventPublisherStub{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SourceSessionDeletions = coordinator
	service.SessionDeletionEvents = events

	result, err := service.Clear(context.Background(), " workspace-1 ")
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if result.RemovedSessions != 2 || coordinator.clearCalls != 1 || coordinator.clearWorkspaceID != "workspace-1" {
		t.Fatalf("result=%#v coordinator=%#v", result, coordinator)
	}
	if !slices.Equal(events.sessionIDs, []string{"session-1", "session-2"}) {
		t.Fatalf("session deletion events = %#v", events.sessionIDs)
	}
}

func TestServiceDeletionPublishesCommittedInvalidationsBeforeRuntimeCleanupFailure(t *testing.T) {
	t.Parallel()

	cleanupErr := errors.New("cleanup failed")
	tests := []struct {
		name string
		run  func(*Service) error
	}{
		{
			name: "single",
			run: func(service *Service) error {
				_, err := service.Delete(context.Background(), "workspace-1", "session-1")
				return err
			},
		},
		{
			name: "batch",
			run: func(service *Service) error {
				_, err := service.DeleteSessionsBatch(context.Background(), "workspace-1", DeleteSessionsBatchInput{SessionIDs: []string{"session-1"}})
				return err
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			coordinator := &sourceSessionDeletionCoordinatorStub{
				deleteResult: agentactivitybiz.DeleteSessionsBatchResult{RemovedSessions: 1, RemovedSessionIDs: []string{"session-1"}},
				batchResult:  agentactivitybiz.DeleteSessionsBatchResult{RemovedSessions: 1, RemovedSessionIDs: []string{"session-1"}},
			}
			events := &sessionDeletionEventPublisherStub{}
			service := newIsolatedAgentService(newFakeRuntime())
			service.SourceSessionDeletions = coordinator
			service.SessionDeletionEvents = events
			service.RuntimePreparer = failingCleanupPreparer{err: cleanupErr}

			if err := test.run(service); !errors.Is(err, cleanupErr) {
				t.Fatalf("deletion error = %v, want %v", err, cleanupErr)
			}
			if !slices.Equal(events.sessionIDs, []string{"session-1"}) {
				t.Fatalf("session deletion events = %#v, want committed invalidation", events.sessionIDs)
			}
		})
	}
}

type sourceSessionDeletionCoordinatorStub struct {
	deleteResult      agentactivitybiz.DeleteSessionsBatchResult
	deleteErr         error
	deleteCalls       int
	deleteWorkspaceID string
	deleteSessionID   string
	batchResult       agentactivitybiz.DeleteSessionsBatchResult
	batchErr          error
	batchCalls        int
	batchInput        agentactivitybiz.DeleteSessionsBatchInput
	clearResult       agentactivitybiz.ClearSessionsResult
	clearErr          error
	clearCalls        int
	clearWorkspaceID  string
}

func (stub *sourceSessionDeletionCoordinatorStub) DeleteSourceSession(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	stub.deleteCalls++
	stub.deleteWorkspaceID = workspaceID
	stub.deleteSessionID = sessionID
	return stub.deleteResult, stub.deleteErr
}

func (stub *sourceSessionDeletionCoordinatorStub) DeleteSourceSessionsBatch(
	_ context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	stub.batchCalls++
	stub.batchInput = input
	return stub.batchResult, stub.batchErr
}

func (stub *sourceSessionDeletionCoordinatorStub) ClearSourceSessions(
	_ context.Context,
	workspaceID string,
) (agentactivitybiz.ClearSessionsResult, error) {
	stub.clearCalls++
	stub.clearWorkspaceID = workspaceID
	return stub.clearResult, stub.clearErr
}

type sessionDeletionEventPublisherStub struct {
	workspaceIDs []string
	sessionIDs   []string
}

type failingCleanupPreparer struct {
	err error
}

func (failingCleanupPreparer) Prepare(context.Context, runtimeprep.PrepareInput) (runtimeprep.PreparedRuntime, error) {
	return runtimeprep.PreparedRuntime{}, nil
}

func (preparer failingCleanupPreparer) Cleanup(context.Context, runtimeprep.CleanupInput) error {
	return preparer.err
}

func (stub *sessionDeletionEventPublisherStub) PublishSessionDeleted(
	_ context.Context,
	workspaceID string,
	sessionID string,
) {
	stub.workspaceIDs = append(stub.workspaceIDs, workspaceID)
	stub.sessionIDs = append(stub.sessionIDs, sessionID)
}
