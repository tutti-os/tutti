package agentruntime

import (
	"context"
	"errors"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCodexAppServerAdapterSlashGoalSetsObjective(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.goalStartsTurn = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal ship the review picker",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/set params = %#v", goalSet)
	}
	if asString(goalSet["objective"]) != "ship the review picker" {
		t.Fatalf("goal objective = %#v", goalSet)
	}
	if asString(goalSet["status"]) != "active" {
		t.Fatalf("goal status = %#v, want active", goalSet)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for /goal")
	}
	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
		if event.Payload.Metadata["kind"] == "agent_system_notice" {
			t.Fatalf("goal objective should stream app-server turn instead of local-only notice: %#v", event)
		}
	}
	if assistantText != "I'll work on the goal." {
		t.Fatalf("goal assistant message = %q", assistantText)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("goal turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashGoalContinuesUntilTerminalGoal(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-continuation", 1, 0)
	adapter.goalContinuationGraceWindow = 50 * time.Millisecond
	transport.server.goalStartsTurn = true
	transport.server.goalNotificationsBeforeResponse = true
	transport.server.goalCompletionAfterTurns = 2

	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal finish the DrawingML pass",
	}}, "", "turn-local-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Exec settles after the goal's FIRST turn; continuation turns are
	// codex-driven, nudged when codex does not self-continue, and adopted by
	// the reducer as their own turns.
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("first goal turn completed events = %d, want 1", len(completed))
	}
	firstMessages := []string{}
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant &&
			event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
			firstMessages = append(firstMessages, event.Payload.Content)
		}
	}
	if strings.Join(firstMessages, "\n") != "I'll work on the goal." {
		t.Fatalf("first turn assistant messages = %#v", firstMessages)
	}

	// The continuation nudge re-sends goal/set; the mock then starts the
	// second turn, which must be adopted and stream through the session sink.
	deadline := time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		adoptedCompleted := ""
		adoptedStarted := false
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted && event.Payload.Metadata["goalContinuation"] == true {
				adoptedStarted = true
			}
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
				adoptedCompleted = event.Payload.Content
			}
		}
		sinkMu.Unlock()
		if adoptedStarted && adoptedCompleted == "Goal complete." {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("adopted continuation turn did not complete; started=%v message=%q", adoptedStarted, adoptedCompleted)
		}
		time.Sleep(10 * time.Millisecond)
	}

	goalSets := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet)
	if len(goalSets) != 2 {
		t.Fatalf("goal/set requests = %d, want 2", len(goalSets))
	}
	if asString(goalSets[1]["status"]) != "active" {
		t.Fatalf("continuation goal/set params = %#v, want active status", goalSets[1])
	}
	if _, hasObjective := goalSets[1]["objective"]; hasObjective {
		t.Fatalf("continuation nudge must be status-only, got %#v", goalSets[1])
	}
}

// A mid-goal turn that settles failed (a transient tool/model error) while
// codex's own thread state still reports the goal active must not strand the
// goal: the continuation nudge has to fire on a failed settle exactly like it
// does on a clean completion, or the goal stops advancing for good with no
// further signal ("goal 执行一半不动了").
func TestCodexAppServerAdapterGoalContinuesAfterMidGoalTurnFailure(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-failure-continuation", 1, 0)
	adapter.goalContinuationGraceWindow = 50 * time.Millisecond
	transport.server.goalStartsTurn = true
	transport.server.goalNotificationsBeforeResponse = true
	transport.server.goalTurnFailAtTurn = 2
	transport.server.goalCompletionAfterTurns = 3

	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal finish the DrawingML pass",
	}}, "", "turn-local-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("first goal turn completed events = %d, want 1", len(completed))
	}

	// The second turn (adopted, codex-driven) settles failed. Without the
	// fix, finalizeSettledTurn only nudged on a clean completion, so this
	// failed settle would never schedule a continuation and the goal would
	// hang here forever.
	deadline := time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		failedSeen := false
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventRootProviderTurnCompleted &&
				event.Payload.TurnOutcome == string(activityshared.TurnOutcomeFailed) {
				failedSeen = true
			}
		}
		sinkMu.Unlock()
		if failedSeen {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("adopted continuation turn did not settle failed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The nudge must still fire after the failed settle and drive the goal to
	// its third, successful turn.
	deadline = time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		adoptedCompleted := ""
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
				adoptedCompleted = event.Payload.Content
			}
		}
		sinkMu.Unlock()
		if adoptedCompleted == "Goal complete." {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("goal did not continue past the failed turn to completion")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// initial /goal (turn 1) + nudge after turn 1 (turn 2, fails) + nudge
	// after turn 2's failure (turn 3, completes the goal). The nudge
	// scheduled after turn 3 sees the goal already "complete" and returns
	// before sending a fourth RPC.
	goalSets := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet)
	if len(goalSets) != 3 {
		t.Fatalf("goal/set requests = %d, want 3", len(goalSets))
	}
}

