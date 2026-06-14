//nolint:unused // Retain migrated test fixtures until the next agent-daemon decomposition pass.
package agentsessionstore

import (
	"context"
	"reflect"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func TestStoreTracksRoomsAndClonesState(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom(" room-1 ")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Presences: []WorkspaceAgentPresence{{ID: 1, Provider: "codex"}},
		Sessions:  []WorkspaceAgentSession{{AgentSessionID: "agent-1", EffectiveStatus: "working"}},
	})

	if _, ok := svc.GetAgentState("missing-room"); ok {
		t.Fatal("GetAgentState ok = true for untracked room")
	}

	state, ok := svc.GetAgentState(" room-1 ")
	if !ok {
		t.Fatal("GetAgentState ok = false")
	}
	state.Presences[0].Provider = "mutated"
	state.Sessions[0].AgentSessionID = "mutated"

	state, ok = svc.GetAgentState("room-1")
	if !ok ||
		len(state.Presences) != 1 ||
		state.Presences[0].Provider != "codex" ||
		len(state.Sessions) != 1 ||
		state.Sessions[0].AgentSessionID != "agent-1" {
		t.Fatalf("state after external mutation = %#v, ok=%v", state, ok)
	}

	input := []WorkspaceAgentSession{{AgentSessionID: "agent-2"}}
	inputPresences := []WorkspaceAgentPresence{{ID: 2, Provider: "claude"}}
	svc.updateState("room-1", WorkspaceAgentSnapshot{Presences: inputPresences, Sessions: input})
	inputPresences[0].Provider = "mutated"
	input[0].AgentSessionID = "mutated"

	state, ok = svc.GetAgentState("room-1")
	if !ok ||
		len(state.Presences) != 1 ||
		state.Presences[0].Provider != "claude" ||
		len(state.Sessions) != 1 ||
		state.Sessions[0].AgentSessionID != "agent-2" {
		t.Fatalf("state after input mutation = %#v, ok=%v", state, ok)
	}
}

func TestStoreRefCountRemovesRoomOnlyAfterLastUntrack(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.TrackRoom(" room-1 ")
	svc.TrackRoom(" ")
	svc.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{AgentSessionID: "agent-1"}}})

	if got := svc.listRoomIDs(); !reflect.DeepEqual(got, []string{"room-1"}) {
		t.Fatalf("room ids = %#v", got)
	}

	svc.UntrackRoom("room-1")
	if _, ok := svc.GetAgentState("room-1"); !ok {
		t.Fatal("room removed after first untrack")
	}
	svc.UntrackRoom(" room-1 ")
	if _, ok := svc.GetAgentState("room-1"); ok {
		t.Fatal("room still tracked after final untrack")
	}
}

func TestStoreClearsFailedSyncStateAfterLaterSuccess(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})

	svc.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)
	svc.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)
	svc.MarkActivitySyncFailed("room-1", "agent-1", 1, 0, 0, context.Canceled)
	svc.MarkActivitySyncSucceeded("room-1", "agent-1", 1, 0, 0)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].SyncState == nil {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	syncState := state.Sessions[0].SyncState
	if syncState.Status != WorkspaceAgentSyncStatusSynced {
		t.Fatalf("sync status = %q, want synced", syncState.Status)
	}
	if syncState.PendingTimelineItemCount != 0 {
		t.Fatalf("pending timeline count = %d, want 0", syncState.PendingTimelineItemCount)
	}
	if syncState.PendingStatePatchCount != 0 {
		t.Fatalf("pending state patch count = %d, want 0", syncState.PendingStatePatchCount)
	}
	if syncState.FailedReportCount != 0 {
		t.Fatalf("failed report count = %d, want 0", syncState.FailedReportCount)
	}
	if syncState.LastError != "" {
		t.Fatalf("last error = %q, want empty", syncState.LastError)
	}
}

func TestStoreMarksPendingAfterFailureWhenNextReportStarts(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})

	svc.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)
	svc.MarkActivitySyncFailed("room-1", "agent-1", 1, 0, 0, context.Canceled)
	svc.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].SyncState == nil {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	syncState := state.Sessions[0].SyncState
	if syncState.Status != WorkspaceAgentSyncStatusPending {
		t.Fatalf("sync status = %q, want pending", syncState.Status)
	}
	if syncState.FailedReportCount != 1 {
		t.Fatalf("failed report count = %d, want 1", syncState.FailedReportCount)
	}
	if syncState.LastError != context.Canceled.Error() {
		t.Fatalf("last error = %q, want %q", syncState.LastError, context.Canceled.Error())
	}
}

func TestStoreTracksPendingMessageUpdateCount(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})

	svc.MarkActivitySyncPending("room-1", "agent-1", 0, 0, 2)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].SyncState == nil {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if got := state.Sessions[0].SyncState.PendingMessageUpdateCount; got != 2 {
		t.Fatalf("pending message update count = %d, want 2", got)
	}

	svc.MarkActivitySyncFailed("room-1", "agent-1", 0, 0, 2, context.Canceled)
	state, _ = svc.GetAgentState("room-1")
	if got := state.Sessions[0].SyncState.PendingMessageUpdateCount; got != 2 {
		t.Fatalf("pending message update count after failure = %d, want failed report to remain pending", got)
	}

	svc.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}, {
		AgentSessionID: "agent-2",
	}}})
	svc.MarkActivitySyncPending("room-1", "agent-2", 0, 0, 2)
	svc.MarkActivitySyncSucceeded("room-1", "agent-2", 0, 0, 2)
	state, _ = svc.GetAgentState("room-1")
	if got := state.Sessions[1].SyncState.PendingMessageUpdateCount; got != 0 {
		t.Fatalf("pending message update count after full success = %d, want 0", got)
	}
	if got := state.Sessions[1].SyncState.Status; got != WorkspaceAgentSyncStatusSynced {
		t.Fatalf("sync status = %q, want synced", got)
	}
}

func TestStoreRemoteMessageEchoDoesNotNotifyBusinessUpdate(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	var notifyCount int
	svc.SetUpdateListener(func(string, WorkspaceAgentSnapshot) {
		notifyCount++
	})

	svc.ApplySessionMessages("room-1", EventSource{AgentID: "agent-1"}, "agent-1", []WorkspaceAgentSessionMessageUpdate{{
		MessageID:        "message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "hello"},
		OccurredAtUnixMS: 1000,
	}})
	if notifyCount != 1 {
		t.Fatalf("notify count after local message = %d, want 1", notifyCount)
	}

	svc.appendSessionMessages("room-1", "agent-1", []WorkspaceAgentSessionMessage{{
		ID:               42,
		AgentSessionID:   "agent-1",
		MessageID:        "message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "hello"},
		OccurredAtUnixMS: 1000,
		CreatedAtUnixMS:  1100,
		UpdatedAtUnixMS:  1100,
		Version:          7,
	}}, 7)
	if notifyCount != 1 {
		t.Fatalf("notify count after remote echo = %d, want unchanged", notifyCount)
	}
	reply, ok := svc.ListSessionMessages("room-1", "agent-1", 0, 10)
	if !ok || reply.LatestVersion != 7 || len(reply.Messages) != 1 || reply.Messages[0].Version != 7 {
		t.Fatalf("messages reply = %#v, ok=%v, want cursor metadata applied", reply, ok)
	}

	svc.appendSessionMessages("room-1", "agent-1", []WorkspaceAgentSessionMessage{{
		ID:               43,
		AgentSessionID:   "agent-1",
		MessageID:        "message-2",
		Role:             "user",
		Kind:             "text",
		Payload:          map[string]any{"text": "new"},
		OccurredAtUnixMS: 1200,
		Version:          8,
	}}, 8)
	if notifyCount != 2 {
		t.Fatalf("notify count after new remote message = %d, want 2", notifyCount)
	}
}

func TestStoreRemoteSessionEchoDoesNotNotifyBusinessUpdate(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	var notifyCount int
	svc.SetUpdateListener(func(string, WorkspaceAgentSnapshot) {
		notifyCount++
	})

	svc.ApplySessionState("room-1", EventSource{
		Provider:      "codex",
		AgentID:       "agent-1",
		SessionOrigin: WorkspaceAgentSessionOriginHook,
	}, "agent-1", WorkspaceAgentSessionStateUpdate{
		Provider:         "codex",
		Title:            "Build feature",
		LifecycleStatus:  string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:     string(activityshared.TurnPhaseWorking),
		OccurredAtUnixMS: 1000,
		StartedAtUnixMS:  900,
	})
	if notifyCount != 1 {
		t.Fatalf("notify count after local state = %d, want 1", notifyCount)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	remoteEcho := state.Sessions[0]
	remoteEcho.ID = 99
	svc.updateStateForOrigin("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{remoteEcho},
	}, WorkspaceAgentSessionOriginHook)
	if notifyCount != 1 {
		t.Fatalf("notify count after remote echo = %d, want unchanged", notifyCount)
	}

	remoteEcho.Title = "Updated title"
	remoteEcho.UpdatedAtUnixMS = 1200
	svc.updateStateForOrigin("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{remoteEcho},
	}, WorkspaceAgentSessionOriginHook)
	if notifyCount != 2 {
		t.Fatalf("notify count after changed remote state = %d, want 2", notifyCount)
	}
}

