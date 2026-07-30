package agentruntime

import (
	"context"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"sync"
	"testing"
	"time"
)

type memoryGoalProvenanceLedger struct {
	mu       sync.Mutex
	bindings map[string]GoalProvenanceBinding
}

type blockingGoalProvenanceLedger struct {
	*memoryGoalProvenanceLedger
	lookupStarted chan struct{}
	releaseLookup chan struct{}
}

func (l *blockingGoalProvenanceLedger) LookupGoalProvenance(ctx context.Context, session Session, fingerprint string) (GoalProvenanceBinding, bool, error) {
	select {
	case <-l.lookupStarted:
	default:
		close(l.lookupStarted)
	}
	select {
	case <-l.releaseLookup:
	case <-ctx.Done():
		return GoalProvenanceBinding{}, false, ctx.Err()
	}
	return l.memoryGoalProvenanceLedger.LookupGoalProvenance(ctx, session, fingerprint)
}

func TestCodexGoalProvenanceGraceWaitsForDurableLookup(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	ledger := &blockingGoalProvenanceLedger{
		memoryGoalProvenanceLedger: &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)},
		lookupStarted:              make(chan struct{}), releaseLookup: make(chan struct{}),
	}
	adapter.SetGoalProvenanceDurableSink(ledger)
	identity := goalOperationIdentity{operationID: "goal-op-slow", revision: 1}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "ship", "createdAt": int64(1), "updatedAt": int64(2)}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		t.Fatal(err)
	}
	adapter.queueGoalTurnForProvenance(session, "provider-turn-slow")
	done := make(chan struct{})
	go func() {
		adapter.observeGoalTurnGeneration(session, "provider-turn-slow", goal)
		close(done)
	}()
	<-ledger.lookupStarted
	time.Sleep(35 * time.Millisecond)
	adapter.mu.Lock()
	_, pending := adapter.sessions[session.AgentSessionID].pendingGoalTurns["provider-turn-slow"]
	adapter.mu.Unlock()
	if !pending {
		t.Fatal("pending Goal turn expired while durable lookup was in flight")
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("Goal turn was interrupted during durable lookup: %#v", requests)
	}
	close(ledger.releaseLookup)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("durable lookup did not finish")
	}
}

func (l *memoryGoalProvenanceLedger) BindGoalProvenance(_ context.Context, session Session, fingerprint string, proposed GoalProvenanceBinding) (GoalProvenanceBinding, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := session.RoomID + "\x00" + session.AgentSessionID + "\x00" + session.ProviderSessionID + "\x00" + fingerprint
	existing, found := l.bindings[key]
	if !found {
		l.bindings[key] = proposed
		return proposed, nil
	}
	if existing.Ambiguous {
		return existing, nil
	}
	if existing.OperationID != proposed.OperationID || existing.Revision != proposed.Revision || existing.RepairEpoch != proposed.RepairEpoch {
		existing = GoalProvenanceBinding{Ambiguous: true}
		l.bindings[key] = existing
	}
	return existing, nil
}

func (l *memoryGoalProvenanceLedger) LookupGoalProvenance(_ context.Context, session Session, fingerprint string) (GoalProvenanceBinding, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := session.RoomID + "\x00" + session.AgentSessionID + "\x00" + session.ProviderSessionID + "\x00" + fingerprint
	binding, found := l.bindings[key]
	return binding, found, nil
}

func TestCodexLateSupersededGoalTurnKeepsOriginalIdentityAndContinues(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, batch...)
	})

	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "old objective", OperationID: "goal-op-1", Revision: 1,
	}); err != nil {
		t.Fatalf("set1: %v", err)
	}
	// Keep the provider-authored generation payload for the delayed
	// notification. sessionGoal intentionally exposes only canonical public
	// fields and therefore omits immutable provenance fields.
	transport.server.mu.Lock()
	oldGoal := clonePayload(transport.server.goal)
	transport.server.mu.Unlock()
	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlClear, OperationID: "goal-clear", Revision: 2,
	}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "new objective", OperationID: "goal-op-2", Revision: 3, RepairEpoch: 2,
	}); err != nil {
		t.Fatalf("set2: %v", err)
	}

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyThreadGoalUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID, "turnId": "provider-old-turn", "goal": oldGoal,
		}),
	}, nil, nil)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-old-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted && event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-2" {
				t.Fatalf("late old provider turn inherited op2: %#v", event)
			}
			if event.Type == activityshared.EventTurnStarted &&
				event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-1" &&
				event.Payload.Metadata["sourceGoalRevision"] == int64(1) {
				return true
			}
		}
		return false
	})
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("superseding Goal state interrupted current provider Turn: %#v", requests)
	}
}

func TestCodexRestartedActiveGoalTurnDoesNotGuessProvenance(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "resumed provider goal", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, batch...)
	})

	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-restart-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
		return len(requests) > 0 && asString(requests[len(requests)-1]["turnId"]) == "provider-restart-turn"
	})
	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted {
				t.Fatalf("restart turn was adopted without operation evidence: %#v", event)
			}
			if event.Type == activityshared.EventGoalReconcileRequired && event.Payload.Metadata["phase"] == "finalized" {
				return event.Payload.Metadata["fenceMode"] == "current_durable" &&
					event.Payload.Metadata["expectedGoalOperationId"] == "" &&
					event.Payload.Metadata["expectedGoalRevision"] == int64(0) &&
					event.Payload.Metadata["quiesceSucceeded"] == true
			}
		}
		return false
	})
}