func TestCodexGoalContinuationNudgeDropsSupersededRevision(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalContinuationGraceWindow = 30 * time.Millisecond
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{"objective": "first", "status": "active"})
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-1", 1, 0)
	adapter.scheduleGoalContinuationNudge(session)

	// A newer desired revision wins before the old timer fires. The goal may
	// still be active, so only the revision guard prevents a stale RPC.
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-2", 2, 0)
	time.Sleep(100 * time.Millisecond)
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet); len(requests) != 0 {
		t.Fatalf("superseded nudge emitted goal/set requests = %#v", requests)
	}
}

func TestCodexGoalContinuationNudgeWaitsForProviderProgress(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish replay", "status": "active",
	})
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-replay", 1, 0)
	adapter.goalContinuationGraceWindow = time.Millisecond

	waiting := make(chan struct{})
	release := make(chan struct{})
	transport.conn.providerProgressWait = func(ctx context.Context, _ time.Duration) error {
		close(waiting)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-release:
			return nil
		}
	}
	adapter.scheduleGoalContinuationNudge(session)
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("continuation nudge did not wait for provider progress")
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet); len(requests) != 0 {
		t.Fatalf("continuation nudge ran while provider progress was parked: %#v", requests)
	}

	if !adapter.beginActiveTurn(session.AgentSessionID, &codexAppServerActiveTurn{turnID: "auto-turn"}) {
		t.Fatal("failed to install provider auto-continuation turn")
	}
	close(release)
	time.Sleep(20 * time.Millisecond)
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet); len(requests) != 0 {
		t.Fatalf("continuation nudge raced provider auto-continuation: %#v", requests)
	}
}

func TestCodexGoalSetAdoptsTurnWhenGoalUpdatedOmitsTurnID(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalContinuationGraceWindow = time.Hour
	transport.server.mu.Lock()
	transport.server.goalStartsTurn = true
	transport.server.goalCompletionAfterTurns = 2
	transport.server.goalUpdatedOmitsTurnID = true
	transport.server.mu.Unlock()

	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship the compatibility fix",
		OperationID: "goal-op-no-turn-id", Revision: 1,
	})
	if err != nil {
		t.Fatalf("ApplyGoal: %v", err)
	}

	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Content == "I'll work on the goal." {
				return true
			}
		}
		return false
	})

	sinkMu.Lock()
	foundClaimedTurn := false
	for _, event := range sinkEvents {
		if event.Type == activityshared.EventTurnStarted &&
			event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-no-turn-id" &&
			event.Payload.Metadata["goalProvenanceMode"] == "ordered_goal_continuation_claim" {
			foundClaimedTurn = true
		}
	}
	sinkMu.Unlock()
	if !foundClaimedTurn {
		t.Fatalf("missing compatibility-provenance turn start: %#v", sinkEvents)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("goal turn without notification turnId was interrupted: %#v", requests)
	}
}