func TestStoreLoadsStoredSyncState(t *testing.T) {
	store := NewFileAgentSyncStateStore(t.TempDir())

	first := New(nil, WithSyncStateStore(store))
	first.TrackRoom("room-1")
	first.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})
	first.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)
	first.MarkActivitySyncFailed("room-1", "agent-1", 1, 0, 0, context.Canceled)

	second := New(nil, WithSyncStateStore(store))
	second.TrackRoom("room-1")
	second.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})

	state, ok := second.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].SyncState == nil {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if got := state.Sessions[0].SyncState.Status; got != WorkspaceAgentSyncStatusFailed {
		t.Fatalf("loaded sync status = %q, want failed", got)
	}
	if got := state.Sessions[0].SyncState.FailedReportCount; got != 1 {
		t.Fatalf("loaded failed report count = %d, want 1", got)
	}
}

func TestStoreLoadsPendingSyncStateAsFailed(t *testing.T) {
	store := NewFileAgentSyncStateStore(t.TempDir())

	first := New(nil, WithSyncStateStore(store))
	first.TrackRoom("room-1")
	first.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})
	first.MarkActivitySyncPending("room-1", "agent-1", 1, 0, 0)

	second := New(nil, WithSyncStateStore(store))
	second.TrackRoom("room-1")
	second.updateState("room-1", WorkspaceAgentSnapshot{Sessions: []WorkspaceAgentSession{{
		AgentSessionID: "agent-1",
	}}})

	state, ok := second.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].SyncState == nil {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	syncState := state.Sessions[0].SyncState
	if syncState.Status != WorkspaceAgentSyncStatusFailed {
		t.Fatalf("loaded sync status = %q, want failed", syncState.Status)
	}
	if syncState.FailedReportCount != 1 {
		t.Fatalf("failed report count = %d, want 1", syncState.FailedReportCount)
	}
}

func TestStoreHideAgentSessionRemovesStateAndMessages(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{AgentSessionID: "agent-1", EffectiveStatus: "working"},
			{AgentSessionID: "agent-2", EffectiveStatus: "ready"},
		},
	})
	svc.ApplySessionMessages("room-1", EventSource{Provider: "codex"}, "agent-1", []WorkspaceAgentSessionMessageUpdate{{
		MessageID: "message-1",
		Role:      "assistant",
		Kind:      "text",
		Status:    "completed",
	}})

	svc.HideAgentSession("room-1", "agent-1")

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].AgentSessionID != "agent-2" {
		t.Fatalf("state after hide = %#v, ok=%v", state, ok)
	}
	messages, ok := svc.GetAgentMessages("room-1", "agent-1")
	if !ok || len(messages.Messages) != 0 {
		t.Fatalf("messages after hide = %#v, ok=%v", messages, ok)
	}

	svc.ApplyEvents("room-1", EventSource{Provider: "codex"}, []activityshared.Event{
		activityshared.NewSessionUpdated(activityshared.EventContext{
			EventID:           "updated",
			Provider:          activityshared.ProviderCodex,
			ProviderSessionID: "provider-1",
			AgentSessionID:    "agent-1",
			OccurredAtUnixMS:  2,
		}, activityshared.SessionStatusWorking),
	})
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{AgentSessionID: "agent-1", EffectiveStatus: "working"},
			{AgentSessionID: "agent-2", EffectiveStatus: "ready"},
		},
	})

	state, ok = svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 || state.Sessions[0].AgentSessionID != "agent-2" {
		t.Fatalf("state after hidden re-ingest = %#v, ok=%v", state, ok)
	}
}

func TestStoreRecordsSessionOwnerOnceFromEventSource(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyEvents("room-1", EventSource{Provider: "codex", UserID: "user-1"}, []activityshared.Event{
		activityshared.NewSessionStarted(activityshared.EventContext{
			EventID:          "started",
			Provider:         activityshared.ProviderCodex,
			AgentSessionID:   "agent-1",
			OccurredAtUnixMS: 1,
		}),
	})
	svc.ApplyEvents("room-1", EventSource{Provider: "codex", UserID: "user-2"}, []activityshared.Event{
		activityshared.NewSessionUpdated(activityshared.EventContext{
			EventID:          "updated",
			Provider:         activityshared.ProviderCodex,
			AgentSessionID:   "agent-1",
			OccurredAtUnixMS: 2,
		}, activityshared.SessionStatusWorking),
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if got := state.Sessions[0].UserID; got != "user-1" {
		t.Fatalf("session owner = %q, want user-1", got)
	}
}

func TestStoreReadyStatePatchClearsWorkingSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "working",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		CurrentPhase:     "ready",
		OccurredAtUnixMS: 1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.EffectiveStatus != string(activityshared.SessionStatusIdle) ||
		session.TurnPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("session = %#v, want ready patch to clear working status", session)
	}
}

func TestStoreNormalizesWaitingStatePatchAliases(t *testing.T) {
	tests := []struct {
		name  string
		phase string
	}{
		{name: "awaiting approval", phase: "awaiting_approval"},
		{name: "waiting approval", phase: "waiting_approval"},
		{name: "waiting input", phase: "waiting_input"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := New(nil)
			svc.TrackRoom("room-1")

			svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
				AgentSessionID:   "agent-1",
				LifecycleStatus:  "active",
				CurrentPhase:     tt.phase,
				OccurredAtUnixMS: 1000,
			}}, nil)

			state, ok := svc.GetAgentState("room-1")
			if !ok || len(state.Sessions) != 1 {
				t.Fatalf("state = %#v, ok=%v", state, ok)
			}
			session := state.Sessions[0]
			if session.EffectiveStatus != "waiting" || session.TurnPhase != tt.phase {
				t.Fatalf("session = %#v, want waiting effective status and phase %q", session, tt.phase)
			}
		})
	}
}

func TestStoreWaitingStatePatchAdvancesSessionUpdatedAt(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "working",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		CurrentPhase:     "waiting_approval",
		OccurredAtUnixMS: 1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.EffectiveStatus != "waiting" ||
		session.TurnPhase != "waiting_approval" ||
		session.UpdatedAtUnixMS != 1000 {
		t.Fatalf("session = %#v, want waiting status with updated_at 1000", session)
	}
}

func TestStoreInfersWorkingStateFromRunningEntityWhenPhaseMissing(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		LifecycleStatus:  "active",
		OccurredAtUnixMS: 1000,
		Entities: []WorkspaceAgentEntityPatch{{
			CallID: "call-1",
			Status: "running",
		}},
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.EffectiveStatus != string(activityshared.SessionStatusWorking) ||
		session.TurnPhase != string(activityshared.TurnPhaseWorking) {
		t.Fatalf("session = %#v, want running entity patch to infer working session state", session)
	}
}

func TestStoreDoesNotClearWorkingStateOnCompletedEntityPatchWithoutPhase(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "working",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		LifecycleStatus:  "active",
		OccurredAtUnixMS: 1000,
		Entities: []WorkspaceAgentEntityPatch{{
			CallID: "call-1",
			Status: "completed",
		}},
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.EffectiveStatus != string(activityshared.SessionStatusWorking) ||
		session.TurnPhase != string(activityshared.TurnPhaseWorking) {
		t.Fatalf("session = %#v, want completed entity patch without phase to preserve working state", session)
	}
}

func TestStoreTreatsCanceledPatchAsTerminalCanceled(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "working",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		LifecycleStatus:  "canceled",
		OccurredAtUnixMS: 1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.LifecycleStatus != "canceled" ||
		session.Status != string(activityshared.SessionStatusCanceled) ||
		session.EffectiveStatus != string(activityshared.SessionStatusCanceled) ||
		session.EndedAtUnixMS != 1000 ||
		session.UpdatedAtUnixMS != 900 {
		t.Fatalf("session = %#v, want canceled patch to become terminal canceled", session)
	}
}

