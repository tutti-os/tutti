package agentruntime

import (
	"context"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestCodexAppServerAdapterCancelInterruptsActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" || asString(interrupt["turnId"]) != "turn-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	select {
	case events := <-execDone:
		if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

func TestCodexAppServerAdapterCancelInterruptsLinkedChildThreads(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1", "child-thread-2"},
	})

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long parent task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	childOne, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	childTwo, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-2")
	cancelResult, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: childOne.agentSessionID, TurnID: childOne.turnID},
		{AgentSessionID: childTwo.agentSessionID, TurnID: childTwo.turnID},
		{AgentSessionID: session.AgentSessionID, TurnID: "turn-local-1"},
	}, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.Events) != 2 {
		t.Fatalf("cancel events = %#v, want two child cancel-request transitions", cancelResult.Events)
	}
	for _, event := range cancelResult.Events {
		if event.Type != activityshared.EventTurnUpdated || event.Payload.Metadata["cancelRequested"] != true {
			t.Fatalf("cancel event = %#v, want non-terminal cancel request", event)
		}
	}
	if len(cancelResult.ConfirmedTargets) != 3 {
		t.Fatalf("confirmed targets = %#v, want both children and root", cancelResult.ConfirmedTargets)
	}
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)) == 3
	})
	requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
	byThread := map[string]map[string]any{}
	for _, request := range requests {
		byThread[asString(request["threadId"])] = request
	}
	if asString(byThread["codex-thread-1"]["turnId"]) != "turn-1" {
		t.Fatalf("parent interrupt requests = %#v", requests)
	}
	if asString(byThread["child-thread-1"]["turnId"]) != "" ||
		asString(byThread["child-thread-2"]["turnId"]) != "" {
		t.Fatalf("child interrupt requests = %#v, want empty turnId startup interrupts", requests)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

func TestControllerCodexCancelInterruptsRootAndKnownChildBeforeLocalCleanup(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("spawn children serially"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(started.Session.AgentSessionID) == "turn-1"
	})

	_, _ = adapter.rememberAppServerChildThreads(
		started.Session,
		started.Session.ProviderSessionID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	child, ok := adapter.appServerChildThread(started.Session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("known child thread was not registered")
	}

	cancelResult, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:             started.Session.RoomID,
		RootAgentSessionID: started.Session.AgentSessionID,
		Targets: []CancelTarget{
			{AgentSessionID: child.agentSessionID, TurnID: child.turnID},
			{AgentSessionID: started.Session.AgentSessionID, TurnID: execResult.TurnID},
		},
		Reason: "user requested",
	})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.ConfirmedTargets) != 2 {
		t.Fatalf("confirmed targets = %#v, want known child and root", cancelResult.ConfirmedTargets)
	}

	requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
	if len(requests) != 2 {
		t.Fatalf("turn/interrupt requests = %#v, want child and root", requests)
	}
	if asString(requests[0]["threadId"]) != started.Session.ProviderSessionID ||
		asString(requests[1]["threadId"]) != "child-thread-1" {
		t.Fatalf("turn/interrupt order = %#v, want root before known child", requests)
	}
	byThread := map[string]map[string]any{}
	for _, request := range requests {
		byThread[asString(request["threadId"])] = request
	}
	if asString(byThread["child-thread-1"]["turnId"]) != "" {
		t.Fatalf("child interrupt = %#v, want startup interrupt without turn id", byThread["child-thread-1"])
	}
	if asString(byThread[started.Session.ProviderSessionID]["turnId"]) != "turn-1" {
		t.Fatalf("root interrupt = %#v, want live provider turn", byThread[started.Session.ProviderSessionID])
	}
}