func TestNormalizeCodexGoalObservationUsesCanonicalSessionFields(t *testing.T) {
	t.Parallel()

	goal := normalizedCodexGoal(map[string]any{
		"threadId":        "codex-thread-1",
		"objective":       "ship it",
		"status":          "usage_limited",
		"tokenBudget":     int64(200000),
		"tokensUsed":      int64(116818),
		"timeUsedSeconds": int64(163),
		"createdAt":       int64(1750000000),
		"updatedAt":       int64(1750000001),
	})

	if got := asString(goal["objective"]); got != "ship it" {
		t.Fatalf("objective = %q, want ship it", got)
	}
	if got := asString(goal["status"]); got != "usageLimited" {
		t.Fatalf("status = %q, want usageLimited", got)
	}
	if got, ok := int64Value(goal["durationMs"]); !ok || got != 163000 {
		t.Fatalf("durationMs = %#v, want 163000", goal["durationMs"])
	}
	if got, ok := int64Value(goal["tokens"]); !ok || got != 116818 {
		t.Fatalf("tokens = %#v, want 116818", goal["tokens"])
	}
	for _, providerField := range []string{
		"threadId", "tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt",
	} {
		if _, exists := goal[providerField]; exists {
			t.Fatalf("canonical goal retained provider field %q: %#v", providerField, goal)
		}
	}

	// Normalization is idempotent because status-only local updates may pass a
	// previously normalized snapshot back through applyGoalUpdate.
	normalizedAgain := normalizedCodexGoal(goal)
	if got, ok := int64Value(normalizedAgain["durationMs"]); !ok || got != 163000 {
		t.Fatalf("idempotent durationMs = %#v, want 163000", normalizedAgain["durationMs"])
	}
	if got, ok := int64Value(normalizedAgain["tokens"]); !ok || got != 116818 {
		t.Fatalf("idempotent tokens = %#v, want 116818", normalizedAgain["tokens"])
	}
}

func TestCodexGoalContinuationClaimChainsAcrossSettledTurns(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-op-chain", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "finish the chain",
		"status":    "active",
	})
	adapter.armGoalContinuationClaim(session.AgentSessionID, identity)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	startTurn := func(providerTurnID string) {
		reducer.ReduceNotification(appSession.client, session, "", acpMessage{
			Method: appServerNotifyTurnStarted,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": session.ProviderSessionID,
				"turn":     map[string]any{"id": providerTurnID, "status": "inProgress", "items": []any{}},
			}),
		}, nil, nil)
	}

	startTurn("provider-goal-chain-1")
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-goal-chain-1"
	})
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-goal-chain-1", "status": "completed", "items": []any{}},
		}),
	}, nil, nil)
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) == nil
	})

	startTurn("provider-goal-chain-2")
	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-goal-chain-2" &&
			active.goalIdentity == identity &&
			active.goalProvenance == "ordered_goal_continuation_claim"
	})
}

func TestCodexGoalContinuationClaimRejectsSupersededRevision(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	oldIdentity := goalOperationIdentity{operationID: "goal-op-old-claim", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, oldIdentity.operationID, oldIdentity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "old",
		"status":    "active",
	})
	adapter.armGoalContinuationClaim(session.AgentSessionID, oldIdentity)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-new-claim", 2, 0)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-delayed-old", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
			if asString(request["turnId"]) == "provider-delayed-old" {
				return true
			}
		}
		return false
	})
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != nil {
		t.Fatalf("superseded claim adopted delayed turn: %#v", active)
	}
}

func TestCodexPreparedGoalContinuationClaimDefersPendingTurnExpiry(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	identity := goalOperationIdentity{operationID: "goal-op-preparing", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "wait for durable binding",
		"status":    "active",
	})
	adapter.prepareGoalContinuationClaim(session.AgentSessionID, identity)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-preparing", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	time.Sleep(35 * time.Millisecond)
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("prepared claim allowed pending turn to expire: %#v", requests)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != nil {
		t.Fatalf("prepared claim adopted before durable binding: %#v", active)
	}

	adapter.armGoalContinuationClaim(session.AgentSessionID, identity)
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-preparing"
	})
}