func TestStoreDoesNotNormalizeSessionStatusFromTurnPhase(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "idle",
			EffectiveStatus: "active",
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "active" {
		t.Fatalf("effective status = %q, want active", state.Sessions[0].EffectiveStatus)
	}
}

func TestStoreMapsWaitingTurnPhaseToSessionStatus(t *testing.T) {
	t.Parallel()

	service := New(nil)
	service.TrackRoom("room-1")
	service.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-session",
		AgentID:           "agent-session",
	}, nil, []WorkspaceAgentStatePatch{
		{
			AgentSessionID:    "agent-session",
			Provider:          "codex",
			ProviderSessionID: "provider-session",
			CurrentPhase:      string(activityshared.TurnPhaseWaitingApproval),
			Turn: &WorkspaceAgentTurnPatch{
				TurnID: "turn-1",
				Phase:  string(activityshared.TurnPhaseWaitingApproval),
			},
			OccurredAtUnixMS: 1710000000000,
		},
	}, nil)

	state, ok := service.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok = %v, want one session", state, ok)
	}
	session := state.Sessions[0]
	if session.Status != string(activityshared.SessionStatusWaiting) ||
		session.EffectiveStatus != string(activityshared.SessionStatusWaiting) ||
		session.TurnPhase != string(activityshared.TurnPhaseWaitingApproval) {
		t.Fatalf("session = %#v, want waiting status with waiting approval turn phase", session)
	}
}

func TestStoreAppliesHookStatusEventsImmediately(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyEvents("room-1", EventSource{
		Provider:          "claude-code",
		ProviderSessionID: "provider-session",
		CWD:               "/workspace/room-1",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, []activityshared.Event{
		activityshared.NewSessionStarted(activityshared.EventContext{
			EventID:           "session-started",
			Provider:          activityshared.ProviderClaudeCode,
			ProviderSessionID: "provider-session",
			AgentSessionID:    "agent-session",
			CWD:               "/workspace/room-1",
			OccurredAtUnixMS:  1710000000000,
		}),
		activityshared.NewTurnStarted(activityshared.EventContext{
			EventID:           "turn-started",
			Provider:          activityshared.ProviderClaudeCode,
			ProviderSessionID: "provider-session",
			AgentSessionID:    "agent-session",
			CWD:               "/workspace/room-1",
			OccurredAtUnixMS:  1710000000100,
		}, "turn-1"),
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "working" || state.Sessions[0].TurnPhase != "working" {
		t.Fatalf("running session = %#v, want working immediately", state.Sessions[0])
	}
	if state.Sessions[0].SessionOrigin != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("session origin = %q", state.Sessions[0].SessionOrigin)
	}

	svc.ApplyEvents("room-1", EventSource{}, []activityshared.Event{
		activityshared.NewTurnCompleted(activityshared.EventContext{
			EventID:           "turn-completed",
			Provider:          activityshared.ProviderClaudeCode,
			ProviderSessionID: "provider-session",
			AgentSessionID:    "agent-session",
			CWD:               "/workspace/room-1",
			OccurredAtUnixMS:  1710000000200,
		}, "turn-1", activityshared.TurnOutcomeCompleted),
		activityshared.NewSessionUpdated(activityshared.EventContext{
			EventID:           "session-idle",
			Provider:          activityshared.ProviderClaudeCode,
			ProviderSessionID: "provider-session",
			AgentSessionID:    "agent-session",
			CWD:               "/workspace/room-1",
			OccurredAtUnixMS:  1710000000200,
		}, activityshared.SessionStatusIdle),
	})

	state, ok = svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "idle" || state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("completed session = %#v, want idle immediately", state.Sessions[0])
	}
	if state.Sessions[0].UpdatedAtUnixMS != 1710000000200 {
		t.Fatalf("updated_at = %d, want hook timestamp", state.Sessions[0].UpdatedAtUnixMS)
	}
}

func TestStoreDoesNotAdvanceUpdatedAtForPassiveSessionUpdateEvent(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-session",
			Provider:          "claude-code",
			ProviderSessionID: "provider-session",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
			TurnPhase:         string(activityshared.TurnPhaseIdle),
			EffectiveStatus:   string(activityshared.SessionStatusIdle),
			UpdatedAtUnixMS:   1000,
			Title:             "before",
		}},
	})

	svc.ApplyEvents("room-1", EventSource{
		Provider:          "claude-code",
		ProviderSessionID: "provider-session",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, []activityshared.Event{
		activityshared.NewSessionUpdated(activityshared.EventContext{
			EventID:           "session-idle",
			Provider:          activityshared.ProviderClaudeCode,
			ProviderSessionID: "provider-session",
			AgentSessionID:    "agent-session",
			OccurredAtUnixMS:  1100,
		}, activityshared.SessionStatusIdle),
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.UpdatedAtUnixMS != 1000 {
		t.Fatalf("updated_at = %d, want existing timestamp 1000", session.UpdatedAtUnixMS)
	}
	if session.EffectiveStatus != string(activityshared.SessionStatusIdle) ||
		session.TurnPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("session = %#v, want idle status preserved", session)
	}
}

func TestStoreAppliesTerminalStatePatchesWithEndTime(t *testing.T) {
	tests := []struct {
		name                string
		activity            ReportActivityInput
		wantLifecycleStatus string
		wantEffectiveStatus string
		wantTurnPhase       string
		wantEndedAtUnixMS   int64
	}{
		{
			name: "completed event patch keeps completed status despite idle phase",
			activity: ReportActivityInput{
				WorkspaceID: "room-1",
				Source: EventSource{
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				},
				StatePatches: []WorkspaceAgentStatePatch{{
					AgentSessionID:    "agent-session",
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					LifecycleStatus:   string(activityshared.SessionStatusCompleted),
					CurrentPhase:      string(activityshared.TurnPhaseIdle),
					OccurredAtUnixMS:  1710000000100,
				}},
			},
			wantLifecycleStatus: string(activityshared.SessionStatusCompleted),
			wantEffectiveStatus: string(activityshared.SessionStatusCompleted),
			wantTurnPhase:       string(activityshared.TurnPhaseIdle),
			wantEndedAtUnixMS:   1710000000100,
		},
		{
			name: "failed patch keeps failed status despite idle phase",
			activity: ReportActivityInput{
				WorkspaceID: "room-1",
				Source: EventSource{
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				},
				StatePatches: []WorkspaceAgentStatePatch{{
					AgentSessionID:    "agent-session",
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					LifecycleStatus:   string(activityshared.SessionLifecycleStatusFailed),
					CurrentPhase:      string(activityshared.TurnPhaseIdle),
					OccurredAtUnixMS:  1710000000200,
				}},
			},
			wantLifecycleStatus: string(activityshared.SessionLifecycleStatusFailed),
			wantEffectiveStatus: string(activityshared.SessionStatusFailed),
			wantTurnPhase:       string(activityshared.TurnPhaseIdle),
			wantEndedAtUnixMS:   1710000000200,
		},
		{
			name: "failed turn patch records turn end time without ending session lifecycle",
			activity: ReportActivityInput{
				WorkspaceID: "room-1",
				Source: EventSource{
					Provider:          "claude-code",
					ProviderSessionID: "provider-session",
					SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				},
				StatePatches: []WorkspaceAgentStatePatch{{
					AgentSessionID:    "agent-session",
					Provider:          "claude-code",
					ProviderSessionID: "provider-session",
					CurrentPhase:      string(activityshared.TurnPhaseFailed),
					OccurredAtUnixMS:  1710000000250,
					Turn: &WorkspaceAgentTurnPatch{
						TurnID: "turn-1",
						Phase:  string(activityshared.TurnPhaseFailed),
					},
				}},
			},
			wantLifecycleStatus: string(activityshared.SessionLifecycleStatusActive),
			wantEffectiveStatus: string(activityshared.SessionStatusFailed),
			wantTurnPhase:       string(activityshared.TurnPhaseFailed),
			wantEndedAtUnixMS:   1710000000250,
		},
		{
			name: "completed patch prefers explicit completed time",
			activity: ReportActivityInput{
				WorkspaceID: "room-1",
				Source: EventSource{
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				},
				StatePatches: []WorkspaceAgentStatePatch{{
					AgentSessionID:    "agent-session",
					Provider:          "codex",
					ProviderSessionID: "provider-session",
					LifecycleStatus:   string(activityshared.SessionLifecycleStatusEnded),
					CurrentPhase:      string(activityshared.TurnPhaseIdle),
					OccurredAtUnixMS:  1710000000300,
					Turn: &WorkspaceAgentTurnPatch{
						TurnID:            "turn-1",
						CompletedAtUnixMS: 1710000000350,
					},
				}},
			},
			wantLifecycleStatus: string(activityshared.SessionLifecycleStatusEnded),
			wantEffectiveStatus: string(activityshared.SessionStatusCompleted),
			wantTurnPhase:       string(activityshared.TurnPhaseIdle),
			wantEndedAtUnixMS:   1710000000350,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := New(nil)
			svc.TrackRoom("room-1")

			svc.ApplyActivity("room-1", tt.activity.Source, tt.activity.TimelineItems, tt.activity.StatePatches, tt.activity.MessageUpdates)

			state, ok := svc.GetAgentState("room-1")
			if !ok || len(state.Sessions) != 1 {
				t.Fatalf("state = %#v, ok=%v", state, ok)
			}
			session := state.Sessions[0]
			if session.LifecycleStatus != tt.wantLifecycleStatus ||
				session.EffectiveStatus != tt.wantEffectiveStatus ||
				session.TurnPhase != tt.wantTurnPhase ||
				session.EndedAtUnixMS != tt.wantEndedAtUnixMS {
				t.Fatalf("session = %#v, want lifecycle=%q effective=%q phase=%q ended_at=%d",
					session,
					tt.wantLifecycleStatus,
					tt.wantEffectiveStatus,
					tt.wantTurnPhase,
					tt.wantEndedAtUnixMS,
				)
			}
		})
	}
}

