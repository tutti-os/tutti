package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCodexGoalProvenanceNotificationOverflowFailsClosedWithLateBinding(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	reconciled := make(chan struct{}, 1)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		for _, event := range events {
			if event.Type == activityshared.EventGoalReconcileRequired {
				select {
				case reconciled <- struct{}{}:
				default:
				}
			}
		}
	})
	identity := goalOperationIdentity{operationID: "goal-overflow", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].pendingGoalTurns = map[string]*codexPendingGoalTurn{
		"turn-overflow": {providerTurnID: "turn-overflow", session: session, state: codexGoalTurnPending},
	}
	adapter.mu.Unlock()
	message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-overflow","message":"buffered"}`)}
	for i := 0; i < maxPendingGoalTurnNotifications; i++ {
		if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-overflow", message) {
			t.Fatal("notification was not buffered")
		}
	}
	terminal := acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-overflow","turn":{"id":"turn-overflow","status":"completed"}}`)}
	if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-overflow", terminal) {
		t.Fatal("overflow terminal was not consumed")
	}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "old", "createdAt": int64(1), "updatedAt": int64(2)}
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err == nil {
		t.Fatal("late binding unexpectedly revived degraded provenance")
	}
	adapter.observeGoalTurnGeneration(session, "turn-overflow", goal)
	adapter.mu.Lock()
	degraded := adapter.sessions[session.AgentSessionID].provenanceDegraded
	active := adapter.sessions[session.AgentSessionID].activeTurn
	adapter.mu.Unlock()
	if !degraded || active != nil {
		t.Fatalf("degraded=%v active=%#v", degraded, active)
	}
	deadline := time.Now().Add(2 * time.Second)
	interrupted, durableReconcile := false, false
	for time.Now().Before(deadline) {
		transport.server.mu.Lock()
		attempts := append([]string(nil), transport.server.interruptAttempts...)
		transport.server.mu.Unlock()
		if len(attempts) > 0 {
			if attempts[0] != "turn-overflow" {
				t.Fatalf("interrupts=%v", attempts)
			}
			interrupted = true
		}
		select {
		case <-reconciled:
			durableReconcile = true
		default:
		}
		if interrupted && durableReconcile {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("overflow closure interrupted=%v durableReconcile=%v", interrupted, durableReconcile)
}

func TestCodexGoalProvenanceDoubleResolvePreservesAdoptingBuffer(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-double", revision: 2}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-double"
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-double": {providerTurnID: "turn-double", session: session, state: codexGoalTurnPending}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-double": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	adapter.goalBeforeAdoptHook = func() { ready <- struct{}{}; <-release }
	var once sync.Once
	adapter.goalHandoffCommittedHook = func() {
		once.Do(func() {
			adapter.mu.Lock()
			quiesced := adapter.degradeGoalProvenanceLocked(adapter.sessions[session.AgentSessionID])
			adapter.mu.Unlock()
			if len(quiesced) != 0 {
				t.Errorf("adopting turn was degraded as pending: %#v", quiesced)
			}
			adapter.expirePendingGoalTurn(session.AgentSessionID, "turn-double")
			adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-double", acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-double","turn":{"id":"turn-double","status":"completed"}}`)})
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() { defer wg.Done(); adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-double") }()
	}
	<-ready
	<-ready
	close(release)
	wg.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		_, pending := adapter.sessions[session.AgentSessionID].pendingGoalTurns["turn-double"]
		adapter.mu.Unlock()
		if active == nil && !pending {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("double resolve lost terminal or left adopting buffer")
}

func TestCodexGoalHandoffReplaysBufferedContentInOrderExactlyOnce(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-content", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-content"
	notifications := []acpMessage{
		{Method: appServerNotifyReasoningDelta, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "delta": "think first"})},
		{Method: appServerNotifyAgentMessageDelta, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "delta": "hello second"})},
		{Method: appServerNotifyItemStarted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "item": map[string]any{"type": "commandExecution", "id": "cmd-content", "command": "pwd", "status": "inProgress"}})},
		{Method: appServerNotifyItemCompleted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "item": map[string]any{"type": "commandExecution", "id": "cmd-content", "command": "pwd", "status": "completed", "aggregatedOutput": "/workspace", "exitCode": 0}})},
		{Method: appServerNotifyTurnCompleted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "turn": map[string]any{"id": "turn-content", "status": "completed"}})},
	}
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-content": {providerTurnID: "turn-content", session: session, state: codexGoalTurnPending, notifications: notifications}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-content": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	var mu sync.Mutex
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		mu.Lock()
		events = append(events, batch...)
		mu.Unlock()
	})
	if !adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-content") {
		t.Fatal("handoff was not resolved")
	}
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		adapter.mu.Unlock()
		return active == nil
	})
	mu.Lock()
	got := append([]activityshared.Event(nil), events...)
	mu.Unlock()
	started, thinking, assistant, callStarted, callCompleted, providerTerminal := -1, -1, -1, -1, -1, -1
	for i, event := range got {
		if event.Payload.TurnID == "" {
			t.Fatalf("replayed event missing local turn id: %#v", event)
		}
		switch {
		case event.Type == activityshared.EventTurnStarted:
			started = i
		case strings.Contains(event.Payload.Content, "think first") && event.Payload.Metadata["streamState"] == messageStreamStateStreaming:
			if thinking >= 0 {
				t.Fatal("thinking replayed twice")
			}
			thinking = i
		case strings.Contains(event.Payload.Content, "hello second") && event.Payload.Metadata["streamState"] == messageStreamStateStreaming:
			if assistant >= 0 {
				t.Fatal("assistant replayed twice")
			}
			assistant = i
		case event.Type == activityshared.EventCallStarted:
			callStarted = i
		case event.Type == activityshared.EventCallCompleted:
			callCompleted = i
		case event.Type == activityshared.EventRootProviderTurnCompleted:
			providerTerminal = i
			if event.Payload.ProviderTurnID != "turn-content" {
				t.Fatalf("provider terminal id = %q, want turn-content", event.Payload.ProviderTurnID)
			}
		case event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled:
			t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", event)
		}
	}
	if started < 0 || started >= thinking || thinking >= assistant || assistant >= callStarted || callStarted >= callCompleted || callCompleted >= providerTerminal {
		t.Fatalf("replay order start=%d thinking=%d assistant=%d callStart=%d callComplete=%d providerTerminal=%d events=%#v", started, thinking, assistant, callStarted, callCompleted, providerTerminal, got)
	}
}

func TestCodexGoalAdoptingOverflowSettlesAndQuiesces(t *testing.T) {
	for _, tc := range []struct {
		name        string
		failQuiesce bool
		wantOutcome activityshared.TurnOutcome
	}{{"success", false, activityshared.TurnOutcomeCanceled}, {"failure", true, activityshared.TurnOutcomeFailed}} {
		t.Run(tc.name, func(t *testing.T) {
			adapter, transport, session := startedAppServerAdapter(t)
			identity := goalOperationIdentity{operationID: "goal-overflow-adopting", revision: 5}
			adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, 5, 0)
			if tc.failQuiesce {
				transport.server.mu.Lock()
				transport.server.interruptTurnIDMismatch = "newer-turn"
				transport.server.mu.Unlock()
			}
			fingerprint := "fingerprint-adopting"
			adapter.mu.Lock()
			app := adapter.sessions[session.AgentSessionID]
			app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-adopting": {providerTurnID: "turn-adopting", session: session, state: codexGoalTurnPending}}
			app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
			app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-adopting": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
			adapter.mu.Unlock()
			drainEntered := make(chan struct{})
			release := make(chan struct{})
			var drainOnce sync.Once
			adapter.goalHandoffDrainHook = func() { drainOnce.Do(func() { close(drainEntered); <-release }) }
			var mu sync.Mutex
			var events []activityshared.Event
			adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
				mu.Lock()
				events = append(events, batch...)
				mu.Unlock()
			})
			initial := acpMessage{Method: appServerNotifyAgentMessageDelta, Params: json.RawMessage(`{"turnId":"turn-adopting","delta":"before overflow"}`)}
			if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", initial) {
				t.Fatal("initial adopting notification escaped buffer")
			}
			done := make(chan struct{})
			go func() { adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-adopting"); close(done) }()
			<-drainEntered
			message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-adopting","message":"noise"}`)}
			for i := 0; i <= maxPendingGoalTurnNotifications; i++ {
				if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", message) {
					t.Fatal("adopting notification escaped buffer")
				}
			}
			close(release)
			<-done
			waitForCondition(t, func() bool {
				adapter.mu.Lock()
				active := adapter.sessions[session.AgentSessionID].activeTurn
				adapter.mu.Unlock()
				return active == nil
			})
			late := acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-adopting","turn":{"id":"turn-adopting","status":"completed"}}`)}
			if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", late) {
				t.Fatal("late terminal escaped aborted handoff")
			}
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			snapshot := append([]activityshared.Event(nil), events...)
			mu.Unlock()
			providerTerminalCount, reconcileCount, assistantIndex, terminalIndex := 0, 0, -1, -1
			var reconcileID string
			phases := map[string]bool{}
			for index, event := range snapshot {
				if (event.Type == activityshared.EventMessageAppended || event.Type == activityshared.EventMessageCreated) && strings.Contains(event.Payload.Content, "before overflow") {
					assistantIndex = index
				}
				if event.Type == activityshared.EventRootProviderTurnCompleted {
					providerTerminalCount++
					terminalIndex = index
					if event.Payload.ProviderTurnID != "turn-adopting" {
						t.Fatalf("provider terminal id = %q, want turn-adopting", event.Payload.ProviderTurnID)
					}
					if event.Payload.TurnOutcome != string(tc.wantOutcome) {
						t.Fatalf("provider terminal outcome = %q, want %q", event.Payload.TurnOutcome, tc.wantOutcome)
					}
				}
				if event.Type == activityshared.EventGoalReconcileRequired {
					reconcileCount++
					if reconcileID == "" {
						reconcileID = event.EventID
					} else if reconcileID != event.EventID {
						t.Fatalf("two-phase reconcile changed request id: %#v", snapshot)
					}
					phases[asString(event.Payload.Metadata["phase"])] = true
				}
				if event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled {
					t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", snapshot)
				}
			}
			if providerTerminalCount != 1 || reconcileCount != 2 || !phases["quiesce_pending"] || !phases["finalized"] {
				t.Fatalf("providerTerminal=%d reconcile=%d phases=%v events=%#v", providerTerminalCount, reconcileCount, phases, snapshot)
			}
			if assistantIndex < 0 || terminalIndex <= assistantIndex {
				t.Fatalf("drained content/terminal order assistant=%d terminal=%d events=%#v", assistantIndex, terminalIndex, snapshot)
			}
			transport.server.mu.Lock()
			attempts := append([]string(nil), transport.server.interruptAttempts...)
			transport.server.mu.Unlock()
			wantAttempts := 1
			if tc.failQuiesce {
				wantAttempts = 3
			}
			if len(attempts) != wantAttempts {
				t.Fatalf("interrupt attempts=%v want=%d", attempts, wantAttempts)
			}
			for _, id := range attempts {
				if id != "turn-adopting" {
					t.Fatalf("non-exact interrupt=%v", attempts)
				}
			}
		})
	}
}