// A server-initiated turn/started with no registered turn context and no goal
// keeps the legacy drop behavior (stray turns such as compaction).
func TestCodexAppServerAdapterUnownedTurnIgnoredWithoutGoal(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(nil, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-stray", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatalf("stray turn without goal must not be adopted")
	}
	sinkMu.Lock()
	defer sinkMu.Unlock()
	if len(sinkEvents) != 0 {
		t.Fatalf("stray turn without goal emitted events: %#v", sinkEvents)
	}
}

// A server-initiated turn/started while the goal is paused (Stop pressed) is
// interrupted instead of adopted, so codex cannot keep running a stopped goal.
func TestCodexAppServerAdapterUnownedTurnInterruptedForPausedGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "paused",
	})

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-paused-goal", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatalf("paused-goal turn must not be adopted")
	}
	waitForCondition(t, func() bool {
		requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
		for _, request := range requests {
			if asString(request["turnId"]) == "turn-paused-goal" {
				return true
			}
		}
		return false
	})
}

// Cancel must pause an active goal before interrupting the turn, so codex does
// not auto-start the next goal turn right after the interrupt.
func TestCodexAppServerAdapterCancelPausesActiveGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "active",
	})

	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	events, err := adapter.Cancel(context.Background(), session, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["status"]) != "paused" {
		t.Fatalf("goal/set params = %#v, want paused status", goalSet)
	}
	if status := asString(adapter.sessionGoal(session.AgentSessionID)["status"]); status != "paused" {
		t.Fatalf("in-memory goal status = %q, want paused", status)
	}
	foundGoalEvent := false
	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated &&
			event.Payload.Metadata["sessionUpdateKind"] == "thread_goal_update" {
			foundGoalEvent = true
		}
	}
	if !foundGoalEvent {
		t.Fatalf("Cancel events missing thread_goal_update, got %#v", events)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

// Mid-turn /goal commands are thread-level control operations: they must run
// the goal RPC instead of being steered into the active turn as prompt text.
func TestCodexAppServerAdapterMidTurnGoalClearDoesNotSteer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "active",
	})

	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	dispatches := make(chan ProviderDispatchResult, 1)
	events, err := adapter.ExecWithProviderAcceptance(
		context.Background(),
		session,
		[]PromptContentBlock{{
			Type: "text", Text: "/goal clear",
		}},
		"",
		"turn-local-2",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatches <- result },
		nil,
	)
	if err != nil {
		t.Fatalf("Exec /goal clear: %v", err)
	}
	dispatch := <-dispatches
	if dispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		dispatch.Acceptance != nil {
		t.Fatalf("mid-turn goal dispatch = %#v", dispatch)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnSteer); len(requests) != 0 {
		t.Fatalf("mid-turn /goal clear must not steer, sent %#v", requests)
	}
	transport.server.mu.Lock()
	cleared := transport.server.goalCleared
	transport.server.mu.Unlock()
	if !cleared {
		t.Fatalf("thread/goal/clear was not executed")
	}
	if goal := adapter.sessionGoal(session.AgentSessionID); len(goal) != 0 {
		t.Fatalf("in-memory goal not cleared: %#v", goal)
	}
	steered := false
	for _, event := range eventsOfType(events, activityshared.EventSessionAudit) {
		if event.Payload.Metadata["goalControl"] == true {
			steered = true
			if event.Payload.TurnID != "" {
				t.Fatalf("goal audit turn id = %q, want empty", event.Payload.TurnID)
			}
		}
	}
	if !steered {
		t.Fatalf("mid-turn /goal clear user message missing goalControl metadata: %#v", events)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("held turn did not finish")
	}
}