func TestCodexAppServerAdapterCancelAfterTurnCompletedStillMarksChildrenCanceled(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1"},
	})

	// Run a turn to completion so no active turn remains, but children keep
	// running (spawned agents outlive the parent turn).
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "parent task",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "" {
		t.Fatalf("active turn id after completion = %q, want empty", got)
	}

	child, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	cancelResult, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: child.agentSessionID, TurnID: child.turnID},
	}, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.Events) != 1 || cancelResult.Events[0].Type != activityshared.EventTurnUpdated || cancelResult.Events[0].Payload.Metadata["cancelRequested"] != true {
		t.Fatalf("cancel events = %#v, want one non-terminal child cancel request", cancelResult.Events)
	}
	if len(cancelResult.ConfirmedTargets) != 1 {
		t.Fatalf("confirmed targets = %#v, want child", cancelResult.ConfirmedTargets)
	}
	_ = transport
}

func TestCodexAppServerAdapterEmitsLateChildCompletionAfterRootTurnCompleted(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1"},
	})
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}

	// The parent finishes first, leaving the provider child alive without an
	// active root-turn emitter attached to the session-level message handler.
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "parent task",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if activeTurn := adapter.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
		t.Fatal("root turn remained active after completion")
	}

	type emittedBatch struct {
		agentSessionID string
		events         []activityshared.Event
	}
	emitted := make(chan emittedBatch, 1)
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		emitted <- emittedBatch{
			agentSessionID: agentSessionID,
			events:         append([]activityshared.Event(nil), events...),
		}
	})
	transport.conn.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": "child-thread-1",
		"turn":     map[string]any{"id": "child-provider-turn-1", "status": "completed"},
	})

	select {
	case batch := <-emitted:
		if batch.agentSessionID != session.AgentSessionID {
			t.Fatalf("sink session = %q, want root %q", batch.agentSessionID, session.AgentSessionID)
		}
		completed := eventsOfType(batch.events, activityshared.EventTurnCompleted)
		if len(completed) != 1 || completed[0].AgentSessionID != child.agentSessionID || completed[0].Payload.TurnID != child.turnID {
			t.Fatalf("late child completion events = %#v", batch.events)
		}
		lifecycle, stamped := activityshared.TurnLifecycleSnapshotFromEvent(completed[0])
		if !stamped || lifecycle.Phase != string(activityshared.TurnPhaseSettled) {
			t.Fatalf("late child lifecycle = %#v, stamped=%v", lifecycle, stamped)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("late child completion did not reach the session event sink")
	}
}

func TestCodexAppServerAdapterKeepsLateChildCompletionOutOfNewRootTurnEmitter(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1"},
	})
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "parent task A",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec turn A: %v", err)
	}
	if activeTurn := adapter.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
		t.Fatal("root turn A remained active after completion")
	}

	type emittedBatch struct {
		agentSessionID string
		events         []activityshared.Event
	}
	emitted := make(chan emittedBatch, 1)
	adapter.SetSessionEventSink(func(agentSessionID string, events []activityshared.Event) {
		emitted <- emittedBatch{
			agentSessionID: agentSessionID,
			events:         append([]activityshared.Event(nil), events...),
		}
	})

	transport.server.holdTurn = true
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "parent task B",
		}}, "", "turn-local-2", nil, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		activeTurn := adapter.sessionActiveTurn(session.AgentSessionID)
		return activeTurn != nil && activeTurn.turnID == "turn-local-2"
	})

	transport.conn.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": "child-thread-1",
		"turn":     map[string]any{"id": "child-provider-turn-1", "status": "completed"},
	})

	select {
	case batch := <-emitted:
		if batch.agentSessionID != session.AgentSessionID {
			t.Fatalf("sink session = %q, want root %q", batch.agentSessionID, session.AgentSessionID)
		}
		completed := eventsOfType(batch.events, activityshared.EventTurnCompleted)
		if len(completed) != 1 ||
			completed[0].AgentSessionID != child.agentSessionID ||
			completed[0].RootTurnID != "turn-local-1" {
			t.Fatalf("detached child completion events = %#v", batch.events)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("late child completion was coupled to root turn B")
	}

	transport.server.completePendingTurn()
	select {
	case events := <-execDone:
		for _, event := range events {
			if event.AgentSessionID == child.agentSessionID {
				t.Fatalf("root turn B captured detached child event: %#v", event)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("root turn B did not finish")
	}
}

func TestCodexAppServerAdapterCancelInterruptsLateUnownedRootTurn(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	if _, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{{
		AgentSessionID: session.AgentSessionID,
		TurnID:         "root-turn-1",
	}}, "user requested"); err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Exec did not finish after cancellation")
	}

	appSession := adapter.getSession(session.AgentSessionID)
	reduction := newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-after-cancel", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)
	if len(reduction.Events) != 0 {
		t.Fatalf("late unowned turn events = %#v, want none", reduction.Events)
	}
	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatal("late unowned turn was adopted after root cancellation")
	}
	waitForCondition(t, func() bool {
		for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
			if asString(request["threadId"]) == session.ProviderSessionID && asString(request["turnId"]) == "turn-after-cancel" {
				return true
			}
		}
		return false
	})
}