func TestCodexGoalAdoptingPrepareFailureTerminatesLocalTurnAndProvider(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.SetGoalReconcileDurableSink(func(context.Context, Session, GoalReconcileDurableRequest) error {
		return errors.New("durable reporter unavailable")
	})
	identity := goalOperationIdentity{operationID: "goal-prepare-fail", revision: 5}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-prepare-fail"
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-adopting": {providerTurnID: "turn-adopting", session: session, state: codexGoalTurnPending}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-adopting": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	committed, release := make(chan struct{}), make(chan struct{})
	adapter.goalHandoffCommittedHook = func() { close(committed); <-release }
	var mu sync.Mutex
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		mu.Lock()
		events = append(events, batch...)
		mu.Unlock()
	})
	done := make(chan struct{})
	go func() { adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-adopting"); close(done) }()
	<-committed
	message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-adopting","message":"noise"}`)}
	for i := 0; i <= maxPendingGoalTurnNotifications; i++ {
		if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", message) {
			t.Fatal("adopting notification escaped buffer")
		}
	}
	close(release)
	<-done
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		adapter.mu.Unlock()
		return active == nil
	})
	select {
	case <-app.client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider remained live after durable prepare failure")
	}
	mu.Lock()
	snapshot := append([]activityshared.Event(nil), events...)
	mu.Unlock()
	providerFailed := 0
	for _, event := range snapshot {
		if event.Type == activityshared.EventRootProviderTurnCompleted {
			providerFailed++
			if event.Payload.ProviderTurnID != "turn-adopting" {
				t.Fatalf("provider terminal id = %q, want turn-adopting", event.Payload.ProviderTurnID)
			}
			if event.Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
				t.Fatalf("provider terminal outcome = %q, want failed", event.Payload.TurnOutcome)
			}
		}
		if event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled {
			t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", event)
		}
	}
	transport.server.mu.Lock()
	attempts := append([]string(nil), transport.server.interruptAttempts...)
	transport.server.mu.Unlock()
	if providerFailed != 1 || len(attempts) != 0 {
		t.Fatalf("providerFailed=%d interruptAttempts=%v events=%#v", providerFailed, attempts, snapshot)
	}
}