// The controller no longer classifies typed goal commands. Service owns that
// boundary, so every Controller.Exec call has the normal Turn contract.
func TestControllerExecDoesNotBypassActiveTurnForTypedGoal(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	_, err = controller.Exec(context.Background(), ExecInput{
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
	// A typed goal sent below the Service boundary is an ordinary Turn input
	// and therefore cannot bypass the single-active-turn gate.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("/goal clear"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("mid-turn typed goal error = %v, want ErrSessionActiveTurn", err)
	}
	if goal := adapter.sessionGoal(agentSessionID); asString(goal["objective"]) != "ship it" {
		t.Fatalf("controller unexpectedly changed goal: %#v", goal)
	}
	if adapter.sessionActiveTurnID(agentSessionID) != "turn-1" {
		t.Fatalf("active turn changed after rejected input")
	}

	// Ordinary prompts use the same Turn gate.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("another prompt"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("mid-turn plain prompt error = %v, want ErrSessionActiveTurn", err)
	}

	transport.server.completePendingTurn()
}

// Start/Resume restore the thread's persisted goal so the banner survives
// daemon restarts.
func TestCodexAppServerAdapterStartRestoresGoal(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.SetSessionEventSink(func(string, []activityshared.Event) {})
	transport.server.mu.Lock()
	transport.server.goal = map[string]any{
		"threadId":  "codex-thread-1",
		"objective": "finish it",
		"status":    "active",
	}
	transport.server.mu.Unlock()
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForCondition(t, func() bool {
		return asString(adapter.sessionGoal(session.AgentSessionID)["status"]) == "active"
	})
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
	}
}

func TestTuttiAgentAppServerAdapterStartRestoresGoalWithoutMetadataFetch(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	adapter.SetSessionEventSink(func(string, []activityshared.Event) {})
	transport.server.mu.Lock()
	transport.server.goal = map[string]any{
		"threadId":  "codex-thread-1",
		"objective": "finish it",
		"status":    "active",
	}
	transport.server.mu.Unlock()
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForCondition(t, func() bool {
		return asString(adapter.sessionGoal(session.AgentSessionID)["status"]) == "active"
	})
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
	}
}

func TestTuttiAgentAppServerAdapterResumeRestoresGoalWithoutMetadataFetch(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	adapter.SetSessionEventSink(func(string, []activityshared.Event) {})
	transport.server.mu.Lock()
	transport.server.goal = map[string]any{
		"threadId":  "codex-thread-1",
		"objective": "finish it",
		"status":    "active",
	}
	transport.server.mu.Unlock()
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	session.ProviderSessionID = "codex-thread-1"
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	waitForCondition(t, func() bool {
		return asString(adapter.sessionGoal(session.AgentSessionID)["status"]) == "active"
	})
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
	}
}

func TestCodexAppServerAdapterSlashGoalReadsCurrentGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.goal = map[string]any{
		"threadId":        "codex-thread-1",
		"objective":       "finish tests",
		"status":          "active",
		"tokensUsed":      int64(12),
		"timeUsedSeconds": int64(3),
		"createdAt":       int64(1750000000),
		"updatedAt":       int64(1750000001),
	}
	transport.server.mu.Unlock()
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for bare /goal")
	}
}

func TestCodexAppServerAdapterSlashGoalObjectiveMayStartWithStatusWord(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.goalStartsTurn = true
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal complete support for goal commands",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["objective"]) != "complete support for goal commands" {
		t.Fatalf("goal objective = %#v", goalSet)
	}
	if asString(goalSet["status"]) != "active" {
		t.Fatalf("goal status = %#v, want active", goalSet)
	}
}

func TestCodexAppServerAdapterSlashGoalStatusAndClear(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal blocked",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec blocked: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["status"]) != "blocked" {
		t.Fatalf("goal status params = %#v, want blocked", goalSet)
	}
	if _, hasObjective := goalSet["objective"]; hasObjective {
		t.Fatalf("status-only goal update should omit objective: %#v", goalSet)
	}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal clear",
	}}, "", "turn-local-2", nil, nil); err != nil {
		t.Fatalf("Exec clear: %v", err)
	}
	goalClear := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalClear)
	if asString(goalClear["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/clear params = %#v", goalClear)
	}
	transport.server.mu.Lock()
	cleared := transport.server.goalCleared
	transport.server.mu.Unlock()
	if !cleared {
		t.Fatalf("scripted app-server goal was not cleared")
	}
}