func TestCodexAppServerAdapterCancelInterruptsLateChildWithoutCreatingSession(t *testing.T) {
	items := []struct {
		name string
		item map[string]any
	}{
		{
			name: "collaboration tool call",
			item: map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-after-cancel",
				"tool":              "spawnAgent",
				"status":            "completed",
				"receiverThreadIds": []any{"child-after-cancel"},
			},
		},
		{
			name: "sub-agent activity",
			item: map[string]any{
				"type":          "subAgentActivity",
				"id":            "spawn-after-cancel",
				"agentThreadId": "child-after-cancel",
				"agentPath":     "/root/reviewer",
				"kind":          "started",
			},
		},
	}

	for _, test := range items {
		t.Run(test.name, func(t *testing.T) {
			adapter, transport, session := startedAppServerAdapter(t)
			adapter.markRootTurnCanceled(session.AgentSessionID, "root-turn-1")
			appSession := adapter.getSession(session.AgentSessionID)

			reduction := newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "root-turn-1", acpMessage{
				Method: appServerNotifyItemCompleted,
				Params: mustJSONRawMessage(t, map[string]any{
					"threadId": session.ProviderSessionID,
					"turnId":   "provider-turn-1",
					"item":     test.item,
				}),
			}, newACPTurnNormalizer(), nil)
			if len(reduction.Events) != 0 {
				t.Fatalf("late child events = %#v, want none", reduction.Events)
			}
			if _, ok := adapter.appServerChildThread(session.AgentSessionID, "child-after-cancel"); ok {
				t.Fatal("late child received a canonical child session context")
			}
			waitForCondition(t, func() bool {
				for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
					if asString(request["threadId"]) == "child-after-cancel" {
						return true
					}
				}
				return false
			})
		})
	}
}

func TestCodexAppServerAdapterNewCanonicalTurnClearsCancelBoundary(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	adapter.markRootTurnCanceled(session.AgentSessionID, "root-turn-1")
	turn := &codexAppServerActiveTurn{turnID: "root-turn-2"}
	if !adapter.beginActiveTurn(session.AgentSessionID, turn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, turn)
	if canceledRootTurnID, canceled := adapter.rootTurnCanceled(session.AgentSessionID); canceled {
		t.Fatalf("cancel boundary = %q, want cleared for a new canonical turn", canceledRootTurnID)
	}
}

func TestCodexAppServerAdapterCancelForceClosesWedgedTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.cancelGraceWindow = 150 * time.Millisecond
	transport.server.holdTurn = true
	// Wedged codex: it acks turn/interrupt but never sends turn/completed.
	transport.server.ignoreInterrupt = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	// Decision: terminate-then-respond. Cancel must return only after the turn
	// is actually terminated, and within grace + margin even though codex never
	// honored the interrupt.
	cancelReturned := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user requested")
		cancelReturned <- err
	}()
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel did not return; force-close fallback missing")
	}

	// The wedged turn must actually end, surfaced as canceled (interrupted
	// outcome), never as a failure.
	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted (canceled) outcome, got %#v", events)
		}
		if failed := eventsOfType(events, activityshared.EventTurnFailed); len(failed) != 0 {
			t.Fatalf("force-cancel must not surface as failed, got %#v", events)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Exec did not finish after force cancel")
	}
}