func TestCodexGoalProvenanceWorkingSetRemainsBoundedAfterManyGenerations(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-cap", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, 1, 0)
	for i := 0; i < 512; i++ {
		goal := map[string]any{"threadId": session.ProviderSessionID, "objective": fmt.Sprintf("goal-%d", i), "createdAt": int64(i + 1), "updatedAt": int64(i + 2)}
		if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
			t.Fatalf("bindGoalGeneration: %v", err)
		}
	}
	adapter.mu.Lock()
	degraded := adapter.sessions[session.AgentSessionID].provenanceDegraded
	bindings := len(adapter.sessions[session.AgentSessionID].goalGenerationBindings)
	adapter.mu.Unlock()
	if degraded || bindings > maxGoalGenerationBindings {
		t.Fatalf("degraded=%v bindings=%d", degraded, bindings)
	}
	_ = transport
}

func TestCodexGoalGenerationFingerprintIsStableFixedLengthDigest(t *testing.T) {
	goal := map[string]any{"threadId": "thread-1", "objective": "private objective", "createdAt": int64(10), "updatedAt": int64(11)}
	first := codexGoalGenerationFingerprint(goal)
	second := codexGoalGenerationFingerprint(clonePayload(goal))
	if first != second || len(first) != len("sha256:")+64 || strings.Contains(first, "private objective") {
		t.Fatalf("fingerprint first=%q second=%q", first, second)
	}
	changed := clonePayload(goal)
	changed["updatedAt"] = int64(12)
	if codexGoalGenerationFingerprint(changed) == first {
		t.Fatal("updated provider generation produced the same fingerprint")
	}
	for _, field := range []string{"threadId", "objective", "createdAt", "updatedAt"} {
		missing := clonePayload(goal)
		delete(missing, field)
		if got := codexGoalGenerationFingerprint(missing); got != "" {
			t.Fatalf("fingerprint missing %s = %q, want empty", field, got)
		}
	}
}