func TestStoreKeepsNewerLocalIdleAgainstStaleWorkingSync(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})
	svc.markSessionIdle("room-1", "agent-1", 1000)

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "idle" || state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("session regressed to stale working state: %#v", state.Sessions[0])
	}
	if state.Sessions[0].UpdatedAtUnixMS != 1000 {
		t.Fatalf("updated_at = %d, want local idle timestamp 1000", state.Sessions[0].UpdatedAtUnixMS)
	}
}

func TestStoreStoresMessageUpdatesForLocalReads(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyActivity("room-1", EventSource{AgentID: "agent-session-1"}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID: "agent-session-1",
		MessageID:      "message-2",
		Seq:            2,
		Role:           "assistant",
		Kind:           "text",
		Status:         "streaming",
		Payload:        map[string]any{"text": "working"},
	}, {
		AgentSessionID: "agent-session-1",
		MessageID:      "message-1",
		Seq:            1,
		Role:           "user",
		Kind:           "text",
		Payload:        map[string]any{"text": "hello"},
	}})
	svc.ApplyActivity("room-1", EventSource{AgentID: "agent-session-1"}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:    "agent-session-1",
		MessageID:         "message-2",
		Seq:               99,
		Role:              "assistant",
		Kind:              "text",
		Status:            "completed",
		Payload:           map[string]any{"text": "done"},
		CompletedAtUnixMS: 1710000000003,
	}})

	messages, ok := svc.GetAgentMessages("room-1", "agent-session-1")
	if !ok {
		t.Fatal("GetAgentMessages() ok = false, want true")
	}
	if len(messages.Messages) != 2 {
		t.Fatalf("messages = %#v, want 2", messages.Messages)
	}
	if messages.Messages[0].MessageID != "message-1" || messages.Messages[0].Seq != 1 {
		t.Fatalf("first message = %#v, want message-1 seq 1", messages.Messages[0])
	}
	if messages.Messages[1].MessageID != "message-2" || messages.Messages[1].Seq != 2 || messages.Messages[1].Status != "completed" {
		t.Fatalf("second message = %#v, want completed message-2 preserving first seq 2", messages.Messages[1])
	}
	if messages.Messages[1].Payload["text"] != "done" || messages.Messages[1].CompletedAtUnixMS != 1710000000003 {
		t.Fatalf("merged message = %#v", messages.Messages[1])
	}
	messages.Messages[1].Payload["text"] = "mutated"

	messages, _ = svc.GetAgentMessages("room-1", "agent-session-1")
	if messages.Messages[1].Payload["text"] != "done" {
		t.Fatalf("cached message payload was mutated through caller: %#v", messages.Messages[1].Payload)
	}
}

func TestStoreAppliesSessionStateForLocalReads(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplySessionState("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		AgentID:           "agent-session-1",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
		UserID:            "user-1",
	}, "agent-session-1", WorkspaceAgentSessionStateUpdate{
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Model:             "gpt-5",
		CWD:               "/workspace",
		Title:             "Working",
		LifecycleStatus:   "active",
		CurrentPhase:      "coding",
		OccurredAtUnixMS:  1710000000001,
		StartedAtUnixMS:   1710000000000,
		EndedAtUnixMS:     1710000000002,
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v, want one session", state, ok)
	}
	session := state.Sessions[0]
	if session.AgentSessionID != "agent-session-1" || session.UserID != "user-1" ||
		session.Provider != "codex" || session.ProviderSessionID != "provider-session-1" ||
		session.SessionOrigin != WorkspaceAgentSessionOriginRuntime || session.Title != "Working" ||
		session.TurnPhase != "coding" || session.EffectiveStatus != "idle" {
		t.Fatalf("session = %#v", session)
	}
	if session.StartedAtUnixMS != 1710000000000 || session.EndedAtUnixMS != 1710000000002 {
		t.Fatalf("session times = %d/%d, want 1710000000000/1710000000002", session.StartedAtUnixMS, session.EndedAtUnixMS)
	}
}

func TestStoreAppliesSessionMessagesForLocalReads(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplySessionMessages("room-1", EventSource{
		AgentID:       "agent-session-1",
		SessionOrigin: WorkspaceAgentSessionOriginRuntime,
	}, "agent-session-1", []WorkspaceAgentSessionMessageUpdate{{
		MessageID:        "message-1",
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "streaming",
		Payload:          map[string]any{"text": "hel"},
		OccurredAtUnixMS: 1710000000001,
	}})
	svc.ApplySessionMessages("room-1", EventSource{
		AgentID:       "agent-session-1",
		SessionOrigin: WorkspaceAgentSessionOriginRuntime,
	}, "agent-session-1", []WorkspaceAgentSessionMessageUpdate{{
		MessageID:         "message-1",
		Status:            "completed",
		Payload:           map[string]any{"text": "hello"},
		CompletedAtUnixMS: 1710000000002,
	}})

	messages, ok := svc.GetAgentMessages("room-1", "agent-session-1")
	if !ok || len(messages.Messages) != 1 {
		t.Fatalf("messages = %#v, ok=%v, want one message", messages, ok)
	}
	message := messages.Messages[0]
	if message.AgentSessionID != "agent-session-1" || message.MessageID != "message-1" ||
		message.TurnID != "turn-1" || message.Role != "assistant" || message.Kind != "text" ||
		message.Status != "completed" || message.CompletedAtUnixMS != 1710000000002 {
		t.Fatalf("message = %#v", message)
	}
	if message.Seq != 0 || message.CallID != "" || message.Title != "" {
		t.Fatalf("new session message leaked old top-level fields: %#v", message)
	}
	if message.Payload["text"] != "hello" {
		t.Fatalf("payload = %#v", message.Payload)
	}
}

func TestStoreBuildsSnapshotMessagesFromCanonicalSessionMessages(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyActivity("room-1", EventSource{AgentID: "agent-session-1"}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:    "agent-session-1",
		MessageID:         "toolcall:call-1",
		Seq:               2,
		TurnID:            "turn-1",
		Role:              "assistant",
		Kind:              "tool_call",
		Status:            "running",
		CallID:            "call-1",
		Title:             "Bash",
		Payload:           map[string]any{"toolName": "Bash", "input": map[string]any{"command": "pwd"}},
		OccurredAtUnixMS:  1710000000002,
		StartedAtUnixMS:   1710000000002,
		CompletedAtUnixMS: 0,
	}})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	sessionMessages := snapshot.SessionMessagesByID["agent-session-1"]
	if len(sessionMessages) != 1 {
		t.Fatalf("SessionMessagesByID = %#v, want one message", snapshot.SessionMessagesByID)
	}
	message := sessionMessages[0]
	if message.AgentSessionID != "agent-session-1" || message.MessageID != "toolcall:call-1" ||
		message.Version != 2 || message.Status != "running" {
		t.Fatalf("snapshot message = %#v", message)
	}
	if message.Payload["toolName"] != "Bash" || message.Payload["callId"] != "call-1" || message.Payload["title"] != "Bash" {
		t.Fatalf("snapshot payload = %#v, want preserved legacy metadata in canonical payload", message.Payload)
	}
}