func TestCodexAppServerAdapterCancelForceCloseIsBoundedByGrace(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.cancelGraceWindow = 150 * time.Millisecond
	transport.server.holdTurn = true
	// Fully wedged: codex never even acknowledges the turn/interrupt RPC, so a
	// synchronous interrupt call would block on its own ~10s timeout.
	transport.server.hangInterrupt = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	cancelReturned := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user requested")
		cancelReturned <- err
	}()
	// Time-to-force must be bounded by the grace window, not by the hung
	// interrupt RPC's own timeout.
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel blocked on the hung interrupt RPC instead of bounding by grace")
	}
	select {
	case <-execDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("Exec did not finish after force cancel")
	}
}

// TestCodexAppServerAdapterCancelRetriesInterruptOnStaleTurnID reproduces a
// real production incident: our own turn bookkeeping settles a turn locally
// as soon as its Go context is canceled (Cancel/interruptActiveTurn), without
// waiting for the app-server to confirm the turn actually stopped. When a
// slow-to-terminate tool call (live case: wait_agent blocking on several
// dispatched sub-agents) keeps the real app-server turn alive past that
// point, the *next* interrupt we send — aimed at the turn id we believe is
// active — gets rejected with "expected active turn id X but found Y"
// (live-captured, codex 0.142.5, JSON-RPC -32600). Left unhandled, the real
// stale turn is never actually interrupted and keeps running/emitting items
// on its own timeline, which is what left a session stuck reporting "regulat-
// ing next step" long after the visible conversation looked finished. The
// adapter must retry the interrupt against the turn id codex reports as
// actually active.
func TestCodexAppServerAdapterCancelRetriesInterruptOnStaleTurnID(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	// codex reports "turn-stale" as its real active turn, not the "turn-1" id
	// our own bookkeeping expects — mirrors the daemon racing ahead of the
	// app-server's turn teardown.
	transport.server.interruptTurnIDMismatch = "turn-stale"

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	cancelReturned := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user requested")
		cancelReturned <- err
	}()
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel did not return")
	}

	waitForCondition(t, func() bool {
		transport.server.mu.Lock()
		defer transport.server.mu.Unlock()
		return len(transport.server.interruptAttempts) >= 2
	})
	transport.server.mu.Lock()
	attempts := append([]string(nil), transport.server.interruptAttempts...)
	transport.server.mu.Unlock()
	if len(attempts) != 2 || attempts[0] != "turn-1" || attempts[1] != "turn-stale" {
		t.Fatalf("interrupt attempts = %#v, want [turn-1 turn-stale]", attempts)
	}

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after retried interrupt")
	}
}

func TestCodexAppServerAdapterCancelQueuesInterruptUntilTurnIDArrives(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true
	transport.server.turnStartEntered = make(chan struct{})
	transport.server.turnStartRelease = make(chan struct{})

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	select {
	case <-transport.server.turnStartEntered:
	case <-time.After(5 * time.Second):
		t.Fatalf("turn/start was not sent")
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err != nil {
		t.Fatalf("Cancel before provider turn id: %v", err)
	}

	close(transport.server.turnStartRelease)
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)) == 1
	})
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" || asString(interrupt["turnId"]) != "turn-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	select {
	case events := <-execDone:
		if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after queued interrupt")
	}
}

func TestCodexAppServerAdapterCancelWithoutActiveTurnFails(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err == nil {
		t.Fatalf("Cancel without active turn returned nil error")
	}
}