func TestCodexUnprovenGoalTurnQuiesceFailureRemainsExplicitAndExact(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	transport.server.interruptTurnIDMismatch = "provider-newer-turn"
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "resumed provider goal", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	events := make(chan activityshared.Event, 4)
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		for _, event := range batch {
			events <- event
		}
	})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-old-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type != activityshared.EventGoalReconcileRequired || event.Payload.Metadata["phase"] != "finalized" {
				continue
			}
			if event.Payload.Metadata["quiesceSucceeded"] != false || strings.TrimSpace(asString(event.Payload.Metadata["quiesceError"])) == "" {
				t.Fatalf("failed quiesce evidence = %#v", event.Payload.Metadata)
			}
			transport.server.mu.Lock()
			attempts := append([]string(nil), transport.server.interruptAttempts...)
			transport.server.mu.Unlock()
			if len(attempts) != 3 {
				t.Fatalf("exact quiesce attempts = %#v, want 3", attempts)
			}
			for _, attempt := range attempts {
				if attempt != "provider-old-turn" {
					t.Fatalf("quiesce retargeted a different provider turn: %#v", attempts)
				}
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for failed quiesce evidence")
		}
	}
}

func TestCodexUnprovenGoalTurnDurablyPreparesBeforeExactInterrupt(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	reporter := &goalPrepareBarrierReporter{prepared: make(chan struct{}), release: make(chan struct{})}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-1", Provider: ProviderCodex, CWD: "/workspace", Title: "Codex"})
	if err != nil {
		t.Fatal(err)
	}
	session := started.Session
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "restart", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-unproven", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)
	select {
	case <-reporter.prepared:
	case <-time.After(5 * time.Second):
		t.Fatal("pending reconcile was not reported")
	}
	transport.server.mu.Lock()
	beforeCommit := append([]string(nil), transport.server.interruptAttempts...)
	transport.server.mu.Unlock()
	if len(beforeCommit) != 0 {
		t.Fatalf("exact interrupt raced ahead of durable prepare: %v", beforeCommit)
	}
	close(reporter.release)
	waitForCondition(t, func() bool {
		transport.server.mu.Lock()
		defer transport.server.mu.Unlock()
		return len(transport.server.interruptAttempts) == 1 && transport.server.interruptAttempts[0] == "provider-unproven"
	})
	waitForCondition(t, func() bool {
		phases := reporter.phaseSnapshot()
		return len(phases) >= 2 && phases[0] == "quiesce_pending" && phases[1] == "finalized"
	})
}

func TestCodexUnprovenGoalTurnPrepareFailureForceClosesProvider(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	adapter.goalReconcileAckTimeout = 20 * time.Millisecond
	controller := NewController([]Adapter{adapter}, blockingGoalReconcileReporter{})
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-1", Provider: ProviderCodex, CWD: "/workspace", Title: "Codex"})
	if err != nil {
		t.Fatal(err)
	}
	session := started.Session
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{"threadId": session.ProviderSessionID, "objective": "restart", "status": "active"})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID,
			"turn": map[string]any{"id": "provider-unproven", "status": "inProgress", "items": []any{}}}),
	}, nil, nil)
	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return transport.conn.closeCount > 0
	})
	select {
	case <-appSession.client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider client did not terminate after durable prepare failure")
	}
	transport.server.mu.Lock()
	attempts := append([]string(nil), transport.server.interruptAttempts...)
	transport.server.mu.Unlock()
	if len(attempts) != 0 {
		t.Fatalf("unprotected exact interrupt continued after durable prepare failure: %v", attempts)
	}
}

// thread/goal/updated notifications must reach the GUI as session events even
// while no turn is running (the banner refreshes off this signal).
func TestCodexAppServerAdapterGoalUpdateNotificationEmitsSessionEvent(t *testing.T) {
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
	reducer.ReduceNotification(nil, session, "turn-1", acpMessage{
		Method: appServerNotifyThreadGoalUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"goal": map[string]any{
				"objective": "finish it",
				"status":    "usageLimited",
			},
		}),
	}, nil, nil)

	sinkMu.Lock()
	defer sinkMu.Unlock()
	foundUpdate := false
	foundNotice := false
	for _, event := range sinkEvents {
		if event.Type == activityshared.EventSessionUpdated &&
			event.Payload.Metadata["sessionUpdateKind"] == "thread_goal_update" {
			foundUpdate = true
		}
		if event.Type == activityshared.EventMessageAppended &&
			strings.Contains(event.Payload.Content, "usage limit") {
			foundNotice = true
		}
	}
	if !foundUpdate {
		t.Fatalf("missing thread_goal_update session event, got %#v", sinkEvents)
	}
	if !foundNotice {
		t.Fatalf("missing usage-limited status notice, got %#v", sinkEvents)
	}
}