func TestCodexGoalApplyMissingGenerationFingerprintFailsClosed(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.goalOmitUpdatedAt = true
	transport.server.mu.Unlock()
	_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship safely", OperationID: "goal-missing-fingerprint", Revision: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "missing immutable fingerprint fields") {
		t.Fatalf("ApplyGoal error = %v", err)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	goal := clonePayload(appSession.goal)
	adapter.mu.Unlock()
	if !degraded || len(goal) != 0 {
		t.Fatalf("degraded=%v localGoal=%#v", degraded, goal)
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after invalid Goal generation response")
	}
}

func TestCodexDurableGoalSetEmptyGenerationResponseFailsClosed(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.goalEmptyResponse = true
	transport.server.mu.Unlock()
	result, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship safely", OperationID: "goal-empty-generation", Revision: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "returned no Goal generation") {
		t.Fatalf("ApplyGoal result=%#v error=%v", result, err)
	}
	if result.ProviderPhase == "applied" {
		t.Fatalf("empty Goal generation was reported applied: %#v", result)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	goal := clonePayload(appSession.goal)
	adapter.mu.Unlock()
	if !degraded || len(goal) != 0 {
		t.Fatalf("degraded=%v localGoal=%#v", degraded, goal)
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after empty durable Goal set response")
	}
}