func TestStoreAppliesProviderOnlyMessageUpdateToExistingSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "runtime-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:   "provider-1",
		MessageID:        "approval-1",
		Role:             "assistant",
		Kind:             "tool_call",
		Status:           "waiting",
		Payload:          map[string]any{"toolName": "Bash"},
		OccurredAtUnixMS: 1000,
	}})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if _, ok := snapshot.SessionMessagesByID["provider-1"]; ok {
		t.Fatalf("provider bucket = %#v, want no alias message bucket", snapshot.SessionMessagesByID["provider-1"])
	}
	messages := snapshot.SessionMessagesByID["runtime-1"]
	if len(messages) != 1 {
		t.Fatalf("runtime messages = %#v, want one canonical message", snapshot.SessionMessagesByID)
	}
	if messages[0].AgentSessionID != "runtime-1" || messages[0].MessageID != "approval-1" {
		t.Fatalf("message = %#v, want canonical runtime session id", messages[0])
	}
}

func TestStoreMigratesProviderMessageBucketWhenSessionMetadataArrives(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
	}, nil, nil, []WorkspaceAgentMessageUpdate{{
		MessageID:        "approval-1",
		Role:             "assistant",
		Kind:             "tool_call",
		Status:           "waiting",
		Payload:          map[string]any{"toolName": "Bash"},
		OccurredAtUnixMS: 1000,
	}})
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "runtime-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
		}},
	})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if _, ok := snapshot.SessionMessagesByID["provider-1"]; ok {
		t.Fatalf("provider bucket = %#v, want migrated message bucket", snapshot.SessionMessagesByID["provider-1"])
	}
	messages := snapshot.SessionMessagesByID["runtime-1"]
	if len(messages) != 1 || messages[0].AgentSessionID != "runtime-1" {
		t.Fatalf("runtime messages = %#v, want migrated canonical message", messages)
	}
}

func TestStoreAppliesProviderOnlyMessageUpdateToSameOriginSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "runtime-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			},
			{
				AgentSessionID:    "hook-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
			},
		},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		SessionOrigin:     WorkspaceAgentSessionOriginHook,
	}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:   "provider-1",
		MessageID:        "hook-message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "hook"},
		OccurredAtUnixMS: 1000,
	}})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if _, ok := snapshot.SessionMessagesByID["provider-1"]; ok {
		t.Fatalf("provider bucket = %#v, want no alias message bucket", snapshot.SessionMessagesByID["provider-1"])
	}
	if len(snapshot.SessionMessagesByID["runtime-1"]) != 0 {
		t.Fatalf("runtime messages = %#v, want untouched runtime session", snapshot.SessionMessagesByID["runtime-1"])
	}
	messages := snapshot.SessionMessagesByID["hook-1"]
	if len(messages) != 1 || messages[0].AgentSessionID != "hook-1" || messages[0].MessageID != "hook-message-1" {
		t.Fatalf("hook messages = %#v, want provider-only message on hook session", messages)
	}
}

func TestStoreKeepsProviderOnlyMessageUpdateAmbiguousWithoutOrigin(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "runtime-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			},
			{
				AgentSessionID:    "hook-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
			},
		},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
	}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:   "provider-1",
		MessageID:        "ambiguous-message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "ambiguous"},
		OccurredAtUnixMS: 1000,
	}})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if len(snapshot.SessionMessagesByID["runtime-1"]) != 0 || len(snapshot.SessionMessagesByID["hook-1"]) != 0 {
		t.Fatalf("canonical buckets = %#v, want ambiguous message left unmapped", snapshot.SessionMessagesByID)
	}
	messages := snapshot.SessionMessagesByID["provider-1"]
	if len(messages) != 1 || messages[0].AgentSessionID != "provider-1" {
		t.Fatalf("provider messages = %#v, want conservative alias bucket", messages)
	}
}

func TestStoreKeepsProviderOnlyMessageUpdateForDifferentProvider(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "codex-session-1",
			Provider:          "codex",
			ProviderSessionID: "shared-provider-session",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "claude",
		ProviderSessionID: "shared-provider-session",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:   "shared-provider-session",
		MessageID:        "claude-message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "claude"},
		OccurredAtUnixMS: 1000,
	}})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if len(snapshot.SessionMessagesByID["codex-session-1"]) != 0 {
		t.Fatalf("codex messages = %#v, want provider mismatch not attached", snapshot.SessionMessagesByID["codex-session-1"])
	}
	messages := snapshot.SessionMessagesByID["shared-provider-session"]
	if len(messages) != 1 || messages[0].AgentSessionID != "shared-provider-session" {
		t.Fatalf("provider messages = %#v, want conservative alias bucket for provider mismatch", messages)
	}
}

func TestStoreIgnoresSnapshotTimelineDetailsWhenUpdatingState(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-session-1",
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
		SessionTimelineByID: map[string][]WorkspaceAgentTimelineItem{
			"agent-session-1": {{
				ID:             7,
				AgentSessionID: "agent-session-1",
				EventID:        "timeline-1",
				ItemType:       "message.assistant",
			}},
		},
	})

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("GetAgentSnapshot() ok = false, want true")
	}
	if len(snapshot.SessionTimelineByID) != 0 {
		t.Fatalf("snapshot timeline = %#v, want snapshot timeline details ignored", snapshot.SessionTimelineByID)
	}
	if len(snapshot.Sessions) != 1 || snapshot.Sessions[0].AgentSessionID != "agent-session-1" {
		t.Fatalf("snapshot sessions = %#v, want state preserved", snapshot.Sessions)
	}
}

func TestStoreMergesToolMessageUpdatePayloadsForLocalReads(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.ApplyActivity("room-1", EventSource{AgentID: "agent-session-1"}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:   "agent-session-1",
		MessageID:        "toolcall:call-1",
		Seq:              2,
		Role:             "assistant",
		Kind:             "tool_call",
		Status:           "running",
		CallID:           "call-1",
		Title:            "Bash",
		Payload:          map[string]any{"name": "Bash", "toolName": "Bash", "input": map[string]any{"command": "pwd"}},
		StartedAtUnixMS:  1710000000002,
		OccurredAtUnixMS: 1710000000002,
	}})
	svc.ApplyActivity("room-1", EventSource{AgentID: "agent-session-1"}, nil, nil, []WorkspaceAgentMessageUpdate{{
		AgentSessionID:    "agent-session-1",
		MessageID:         "toolcall:call-1",
		Seq:               3,
		Role:              "assistant",
		Kind:              "tool_call",
		Status:            "completed",
		CallID:            "call-1",
		Title:             "Bash",
		Payload:           map[string]any{"status": "completed", "output": map[string]any{"stdout": "/workspace\n"}},
		CompletedAtUnixMS: 1710000000003,
		OccurredAtUnixMS:  1710000000003,
	}})

	messages, ok := svc.GetAgentMessages("room-1", "agent-session-1")
	if !ok || len(messages.Messages) != 1 {
		t.Fatalf("messages = %#v, ok=%v, want one message", messages.Messages, ok)
	}
	message := messages.Messages[0]
	if message.Seq != 2 || message.Status != "completed" || message.StartedAtUnixMS != 1710000000002 || message.CompletedAtUnixMS != 1710000000003 {
		t.Fatalf("merged tool message metadata = %#v", message)
	}
	input, _ := message.Payload["input"].(map[string]any)
	output, _ := message.Payload["output"].(map[string]any)
	if input["command"] != "pwd" || output["stdout"] != "/workspace\n" || message.Payload["toolName"] != "Bash" {
		t.Fatalf("merged tool payload = %#v, want input, output, and toolName", message.Payload)
	}
}

func TestStoreKeepsLocalIdleAgainstPassiveSessionUpdateSync(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})
	svc.markSessionIdle("room-1", "agent-1", 1000)

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "updated",
			EffectiveStatus:   "active",
			UpdatedAtUnixMS:   1100,
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "idle" || state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("session regressed to passive active update: %#v", state.Sessions[0])
	}
	if state.Sessions[0].UpdatedAtUnixMS != 1000 {
		t.Fatalf("updated_at = %d, want local idle timestamp 1000", state.Sessions[0].UpdatedAtUnixMS)
	}
}

func TestStoreAllowsNewerWorkingSyncAfterLocalIdle(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})
	svc.markSessionIdle("room-1", "agent-1", 1000)

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "nexight-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   1100,
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "working" || state.Sessions[0].TurnPhase != "working" {
		t.Fatalf("newer working sync was not applied: %#v", state.Sessions[0])
	}
}

