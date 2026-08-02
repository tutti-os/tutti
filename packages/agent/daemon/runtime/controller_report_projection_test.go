package agentruntime

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type captureGoalControlLifecycleObserver struct {
	observations []GoalControlAppliedObservation
}

func (o *captureGoalControlLifecycleObserver) ObserveGoalControlApplied(
	_ context.Context,
	observation GoalControlAppliedObservation,
) (GoalControlAppliedObservationResult, error) {
	o.observations = append(o.observations, observation)
	return GoalControlAppliedObservationResult{Accepted: true}, nil
}

func TestGoalProviderObservationProjectsToDurableControlInboxOnly(t *testing.T) {
	t.Parallel()
	session := Session{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderClaudeCode,
		ProviderSessionID: "provider-session-1", CWD: "/workspace",
	}
	ctx, ok := activityEventContext(session, "goal-observed-1", "")
	if !ok {
		t.Fatal("provider Goal event context unavailable")
	}
	event := activityshared.NewGoalProviderObserved(ctx, map[string]any{
		"operationId": "goal-op-1", "revision": int64(3), "repairEpoch": int64(1),
		"providerTurnId": "provider-turn-1", "source": "transcript_mirror",
		"updateType": "thread_goal_completed",
		"goal":       map[string]any{"objective": "ship it", "status": "complete"},
	})

	report := reportActivityInput(session, []activityshared.Event{event})
	if len(report.StatePatches) != 0 || len(report.GoalReconcileRequests) != 1 {
		t.Fatalf("provider Goal report=%#v", report)
	}
	request := report.GoalReconcileRequests[0]
	if request.Phase != "provider_observed" || request.AgentSessionID != "agent-session-1" ||
		request.ExpectedOperationID != "goal-op-1" || request.ExpectedRevision != 3 || request.ExpectedRepairEpoch != 1 ||
		request.ProviderTurnID != "provider-turn-1" || request.ProviderSource != "transcript_mirror" ||
		request.UpdateType != "thread_goal_completed" || request.Observed["status"] != "complete" {
		t.Fatalf("provider Goal control request=%#v", request)
	}
}

func TestControllerRoutesGoalControlAppliedOutsideSessionMetadata(t *testing.T) {
	t.Parallel()
	controller := NewController(nil, nil)
	observer := &captureGoalControlLifecycleObserver{}
	controller.SetGoalControlLifecycleObserver(observer)
	session := Session{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderClaudeCode,
		ProviderSessionID: "provider-session-1", CWD: "/workspace",
	}
	controller.store(session)
	ctx, ok := activityEventContext(session, "goal-applied-1", "")
	if !ok {
		t.Fatal("goal control event context unavailable")
	}
	event := activityshared.NewGoalControlApplied(ctx, map[string]any{
		"operationId": "goal-op-1", "revision": int64(3), "repairEpoch": int64(1),
		"action": "set", "providerTurnId": "provider-turn-1",
		"goal": map[string]any{"objective": "ship it", "status": "active"},
	})

	controller.applySessionEventsByAgentSessionID(session.AgentSessionID, []activityshared.Event{event})

	if len(observer.observations) != 1 {
		t.Fatalf("goal observations=%#v", observer.observations)
	}
	observation := observer.observations[0]
	if observation.WorkspaceID != "room-1" || observation.AgentSessionID != "agent-session-1" ||
		observation.OperationID != "goal-op-1" || observation.Revision != 3 || observation.RepairEpoch != 1 ||
		observation.Action != "set" || observation.ProviderTurnID != "provider-turn-1" ||
		observation.Observed["objective"] != "ship it" {
		t.Fatalf("goal observation=%#v", observation)
	}
	if report := reportActivityInput(session, []activityshared.Event{event}); len(report.StatePatches) != 0 {
		t.Fatalf("internal goal lifecycle leaked into session report=%#v", report.StatePatches)
	}
}

func TestEnrichReportStatePatchesWithSessionMetadataFillsSnapshotTitleAndIdentity(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "failed",
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    "agent-session-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Model:             "gpt-5",
		PermissionModeID:  "bypassPermissions",
		CWD:               "/workspace",
		Title:             "Automation Review",
		Settings:          map[string]any{"model": "gpt-5"},
		RuntimeContext: map[string]any{
			"title": "Automation Review",
			"cwd":   "/workspace",
		},
	})

	patch := report.StatePatches[0]
	if patch.Provider != "codex" ||
		patch.ProviderSessionID != "provider-session-1" ||
		patch.Model != "gpt-5" ||
		patch.PermissionModeID != "bypassPermissions" ||
		patch.CWD != "/workspace" ||
		patch.Title != "Automation Review" {
		t.Fatalf("enriched patch = %#v, want snapshot identity and title", patch)
	}
	if patch.RuntimeContext["title"] != "Automation Review" {
		t.Fatalf("runtime context = %#v, want title fallback", patch.RuntimeContext)
	}
}