func TestCodexTurnScopedGoalObservationMissingFingerprintFailsClosed(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	adapter.observeGoalTurnGeneration(session, "turn-missing-fingerprint", map[string]any{
		"threadId": session.ProviderSessionID, "objective": "ship safely", "createdAt": int64(1),
	})
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	adapter.mu.Unlock()
	if !degraded {
		t.Fatal("turn-scoped invalid generation did not degrade provenance")
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after invalid turn-scoped Goal generation")
	}
}

func TestCodexGoalProvenanceDurableLedgerSurvivesRestartAndAdoptsDelayedGeneration(t *testing.T) {
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	firstAdapter, _, session := startedAppServerAdapter(t)
	firstAdapter.SetGoalProvenanceDurableSink(ledger)
	oldIdentity := goalOperationIdentity{operationID: "goal-old", revision: 1}
	oldGoal := map[string]any{"threadId": session.ProviderSessionID, "objective": "old", "createdAt": int64(1), "updatedAt": int64(2)}
	firstAdapter.replaceGoalOperationIdentity(session.AgentSessionID, oldIdentity.operationID, oldIdentity.revision, 0)
	if err := firstAdapter.bindGoalGeneration(context.Background(), session, oldGoal, oldIdentity); err != nil {
		t.Fatalf("bind old generation: %v", err)
	}

	restarted, transport, restartedSession := startedAppServerAdapter(t)
	restarted.SetGoalProvenanceDurableSink(ledger)
	restarted.goalProvenanceGraceWindow = 10 * time.Millisecond
	newIdentity := goalOperationIdentity{operationID: "goal-new", revision: 2}
	newGoal := map[string]any{"threadId": restartedSession.ProviderSessionID, "objective": "new", "createdAt": int64(3), "updatedAt": int64(4)}
	restarted.replaceGoalOperationIdentity(restartedSession.AgentSessionID, newIdentity.operationID, newIdentity.revision, 0)
	if err := restarted.bindGoalGeneration(context.Background(), restartedSession, newGoal, newIdentity); err != nil {
		t.Fatalf("bind new generation: %v", err)
	}
	restarted.queueGoalTurnForProvenance(restartedSession, "turn-delayed-old-after-restart")
	restarted.observeGoalTurnGeneration(restartedSession, "turn-delayed-old-after-restart", oldGoal)
	waitForCondition(t, func() bool {
		restarted.mu.Lock()
		defer restarted.mu.Unlock()
		return restarted.sessions[restartedSession.AgentSessionID].activeTurn != nil
	})
	transport.server.mu.Lock()
	interrupts := append([]string(nil), transport.server.interruptAttempts...)
	transport.server.mu.Unlock()
	if len(interrupts) != 0 {
		t.Fatalf("delayed proven generation was interrupted after restart: %#v", interrupts)
	}
}

func TestCodexFencedGoalGenerationIsPreciselyInterruptedBeforeAdoption(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)})
	identity := goalOperationIdentity{operationID: "goal-fenced", revision: 4, repairEpoch: 1}
	goal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "old shared work",
		"status": "active", "createdAt": int64(10), "updatedAt": int64(11),
	}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, identity.repairEpoch)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		t.Fatal(err)
	}
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: identity.operationID, Revision: identity.revision,
		RepairEpoch: identity.repairEpoch, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	adapter.queueGoalTurnForProvenance(session, "provider-turn-fenced")
	adapter.observeGoalTurnGeneration(session, "provider-turn-fenced", goal)
	waitForCondition(t, func() bool {
		transport.server.mu.Lock()
		defer transport.server.mu.Unlock()
		for _, turnID := range transport.server.interruptAttempts {
			if turnID == "provider-turn-fenced" {
				return true
			}
		}
		return false
	})
	adapter.mu.Lock()
	active := adapter.sessions[session.AgentSessionID].activeTurn
	adapter.mu.Unlock()
	if active != nil {
		t.Fatalf("fenced provider turn was adopted: %#v", active)
	}
}