func TestStoreKeepsLocalTerminalAgainstStaleActiveSync(t *testing.T) {
	tests := []struct {
		name                string
		patch               WorkspaceAgentStatePatch
		wantLifecycleStatus string
		wantEffectiveStatus string
		wantEndedAtUnixMS   int64
	}{
		{
			name: "completed",
			patch: WorkspaceAgentStatePatch{
				AgentSessionID:   "agent-1",
				LifecycleStatus:  string(activityshared.SessionLifecycleStatusEnded),
				CurrentPhase:     string(activityshared.TurnPhaseIdle),
				OccurredAtUnixMS: 1000,
			},
			wantLifecycleStatus: string(activityshared.SessionLifecycleStatusEnded),
			wantEffectiveStatus: string(activityshared.SessionStatusCompleted),
			wantEndedAtUnixMS:   1000,
		},
		{
			name: "failed",
			patch: WorkspaceAgentStatePatch{
				AgentSessionID:   "agent-1",
				LifecycleStatus:  string(activityshared.SessionLifecycleStatusFailed),
				CurrentPhase:     string(activityshared.TurnPhaseIdle),
				OccurredAtUnixMS: 1000,
			},
			wantLifecycleStatus: string(activityshared.SessionLifecycleStatusFailed),
			wantEffectiveStatus: string(activityshared.SessionStatusFailed),
			wantEndedAtUnixMS:   1000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := New(nil)
			svc.TrackRoom("room-1")
			svc.updateState("room-1", WorkspaceAgentSnapshot{
				Sessions: []WorkspaceAgentSession{{
					AgentSessionID:  "agent-1",
					LifecycleStatus: "active",
					TurnPhase:       "working",
					EffectiveStatus: "working",
					UpdatedAtUnixMS: 900,
				}},
			})
			svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{tt.patch}, nil)

			svc.updateState("room-1", WorkspaceAgentSnapshot{
				Sessions: []WorkspaceAgentSession{{
					AgentSessionID:  "agent-1",
					LifecycleStatus: "active",
					TurnPhase:       "working",
					EffectiveStatus: "working",
					UpdatedAtUnixMS: 900,
				}},
			})

			state, ok := svc.GetAgentState("room-1")
			if !ok || len(state.Sessions) != 1 {
				t.Fatalf("state = %#v, ok=%v", state, ok)
			}
			session := state.Sessions[0]
			if session.LifecycleStatus != tt.wantLifecycleStatus ||
				session.EffectiveStatus != tt.wantEffectiveStatus ||
				session.TurnPhase != string(activityshared.TurnPhaseIdle) ||
				session.EndedAtUnixMS != tt.wantEndedAtUnixMS ||
				session.UpdatedAtUnixMS != 900 {
				t.Fatalf("session = %#v, want terminal state with ended_at %d", session, tt.wantEndedAtUnixMS)
			}
		})
	}
}

func TestStoreKeepsLocalFailedTurnAgainstStaleWorkingSync(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "claude-code",
			ProviderSessionID: "provider-session",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
			TurnPhase:         string(activityshared.TurnPhaseWorking),
			EffectiveStatus:   string(activityshared.SessionStatusWorking),
			StartedAtUnixMS:   1000,
			UpdatedAtUnixMS:   1000,
		}},
	})
	svc.ApplyActivity("room-1", EventSource{
		Provider:          "claude-code",
		ProviderSessionID: "provider-session",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:    "agent-1",
		Provider:          "claude-code",
		ProviderSessionID: "provider-session",
		CurrentPhase:      string(activityshared.TurnPhaseFailed),
		OccurredAtUnixMS:  1100,
		Turn: &WorkspaceAgentTurnPatch{
			TurnID: "turn-1",
			Phase:  string(activityshared.TurnPhaseFailed),
		},
	}}, nil)

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "claude-code",
			ProviderSessionID: "provider-session",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
			TurnPhase:         string(activityshared.TurnPhaseWorking),
			EffectiveStatus:   string(activityshared.SessionStatusWorking),
			StartedAtUnixMS:   1000,
			UpdatedAtUnixMS:   1200,
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.LifecycleStatus != string(activityshared.SessionLifecycleStatusActive) ||
		session.EffectiveStatus != string(activityshared.SessionStatusFailed) ||
		session.TurnPhase != string(activityshared.TurnPhaseFailed) ||
		session.EndedAtUnixMS != 1100 ||
		session.UpdatedAtUnixMS != 1100 {
		t.Fatalf("session = %#v, want local failed turn to win over stale upstream working", session)
	}
}

func TestStoreAllowsNewerSyncAfterLocalTerminal(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.ApplyActivity("room-1", EventSource{}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:   "agent-1",
		LifecycleStatus:  string(activityshared.SessionLifecycleStatusEnded),
		CurrentPhase:     string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS: 1000,
	}}, nil)

	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-1",
			LifecycleStatus: "active",
			TurnPhase:       "working",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 1100,
		}},
	})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].EffectiveStatus != "working" || state.Sessions[0].TurnPhase != "working" || state.Sessions[0].EndedAtUnixMS != 0 {
		t.Fatalf("newer sync was not applied: %#v", state.Sessions[0])
	}
}

func TestStoreAppliesProviderOnlyStatePatchToExistingSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{Provider: "codex", ProviderSessionID: "provider-1"}, nil, []WorkspaceAgentStatePatch{{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		LifecycleStatus:   string(activityshared.SessionLifecycleStatusEnded),
		CurrentPhase:      string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS:  1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.AgentSessionID != "agent-1" {
		t.Fatalf("agent session id = %q, want agent-1", session.AgentSessionID)
	}
	if session.ProviderSessionID != "provider-1" {
		t.Fatalf("provider session id = %q, want provider-1", session.ProviderSessionID)
	}
	if session.LifecycleStatus != string(activityshared.SessionLifecycleStatusEnded) ||
		session.EffectiveStatus != string(activityshared.SessionStatusCompleted) ||
		session.TurnPhase != string(activityshared.TurnPhaseIdle) ||
		session.EndedAtUnixMS != 1000 ||
		session.UpdatedAtUnixMS != 900 {
		t.Fatalf("session = %#v, want completed session without recency bump from provider-only patch", session)
	}
}

func TestStoreKeepsProviderOnlyStatePatchForDifferentProvider(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "codex-session-1",
			Provider:          "codex",
			ProviderSessionID: "shared-provider-session",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "claude",
		ProviderSessionID: "shared-provider-session",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:    "shared-provider-session",
		Provider:          "claude",
		ProviderSessionID: "shared-provider-session",
		LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:      string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS:  1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v, want distinct provider sessions", state, ok)
	}

	var codexSession *WorkspaceAgentSession
	var claudeSession *WorkspaceAgentSession
	for i := range state.Sessions {
		session := &state.Sessions[i]
		switch session.AgentSessionID {
		case "codex-session-1":
			codexSession = session
		case "shared-provider-session":
			claudeSession = session
		}
	}
	if codexSession == nil || codexSession.Provider != "codex" || codexSession.EffectiveStatus != "working" {
		t.Fatalf("codex session = %#v, want untouched codex session", codexSession)
	}
	if claudeSession == nil || claudeSession.Provider != "claude" || claudeSession.ProviderSessionID != "shared-provider-session" {
		t.Fatalf("claude session = %#v, want separate provider session", claudeSession)
	}
}

func TestStoreDoesNotAdvanceUpdatedAtForPassiveIdleStatePatch(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
			TurnPhase:         string(activityshared.TurnPhaseIdle),
			EffectiveStatus:   string(activityshared.SessionStatusIdle),
			UpdatedAtUnixMS:   1000,
			Title:             "before",
		}},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
	}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:    "agent-1",
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		CurrentPhase:      string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS:  1100,
		Title:             "after",
	}})

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	session := state.Sessions[0]
	if session.Title != "after" {
		t.Fatalf("title = %q, want after", session.Title)
	}
	if session.UpdatedAtUnixMS != 1000 {
		t.Fatalf("updated_at = %d, want existing timestamp 1000", session.UpdatedAtUnixMS)
	}
	if session.EffectiveStatus != string(activityshared.SessionStatusIdle) ||
		session.TurnPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("session = %#v, want idle status preserved", session)
	}
}

