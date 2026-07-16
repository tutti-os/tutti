package agentsessionstore

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestSessionActivityReporterAdapterReportsStateAndMessages(t *testing.T) {
	reporter := &fakeSessionActivityReporter{}
	store := NewFileAgentSyncStateStore(t.TempDir())
	adapter := NewSessionActivityReporterAdapter(reporter, WithReporterSyncStateStore(store))

	err := adapter.Report(context.Background(), ReportActivityInput{
		WorkspaceID: "room-1",
		Source: EventSource{
			Provider:      "codex",
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID:  "session-1",
			LifecycleStatus: "active",
			CurrentPhase:    "working",
		}},
		MessageUpdates: []WorkspaceAgentMessageUpdate{
			{AgentSessionID: "session-1", MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text"},
			{AgentSessionID: "session-1", MessageID: "message-2", TurnID: "turn-1", Role: "assistant", Kind: "text"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(reporter.stateInputs) != 1 || reporter.stateInputs[0].AgentSessionID != "session-1" {
		t.Fatalf("state inputs = %#v, want one for session-1", reporter.stateInputs)
	}
	if reporter.stateInputs[0].State.LifecycleStatus != "active" {
		t.Fatalf("state update = %#v", reporter.stateInputs[0].State)
	}
	if len(reporter.messageInputs) != 1 || len(reporter.messageInputs[0].Updates) != 2 {
		t.Fatalf("message inputs = %#v, want one group with two updates", reporter.messageInputs)
	}

	syncStates := adapter.RoomSyncStates("room-1")
	syncState, ok := syncStates["session-1"]
	if !ok {
		t.Fatalf("sync states = %#v, want session-1", syncStates)
	}
	if syncState.Status != WorkspaceAgentSyncStatusSynced {
		t.Fatalf("sync status = %q, want synced", syncState.Status)
	}
	if syncState.PendingStatePatchCount != 0 || syncState.PendingMessageUpdateCount != 0 {
		t.Fatalf("pending counts = %#v, want zero", syncState)
	}
	if syncState.LastSyncedAtUnixMS <= 0 {
		t.Fatalf("last synced = %d, want > 0", syncState.LastSyncedAtUnixMS)
	}

	persisted, err := store.LoadRoomSyncStates(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if persisted["session-1"].Status != WorkspaceAgentSyncStatusSynced {
		t.Fatalf("persisted sync state = %#v, want synced", persisted["session-1"])
	}
}

func TestSessionActivityReporterAdapterMarksFailedAndPersistsLastError(t *testing.T) {
	reporter := &fakeSessionActivityReporter{stateErr: errors.New("controlplane unavailable")}
	store := NewFileAgentSyncStateStore(t.TempDir())
	adapter := NewSessionActivityReporterAdapter(reporter, WithReporterSyncStateStore(store))

	err := adapter.Report(context.Background(), ReportActivityInput{
		WorkspaceID: "room-1",
		Source: EventSource{
			Provider:      "codex",
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID:  "session-1",
			LifecycleStatus: "active",
		}},
	})
	if err == nil {
		t.Fatal("expected report error")
	}

	syncState := adapter.RoomSyncStates("room-1")["session-1"]
	if syncState.Status != WorkspaceAgentSyncStatusFailed {
		t.Fatalf("sync status = %q, want failed", syncState.Status)
	}
	if syncState.LastError != "controlplane unavailable" {
		t.Fatalf("last error = %q", syncState.LastError)
	}
	if syncState.FailedReportCount != 1 {
		t.Fatalf("failed report count = %d, want 1", syncState.FailedReportCount)
	}

	persisted, err := store.LoadRoomSyncStates(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if persisted["session-1"].Status != WorkspaceAgentSyncStatusFailed || persisted["session-1"].LastError == "" {
		t.Fatalf("persisted sync state = %#v, want failed with last error", persisted["session-1"])
	}
}

func TestSessionActivityReporterAdapterSeedsFromPersistedStates(t *testing.T) {
	store := NewFileAgentSyncStateStore(t.TempDir())
	if err := store.SaveAgentSyncState(context.Background(), "room-1", WorkspaceAgentSyncState{
		AgentSessionID:    "session-1",
		Status:            WorkspaceAgentSyncStatusFailed,
		FailedReportCount: 3,
		LastError:         "boom",
	}); err != nil {
		t.Fatal(err)
	}

	adapter := NewSessionActivityReporterAdapter(&fakeSessionActivityReporter{}, WithReporterSyncStateStore(store))
	syncState, ok := adapter.RoomSyncStates("room-1")["session-1"]
	if !ok || syncState.Status != WorkspaceAgentSyncStatusFailed || syncState.FailedReportCount != 3 {
		t.Fatalf("seeded sync state = %#v, ok=%v", syncState, ok)
	}
}

func TestSessionActivityReporterAdapterRejectsMessageUpdateWithoutTurnID(t *testing.T) {
	reporter := &fakeSessionActivityReporter{}
	adapter := NewSessionActivityReporterAdapter(reporter)

	err := adapter.Report(context.Background(), ReportActivityInput{
		WorkspaceID: "room-1",
		Source: EventSource{
			AgentID:       "session-1",
			SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		},
		MessageUpdates: []WorkspaceAgentMessageUpdate{{
			AgentSessionID: "session-1",
			MessageID:      "message-1",
			Role:           "assistant",
			Kind:           "text",
		}},
	})
	if err == nil {
		t.Fatal("expected missing turnId error")
	}
	if len(reporter.stateInputs) != 0 || len(reporter.messageInputs) != 0 {
		t.Fatalf("reporter received inputs despite conversion error: %#v %#v", reporter.stateInputs, reporter.messageInputs)
	}
}

func TestSessionActivityReporterAdapterReportsFirstClassSessionAudit(t *testing.T) {
	reporter := &fakeSessionActivityReporter{}
	adapter := NewSessionActivityReporterAdapter(reporter)
	err := adapter.Report(context.Background(), ReportActivityInput{
		WorkspaceID: "room-1",
		Source:      EventSource{AgentID: "session-1", SessionOrigin: WorkspaceAgentSessionOriginRuntime},
		SessionAudits: []WorkspaceAgentSessionAuditUpdate{{
			AuditID: "goal-control:op-1", Role: "user", Content: "/goal clear", OccurredAtUnixMS: 10,
		}},
	})
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if len(reporter.messageInputs) != 1 || len(reporter.messageInputs[0].Updates) != 1 {
		t.Fatalf("message inputs = %#v", reporter.messageInputs)
	}
	update := reporter.messageInputs[0].Updates[0]
	if update.Kind != "session_audit" || update.TurnID != "" {
		t.Fatalf("audit update = %#v", update)
	}
}

func TestSessionActivityReporterAdapterRequiresWorkspaceID(t *testing.T) {
	adapter := NewSessionActivityReporterAdapter(&fakeSessionActivityReporter{})
	if err := adapter.Report(context.Background(), ReportActivityInput{}); err == nil {
		t.Fatal("expected workspace id error")
	}
}

type fakeSessionActivityReporter struct {
	mu            sync.Mutex
	stateInputs   []ReportSessionStateInput
	messageInputs []ReportSessionMessagesInput
	stateErr      error
	messagesErr   error
}

func (f *fakeSessionActivityReporter) ReportSessionState(
	_ context.Context,
	input ReportSessionStateInput,
) (ReportSessionStateReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stateErr != nil {
		return ReportSessionStateReply{}, f.stateErr
	}
	f.stateInputs = append(f.stateInputs, input)
	return ReportSessionStateReply{Accepted: true, StateApplied: true}, nil
}

func (f *fakeSessionActivityReporter) ReportSessionMessages(
	_ context.Context,
	input ReportSessionMessagesInput,
) (ReportSessionMessagesReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.messagesErr != nil {
		return ReportSessionMessagesReply{}, f.messagesErr
	}
	f.messageInputs = append(f.messageInputs, input)
	return ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}