func TestCodexGoalProvenanceUsesLiveThreadIDForPreStartCapturedSession(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	adapter.SetGoalProvenanceDurableSink(ledger)
	identity := goalOperationIdentity{operationID: "goal-live-thread", revision: 1}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "continue", "createdAt": int64(1), "updatedAt": int64(2)}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		t.Fatalf("bind generation: %v", err)
	}
	staleCapturedSession := session
	staleCapturedSession.ProviderSessionID = ""
	adapter.observeGoalTurnGeneration(staleCapturedSession, "provider-turn-live-thread", goal)
	adapter.mu.Lock()
	evidence := adapter.sessions[session.AgentSessionID].goalTurnEvidence["provider-turn-live-thread"]
	adapter.mu.Unlock()
	if evidence == nil || !evidence.bound || evidence.identity != identity {
		t.Fatalf("evidence=%#v, want durable identity %#v", evidence, identity)
	}
}

func TestCodexGoalProvenanceDurableCollisionRemainsAmbiguousAfterRestart(t *testing.T) {
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	first, _, session := startedAppServerAdapter(t)
	first.SetGoalProvenanceDurableSink(ledger)
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "same", "createdAt": int64(1), "updatedAt": int64(2)}
	firstIdentity := goalOperationIdentity{operationID: "goal-first", revision: 1}
	first.replaceGoalOperationIdentity(session.AgentSessionID, firstIdentity.operationID, firstIdentity.revision, 0)
	if err := first.bindGoalGeneration(context.Background(), session, goal, firstIdentity); err != nil {
		t.Fatalf("bind first: %v", err)
	}

	restarted, transport, restartedSession := startedAppServerAdapter(t)
	restarted.SetGoalProvenanceDurableSink(ledger)
	secondIdentity := goalOperationIdentity{operationID: "goal-second", revision: 2}
	restarted.replaceGoalOperationIdentity(restartedSession.AgentSessionID, secondIdentity.operationID, secondIdentity.revision, 0)
	if err := restarted.bindGoalGeneration(context.Background(), restartedSession, goal, secondIdentity); err == nil {
		t.Fatal("durable collision did not fail closed")
	}
	restarted.mu.Lock()
	client := restarted.sessions[restartedSession.AgentSessionID].client
	restarted.mu.Unlock()
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after durable provenance collision")
	}
	restarted.mu.Lock()
	appSession := restarted.sessions[restartedSession.AgentSessionID]
	degraded, active := appSession.provenanceDegraded, appSession.activeTurn
	restarted.mu.Unlock()
	if !degraded || active != nil {
		t.Fatalf("degraded=%v active=%#v", degraded, active)
	}
	_ = transport
}

func TestCodexGoalProvenanceWorkingSetStaysBoundedAcrossManyContinuations(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	adapter.SetGoalProvenanceDurableSink(ledger)
	for i := 1; i <= 320; i++ {
		identity := goalOperationIdentity{operationID: fmt.Sprintf("goal-op-%d", i), revision: int64(i)}
		goal := map[string]any{"threadId": session.ProviderSessionID, "objective": fmt.Sprintf("goal-%d", i), "createdAt": int64(i), "updatedAt": int64(i + 1)}
		providerTurnID := fmt.Sprintf("provider-turn-%d", i)
		adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
		if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
			t.Fatalf("bind generation %d: %v", i, err)
		}
		adapter.observeGoalTurnGeneration(session, providerTurnID, goal)
		adapter.mu.Lock()
		if adapter.sessions[session.AgentSessionID].pendingGoalTurns == nil {
			adapter.sessions[session.AgentSessionID].pendingGoalTurns = make(map[string]*codexPendingGoalTurn)
		}
		adapter.sessions[session.AgentSessionID].pendingGoalTurns[providerTurnID] = &codexPendingGoalTurn{
			providerTurnID: providerTurnID, session: session, state: codexGoalTurnPending,
		}
		adapter.mu.Unlock()
		appTurn := &codexAppServerActiveTurn{turnID: fmt.Sprintf("local-turn-%d", i)}
		if !adapter.beginGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn, identity) {
			t.Fatalf("begin handoff %d", i)
		}
		adapter.drainGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn)
		adapter.endActiveTurn(session.AgentSessionID, appTurn)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, evidence, bindings := appSession.provenanceDegraded, len(appSession.goalTurnEvidence), len(appSession.goalGenerationBindings)
	adapter.mu.Unlock()
	if degraded || evidence != 0 || bindings > maxGoalGenerationBindings {
		t.Fatalf("degraded=%v evidence=%d bindings=%d", degraded, evidence, bindings)
	}
}