func TestStoreSeparatesHookAndRuntimeSessionsWithSameProviderSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:    "runtime-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			UpdatedAtUnixMS:   900,
		}},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		SessionOrigin:     WorkspaceAgentSessionOriginHook,
	}, nil, []WorkspaceAgentStatePatch{{
		AgentSessionID:    "provider-1",
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:      string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS:  1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}

	var runtimeSession *WorkspaceAgentSession
	var hookSession *WorkspaceAgentSession
	for i := range state.Sessions {
		session := &state.Sessions[i]
		switch session.AgentSessionID {
		case "runtime-1":
			runtimeSession = session
		case "provider-1":
			hookSession = session
		}
	}
	if runtimeSession == nil || hookSession == nil {
		t.Fatalf("sessions = %#v, want distinct runtime and hook sessions", state.Sessions)
	}
	if runtimeSession.SessionOrigin != WorkspaceAgentSessionOriginRuntime || runtimeSession.EffectiveStatus != "working" {
		t.Fatalf("runtime session = %#v, want unchanged runtime working session", *runtimeSession)
	}
	if hookSession.SessionOrigin != WorkspaceAgentSessionOriginHook ||
		hookSession.ProviderSessionID != "provider-1" ||
		hookSession.EffectiveStatus != string(activityshared.SessionStatusIdle) ||
		hookSession.UpdatedAtUnixMS != 1000 {
		t.Fatalf("hook session = %#v, want independent hook session", *hookSession)
	}
}

func TestStoreAppliesProviderOnlyStatePatchToSameOriginSession(t *testing.T) {
	svc := New(nil)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "runtime-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
				UpdatedAtUnixMS:   900,
			},
			{
				AgentSessionID:    "hook-1",
				Provider:          "codex",
				ProviderSessionID: "provider-1",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
				UpdatedAtUnixMS:   850,
			},
		},
	})

	svc.ApplyActivity("room-1", EventSource{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		SessionOrigin:     WorkspaceAgentSessionOriginHook,
	}, nil, []WorkspaceAgentStatePatch{{
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		LifecycleStatus:   string(activityshared.SessionLifecycleStatusEnded),
		CurrentPhase:      string(activityshared.TurnPhaseIdle),
		OccurredAtUnixMS:  1000,
	}}, nil)

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}

	var runtimeSession *WorkspaceAgentSession
	var hookSession *WorkspaceAgentSession
	for i := range state.Sessions {
		session := &state.Sessions[i]
		switch session.AgentSessionID {
		case "runtime-1":
			runtimeSession = session
		case "hook-1":
			hookSession = session
		}
	}
	if runtimeSession == nil || hookSession == nil {
		t.Fatalf("sessions = %#v, want runtime and hook sessions", state.Sessions)
	}
	if runtimeSession.EffectiveStatus != "working" || runtimeSession.SessionOrigin != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("runtime session = %#v, want untouched runtime session", *runtimeSession)
	}
	if hookSession.SessionOrigin != WorkspaceAgentSessionOriginHook ||
		hookSession.LifecycleStatus != string(activityshared.SessionLifecycleStatusEnded) ||
		hookSession.EffectiveStatus != string(activityshared.SessionStatusCompleted) ||
		hookSession.EndedAtUnixMS != 1000 ||
		hookSession.UpdatedAtUnixMS != 850 {
		t.Fatalf("hook session = %#v, want provider-only patch applied to hook session", *hookSession)
	}
}

func TestStoreInterruptWorkspaceAgentsReportsWorkingSessions(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "agent-working",
				Provider:          "codex",
				ProviderSessionID: "codex-session",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
			{
				AgentSessionID:    "agent-ready",
				Provider:          "claude-code",
				ProviderSessionID: "claude-session",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "ready",
			},
		},
	})
	if err := svc.InterruptWorkspaceAgents(context.Background(), " room-1 ", "workspace-leave"); err != nil {
		t.Fatalf("InterruptWorkspaceAgents() error = %v", err)
	}

	if len(client.reportInputs) != 1 {
		t.Fatalf("reported inputs = %#v, want one state report per patch", client.reportInputs)
	}
	for _, report := range client.reportInputs {
		if report.WorkspaceID != "room-1" {
			t.Fatalf("reported workspace = %q, want room-1", report.WorkspaceID)
		}
		if len(report.TimelineItems) != 0 {
			t.Fatalf("reported timeline items = %#v, want no timeline forwarding", report.TimelineItems)
		}
		if len(report.StatePatches) != 1 {
			t.Fatalf("reported state patches = %#v, want one patch per report", report.StatePatches)
		}
		patch := report.StatePatches[0]
		if patch.AgentSessionID != "agent-working" || patch.Provider != "codex" || patch.ProviderSessionID != "codex-session" {
			t.Fatalf("reported patch identity = %#v", patch)
		}
		if patch.OccurredAtUnixMS == 0 {
			t.Fatalf("reported patch missing time: %#v", patch)
		}
	}
	var foundSessionPatch bool
	for _, patch := range client.statePatches {
		if patch.AgentSessionID == "agent-working" &&
			patch.LifecycleStatus == string(activityshared.SessionStatusCompleted) &&
			patch.CurrentPhase == string(activityshared.TurnPhaseIdle) {
			foundSessionPatch = true
		}
	}
	if !foundSessionPatch {
		t.Fatalf("state patches = %#v, want session completion patch", client.statePatches)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].LifecycleStatus != "ended" || state.Sessions[0].EffectiveStatus != "completed" || state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("interrupted session state = %#v", state.Sessions[0])
	}
	if state.Sessions[1].EffectiveStatus != "ready" {
		t.Fatalf("ready session was changed: %#v", state.Sessions[1])
	}
}

func TestStoreInterruptWorkspaceAgentsReportsHookAndRuntimeOriginsSeparately(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "runtime-1",
				Provider:          "codex",
				ProviderSessionID: "shared-provider-session",
				SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
			{
				AgentSessionID:    "hook-1",
				Provider:          "codex",
				ProviderSessionID: "shared-provider-session",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
		},
	})
	if err := svc.InterruptWorkspaceAgents(context.Background(), "room-1", "user_interrupt"); err != nil {
		t.Fatalf("InterruptWorkspaceAgents() error = %v", err)
	}

	if len(client.reportInputs) != 2 {
		t.Fatalf("reported inputs = %#v, want state-only runtime + hook reports", client.reportInputs)
	}
	var runtimeReports, hookReports int
	for index := range client.reportInputs {
		input := &client.reportInputs[index]
		switch input.Source.SessionOrigin {
		case WorkspaceAgentSessionOriginRuntime:
			runtimeReports++
		case WorkspaceAgentSessionOriginHook:
			hookReports++
		}
		if input.Source.Provider != "codex" || input.Source.ProviderSessionID != "shared-provider-session" {
			t.Fatalf("report source = %#v, want provider identity preserved", input.Source)
		}
		if len(input.TimelineItems) != 0 {
			t.Fatalf("report timeline items = %#v, want no timeline forwarding", input.TimelineItems)
		}
		if len(input.StatePatches) != 1 {
			t.Fatalf("report state patches = %#v, want one patch per report", input.StatePatches)
		}
	}
	if runtimeReports != 1 || hookReports != 1 {
		t.Fatalf("reported inputs = %#v, want one runtime and one hook state report", client.reportInputs)
	}
}

func TestStoreInterruptWorkspaceAgentSessionsOnlyReportsTargets(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "agent-local",
				Provider:          "codex",
				ProviderSessionID: "codex-local",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
			{
				AgentSessionID:    "agent-other-user",
				Provider:          "codex",
				ProviderSessionID: "codex-other-user",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"agent-local"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].AgentSessionID != "agent-local" ||
		state.Sessions[0].LifecycleStatus != "ended" ||
		state.Sessions[0].EffectiveStatus != "completed" ||
		state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("target session state = %#v, want completed local session", state.Sessions[0])
	}
	if state.Sessions[1].AgentSessionID != "agent-other-user" ||
		state.Sessions[1].EffectiveStatus != "working" ||
		state.Sessions[1].LifecycleStatus != "active" {
		t.Fatalf("non-target session state = %#v, want untouched", state.Sessions[1])
	}
	if len(client.reportInputs) != 1 {
		t.Fatalf("reported inputs = %#v, want only target report", client.reportInputs)
	}
	if len(client.reportInputs[0].StatePatches) != 1 || client.reportInputs[0].StatePatches[0].AgentSessionID != "agent-local" {
		t.Fatalf("reported state patches = %#v, want only target session", client.reportInputs[0].StatePatches)
	}
}

