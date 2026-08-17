package agentruntime

import (
	"context"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"testing"
	"time"
)

// Stop during a goal run: adapter.Cancel returns goal-pause events AFTER the
// interrupted turn already settled and stored the canceled session. Those
// events must apply to the CURRENT stored session — applying them to the
// pre-cancel snapshot would resurrect the working state and wedge the GUI in
// a permanent spinner (stop button dead, prompts queued forever).
func TestControllerCancelDuringGoalKeepsSettledState(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	})
	if err != nil {
		t.Fatalf("Exec long task: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", agentSessionID, execResult.TurnID, "user requested"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want provider confirmation", cancelResult)
	}
	if status := asString(adapter.sessionGoal(agentSessionID)["status"]); status != "paused" {
		t.Fatalf("goal status after stop = %q, want paused", status)
	}
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID: "room-1", AgentSessionID: agentSessionID, TurnID: execResult.TurnID, Outcome: "canceled",
	})
	session, ok := controller.get("room-1", agentSessionID)
	if !ok || session.Status != SessionStatusCanceled || session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("durable root settlement did not reconcile into controller: %#v", session)
	}
}

// Metadata-only session updates (usage/goal refreshes) must not flap an
// adopted turn's status back to ready mid-turn: adopted turns have no
// controller turn record, so they don't get preserveActiveTurnStatus's
// protection and rely on the sink's lifecycle guard.
func TestControllerAdoptedTurnStatusSurvivesMetadataEvents(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)})
	identity := goalOperationIdentity{operationID: "goal-op-metadata", revision: 1}
	adapter.replaceGoalOperationIdentity(agentSessionID, identity.operationID, identity.revision, identity.repairEpoch)
	goal := map[string]any{
		"threadId": "codex-thread-1", "objective": "ship it", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	}
	adapter.applyGoalUpdate(agentSessionID, goal)
	if err := adapter.bindGoalGeneration(context.Background(), started.Session, goal, identity); err != nil {
		t.Fatalf("bindGoalGeneration: %v", err)
	}

	// Codex self-starts a goal continuation turn; the reducer adopts it.
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": "codex-thread-1", "turnId": "turn-goal-1", "goal": goal,
	})
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": "codex-thread-1",
		"turn":     map[string]any{"id": "turn-goal-1", "status": "inProgress", "items": []any{}},
	})
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && session.Status == SessionStatusWorking
	})
	rootTurnID := ""
	if live, ok := controller.get("room-1", agentSessionID); ok && live.TurnLifecycle != nil && live.TurnLifecycle.ActiveTurnID != nil {
		rootTurnID = strings.TrimSpace(*live.TurnLifecycle.ActiveTurnID)
	}
	if rootTurnID == "" {
		t.Fatal("adopted provider turn has no canonical root turn id")
	}

	// Usage and goal refreshes arrive every few seconds during a turn.
	transport.conn.notify(appServerNotifyTokenUsage, map[string]any{
		"threadId":   "codex-thread-1",
		"tokenUsage": map[string]any{"total": map[string]any{"totalTokens": 42}},
	})
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": "codex-thread-1",
		"goal": map[string]any{
			"objective": "ship it marker",
			"status":    "active",
		},
	})
	waitForCondition(t, func() bool {
		return asStringRaw(adapter.sessionGoal(agentSessionID)["objective"]) == "ship it marker"
	})
	session, ok := controller.get("room-1", agentSessionID)
	if !ok || session.Status != SessionStatusWorking {
		t.Fatalf("status flapped during adopted turn: %q", session.Status)
	}

	transport.conn.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": "codex-thread-1",
		"turn":     map[string]any{"id": "turn-goal-1", "status": "completed", "items": []any{}},
	})
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == ""
	})
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID: "room-1", AgentSessionID: agentSessionID,
		TurnID: rootTurnID, Outcome: "completed",
	})
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && session.Status != SessionStatusWorking
	})
}

// Direct goal control (banner buttons) is a session-level operation: no
// prompt, no turn, works whether or not a turn is running.
func TestControllerGoalControl(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	// Pause with no turn running.
	result, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlPause,
	})
	if err != nil {
		t.Fatalf("GoalControl pause: %v", err)
	}
	if asString(result.Goal["status"]) != "paused" {
		t.Fatalf("pause result goal = %#v, want paused", result.Goal)
	}
	// Resume and edit the objective while a turn is running.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	}); err != nil {
		t.Fatalf("Exec long task: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})
	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlResume,
	}); err != nil {
		t.Fatalf("GoalControl resume: %v", err)
	}
	if status := asString(adapter.sessionGoal(agentSessionID)["status"]); status != "active" {
		t.Fatalf("goal status after resume = %q, want active", status)
	}
	result, err = controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlSet,
		Objective:      "ship it faster",
	})
	if err != nil {
		t.Fatalf("GoalControl set: %v", err)
	}
	if asStringRaw(result.Goal["objective"]) != "ship it faster" {
		t.Fatalf("set result goal = %#v, want updated objective", result.Goal)
	}
	if adapter.sessionActiveTurnID(agentSessionID) != "turn-1" {
		t.Fatalf("running turn must survive goal control")
	}

	// Clear.
	result, err = controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlClear,
	})
	if err != nil {
		t.Fatalf("GoalControl clear: %v", err)
	}
	if len(result.Goal) != 0 {
		t.Fatalf("clear result goal = %#v, want empty", result.Goal)
	}
	if goal := adapter.sessionGoal(agentSessionID); len(goal) != 0 {
		t.Fatalf("goal not cleared: %#v", goal)
	}

	transport.server.completePendingTurn()
}

// A startup goal/get may finish after a newer direct control. Its stale
// snapshot must not resurrect a goal that the provider already cleared.
func TestCodexStartupGoalRefreshCannotOverwriteNewerClear(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.goal = map[string]any{
		"threadId": "codex-thread-1",
		"status":   "paused",
	}
	transport.server.goalGetAfterSnapshot = func() {
		adapter.applyGoalClear(session.AgentSessionID)
		transport.server.mu.Lock()
		transport.server.goal = nil
		transport.server.goalGetAfterSnapshot = nil
		transport.server.mu.Unlock()
	}
	transport.server.mu.Unlock()

	adapter.refreshStartupGoal(context.Background(), session.AgentSessionID, nil)
	if goal := adapter.sessionGoal(session.AgentSessionID); len(goal) != 0 {
		t.Fatalf("stale startup refresh resurrected cleared goal: %#v", goal)
	}
}

func TestCodexAdoptedGoalTurnCarriesDurableGoalIdentity(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-op-9", revision: 9, repairEpoch: 4}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, identity.repairEpoch)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].pendingGoalTurns = map[string]*codexPendingGoalTurn{
		"provider-goal-turn-9": {providerTurnID: "provider-goal-turn-9", session: session, state: codexGoalTurnPending},
	}
	adapter.mu.Unlock()
	events := make(chan activityshared.Event, 4)
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		for _, event := range batch {
			events <- event
		}
	})
	if !adapter.adoptServerInitiatedTurn(session, "provider-goal-turn-9", identity) {
		t.Fatal("goal turn was not adopted")
	}

	select {
	case event := <-events:
		metadata := event.Payload.Metadata
		if event.Type != activityshared.EventTurnStarted || metadata["turnOrigin"] != "goal_continuation" || metadata["sourceGoalOperationId"] != "goal-op-9" || metadata["sourceGoalRevision"] != int64(9) || metadata["sourceGoalRepairEpoch"] != int64(4) {
			t.Fatalf("adopted goal turn event = %#v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for adopted goal turn")
	}
}