func TestEnrichReportStatePatchesWithSessionMetadataKeepsIncomingTitle(t *testing.T) {
	t.Parallel()

	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			Title:          "Provider title",
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID: "agent-session-1",
		Title:          "Automation Review",
	})

	if got := report.StatePatches[0].Title; got != "Provider title" {
		t.Fatalf("title = %q, want incoming provider title", got)
	}
}

func TestEnrichReportStatePatchesWithSessionMetadataDoesNotAttachTurnLifecycle(t *testing.T) {
	t.Parallel()

	activeTurnID := "root-turn-1"
	report := &agentsessionstore.ReportActivityInput{
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{
				RootTurnID:     "root-turn-1",
				ProviderTurnID: "provider-turn-1",
				Phase:          agentsessionstore.RootProviderTurnPhaseCompleted,
			},
		}},
	}
	enrichReportStatePatchesWithSessionMetadata(report, agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting",
		},
		SubmitAvailability: &canonical.WorkspaceAgentSubmitAvailability{
			State:  "blocked",
			Reason: "active_turn",
		},
	})

	patch := report.StatePatches[0]
	if patch.Provider != ProviderClaudeCode {
		t.Fatalf("provider = %q, want session metadata", patch.Provider)
	}
	if patch.TurnLifecycle != nil || patch.SubmitAvailability != nil {
		t.Fatalf("persisted provider patch inherited runtime lifecycle: %#v", patch)
	}
}

func TestEnrichStreamStateEventsWithSessionSnapshotFillsRuntimeContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderClaudeCode,
		snapshot: SessionStateSnapshot{
			AgentSessionID: "agent-session-1",
			Provider:       ProviderClaudeCode,
			TurnLifecycle: &TurnLifecycle{
				ActiveTurnID: stringPtr("synthetic-turn-1"),
				Phase:        "running",
			},
			SubmitAvailability: &SubmitAvailability{
				State:  "blocked",
				Reason: "active_turn",
			},
			PendingInteractive: &SessionInteractivePrompt{
				Kind:      "ask-user",
				RequestID: "request-1",
				ToolName:  "AskUserQuestion",
				Status:    "waiting",
				Input: map[string]any{
					"questions": []any{map[string]any{
						"id":       "scope",
						"question": "Scope?",
					}},
				},
			},
			RuntimeContext: map[string]any{
				"usage": map[string]any{
					"contextWindow": map[string]any{
						"usedTokens":  int64(38414),
						"totalTokens": int64(200000),
					},
				},
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
	}
	controller.store(session)
	events := []StreamEvent{{
		EventType: StreamEventStatePatch,
		Data: agentsessionstore.WorkspaceAgentStatePatch{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "idle",
		},
	}}

	controller.enrichStreamStateEventsWithSessionSnapshot(session, events)

	patch, ok := events[0].Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("stream patch type = %T, want WorkspaceAgentStatePatch", events[0].Data)
	}
	usage, _ := patch.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if got, _ := int64Value(contextWindow["totalTokens"]); got != 200000 {
		t.Fatalf("runtime context usage = %#v, want totalTokens=200000", patch.RuntimeContext["usage"])
	}
	if patch.TurnLifecycle == nil ||
		patch.TurnLifecycle.ActiveTurnID == nil ||
		*patch.TurnLifecycle.ActiveTurnID != "synthetic-turn-1" ||
		patch.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running", patch.TurnLifecycle)
	}
	if patch.SubmitAvailability == nil ||
		patch.SubmitAvailability.State != "blocked" ||
		patch.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want active_turn blocked", patch.SubmitAvailability)
	}
	if patch.InteractionTransition != nil {
		t.Fatalf("snapshot enrichment interaction transition = %#v, want nil", patch.InteractionTransition)
	}
}

func TestDeriveSessionStatusFromEvents(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	tests := []struct {
		name     string
		events   []activityshared.Event
		fallback string
		want     string
	}{
		{
			name:     "keeps working without terminal event",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)},
			fallback: SessionStatusReady,
			want:     SessionStatusWorking,
		},
		{
			name:     "turn completed makes conversation ready",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusCompleted, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusReady,
		},
		{
			name:     "interrupted turn marks session canceled",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusCanceled,
		},
		{
			name:     "failed terminal event wins",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusFailed,
		},
		{
			name:     "waiting turn update keeps session waiting",
			events:   []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"phase": string(activityshared.TurnPhaseWaitingApproval)})},
			fallback: SessionStatusWorking,
			want:     SessionStatusWaiting,
		},
		{
			name:     "session completed ends session",
			events:   []activityshared.Event{newSessionActivityEvent(session, EventSessionCompleted, SessionStatusCompleted, nil)},
			fallback: SessionStatusWorking,
			want:     SessionStatusCompleted,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := deriveSessionStatusFromEvents(tt.events, tt.fallback); got != tt.want {
				t.Fatalf("status = %q, want %q", got, tt.want)
			}
		})
	}
}