func TestStoreInterruptWorkspaceAgentSessionsCompletesTargetAfterLocalClose(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "agent-local",
				Provider:          "codex",
				ProviderSessionID: "codex-local",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "idle",
				EffectiveStatus:   "idle",
			},
			{
				AgentSessionID:    "agent-other-user",
				Provider:          "codex",
				ProviderSessionID: "codex-other-user",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "idle",
				EffectiveStatus:   "idle",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"agent-local"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 2 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].AgentSessionID != "agent-local" ||
		state.Sessions[0].LifecycleStatus != "ended" ||
		state.Sessions[0].EffectiveStatus != "completed" ||
		state.Sessions[0].TurnPhase != "idle" {
		t.Fatalf("target session state = %#v, want completed local session", state.Sessions[0])
	}
	if state.Sessions[1].AgentSessionID != "agent-other-user" ||
		state.Sessions[1].LifecycleStatus != "active" ||
		state.Sessions[1].EffectiveStatus != "idle" {
		t.Fatalf("non-target session state = %#v, want untouched", state.Sessions[1])
	}
	if len(client.statePatches) != 1 ||
		client.statePatches[0].AgentSessionID != "agent-local" ||
		client.statePatches[0].LifecycleStatus != "completed" {
		t.Fatalf("reported state patches = %#v, want target session completed patch", client.statePatches)
	}
}

func TestStoreInterruptWorkspaceAgentSessionsMatchesTargetProviderSessionID(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "runtime-session",
				Provider:          "codex",
				ProviderSessionID: "provider-session",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "idle",
				EffectiveStatus:   "idle",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"provider-session"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].LifecycleStatus != "ended" ||
		state.Sessions[0].EffectiveStatus != "completed" ||
		state.Sessions[0].Status != "completed" {
		t.Fatalf("target session state = %#v, want completed session", state.Sessions[0])
	}
	if len(client.statePatches) != 1 ||
		client.statePatches[0].AgentSessionID != "runtime-session" ||
		client.statePatches[0].ProviderSessionID != "provider-session" ||
		client.statePatches[0].LifecycleStatus != "completed" {
		t.Fatalf("reported state patches = %#v, want runtime session completed patch", client.statePatches)
	}
}

func TestStoreInterruptWorkspaceAgentSessionsCompletesSingleFoldedTarget(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "folded-session",
				Provider:          "codex",
				ProviderSessionID: "folded-provider-session",
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "idle",
				EffectiveStatus:   "idle",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"runtime-session", "provider-session"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	state, ok := svc.GetAgentState("room-1")
	if !ok || len(state.Sessions) != 1 {
		t.Fatalf("state = %#v, ok=%v", state, ok)
	}
	if state.Sessions[0].AgentSessionID != "folded-session" ||
		state.Sessions[0].LifecycleStatus != "ended" ||
		state.Sessions[0].EffectiveStatus != "completed" {
		t.Fatalf("target session state = %#v, want completed folded session", state.Sessions[0])
	}
	if len(client.statePatches) != 1 ||
		client.statePatches[0].AgentSessionID != "folded-session" ||
		client.statePatches[0].LifecycleStatus != "completed" {
		t.Fatalf("reported state patches = %#v, want folded session completed patch", client.statePatches)
	}
}

func TestStoreInterruptWorkspaceAgentSessionsReportsEachOriginSeparately(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "hook-session",
				Provider:          "codex",
				ProviderSessionID: "provider-session",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
			{
				AgentSessionID:    "runtime-session",
				Provider:          "codex",
				ProviderSessionID: "provider-session",
				SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"hook-session", "runtime-session"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	if len(client.reportInputs) != 2 {
		t.Fatalf("reported inputs = %#v, want runtime and hook reports", client.reportInputs)
	}
	if client.reportInputs[0].Source.SessionOrigin != WorkspaceAgentSessionOriginRuntime ||
		len(client.reportInputs[0].StatePatches) != 1 ||
		client.reportInputs[0].StatePatches[0].AgentSessionID != "runtime-session" {
		t.Fatalf("first report = %#v, want runtime patch", client.reportInputs[0])
	}
	if client.reportInputs[1].Source.SessionOrigin != WorkspaceAgentSessionOriginHook ||
		len(client.reportInputs[1].StatePatches) != 1 ||
		client.reportInputs[1].StatePatches[0].AgentSessionID != "hook-session" {
		t.Fatalf("second report = %#v, want hook patch", client.reportInputs[1])
	}
}

func TestStoreInterruptWorkspaceAgentSessionsReportsRuntimeTargetFromProviderContext(t *testing.T) {
	client := &fakeInterruptReporter{}
	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:    "hook-session",
				Provider:          "codex",
				ProviderSessionID: "provider-session",
				SessionOrigin:     WorkspaceAgentSessionOriginHook,
				CWD:               "/workspace/room-1",
				LifecycleStatus:   "active",
				TurnPhase:         "working",
				EffectiveStatus:   "working",
			},
		},
	})

	if err := svc.InterruptWorkspaceAgentSessions(
		context.Background(),
		"room-1",
		"workspace-leave",
		[]string{"runtime-session", "provider-session"},
	); err != nil {
		t.Fatalf("InterruptWorkspaceAgentSessions() error = %v", err)
	}

	if len(client.reportInputs) != 2 {
		t.Fatalf("reported inputs = %#v, want runtime fallback and hook reports", client.reportInputs)
	}
	if client.reportInputs[0].Source.SessionOrigin != WorkspaceAgentSessionOriginRuntime ||
		len(client.reportInputs[0].StatePatches) != 1 ||
		client.reportInputs[0].StatePatches[0].AgentSessionID != "runtime-session" ||
		client.reportInputs[0].StatePatches[0].ProviderSessionID != "provider-session" {
		t.Fatalf("first report = %#v, want runtime fallback patch", client.reportInputs[0])
	}
	if client.reportInputs[1].Source.SessionOrigin != WorkspaceAgentSessionOriginHook ||
		len(client.reportInputs[1].StatePatches) != 1 ||
		client.reportInputs[1].StatePatches[0].AgentSessionID != "hook-session" {
		t.Fatalf("second report = %#v, want hook patch", client.reportInputs[1])
	}
}

type fakeInterruptReporter struct {
	inputs        []ReportActivityInput
	workspaceID   string
	timelineItems []WorkspaceAgentTimelineItem
	statePatches  []WorkspaceAgentStatePatch
	reportInputs  []ReportActivityInput
}

func (*fakeInterruptReporter) ListAgents(context.Context, string) (*WorkspaceAgentSnapshot, error) {
	return &WorkspaceAgentSnapshot{}, nil
}

func (*fakeInterruptReporter) GetSessionTimeline(context.Context, SessionTimelineInput) (*SessionTimeline, error) {
	return &SessionTimeline{}, nil
}

func (*fakeInterruptReporter) ListSessionMessages(context.Context, ListSessionMessagesInput) (*ListSessionMessagesReply, error) {
	return &ListSessionMessagesReply{}, nil
}

func (f *fakeInterruptReporter) ReportSessionState(_ context.Context, input ReportSessionStateInput) (ReportSessionStateReply, error) {
	f.workspaceID = input.WorkspaceID
	patch := WorkspaceAgentStatePatch{
		AgentSessionID:    input.AgentSessionID,
		Provider:          input.State.Provider,
		ProviderSessionID: input.State.ProviderSessionID,
		Model:             input.State.Model,
		CWD:               input.State.CWD,
		Title:             input.State.Title,
		LifecycleStatus:   input.State.LifecycleStatus,
		CurrentPhase:      input.State.CurrentPhase,
		OccurredAtUnixMS:  input.State.OccurredAtUnixMS,
	}
	if input.State.Turn != nil {
		patch.Turn = &WorkspaceAgentTurnPatch{
			TurnID:            input.State.Turn.TurnID,
			Phase:             input.State.Turn.Phase,
			Outcome:           input.State.Turn.Outcome,
			FileChanges:       clonePayloadMap(input.State.Turn.FileChanges),
			StartedAtUnixMS:   input.State.Turn.StartedAtUnixMS,
			CompletedAtUnixMS: input.State.Turn.CompletedAtUnixMS,
		}
	}
	f.statePatches = append(f.statePatches, patch)
	f.reportInputs = append(f.reportInputs, ReportActivityInput{
		WorkspaceID:  input.WorkspaceID,
		Source:       input.Source,
		StatePatches: []WorkspaceAgentStatePatch{patch},
	})
	return ReportSessionStateReply{
		Accepted:          true,
		LastEventAtUnixMS: input.State.OccurredAtUnixMS,
	}, nil
}

func (f *fakeInterruptReporter) ReportSessionMessages(_ context.Context, input ReportSessionMessagesInput) (ReportSessionMessagesReply, error) {
	f.workspaceID = input.WorkspaceID
	return ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}
