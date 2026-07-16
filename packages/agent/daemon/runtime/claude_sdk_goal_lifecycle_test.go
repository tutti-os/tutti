package agentruntime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func newClaudeSDKLifecycleTestSession(t *testing.T, adapter *ClaudeCodeSDKAdapter, conn ProcessConnection) (Session, *claudeSDKAdapterSession) {
	t.Helper()
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		conn:            conn,
		reader:          &claudeSDKLineReader{conn: conn},
		session:         session,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
		liveState:       newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)
	return session, adapterSession
}

func claudeSDKSnapshotForEvent(t *testing.T, events []activityshared.Event, eventType activityshared.EventType) activityshared.TurnLifecycleSnapshot {
	t.Helper()
	for _, event := range events {
		if event.Type != eventType {
			continue
		}
		snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
		if !ok {
			t.Fatalf("event %s carries no lifecycle snapshot: %#v", eventType, event.Payload.Metadata)
		}
		return snapshot
	}
	t.Fatalf("no %s event in %#v", eventType, events)
	return activityshared.TurnLifecycleSnapshot{}
}

// Interaction transitions still carry adapter snapshots, while SDK provider
// completion must not stamp a settled canonical root lifecycle.
func TestClaudeSDKAdapterKeepsCanonicalLifecycleLiveAtProviderCompletion(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	var emitted []activityshared.Event
	waiter := adapter.registerClaudeSDKTurn(adapterSession, "turn-1", func(events []activityshared.Event) {
		emitted = append(emitted, events...)
	})

	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "approval_requested",
		Payload: map[string]any{
			"turnId":    "turn-1",
			"requestId": "approval-1",
			"toolName":  "Bash",
			"options": []any{
				map[string]any{"kind": "allow_once", "name": "Allow", "optionId": "allow"},
			},
		},
	})
	waiting := claudeSDKSnapshotForEvent(t, emitted, activityshared.EventTurnUpdated)
	if waiting.Origin != activityshared.TurnLifecycleOriginAdapter ||
		waiting.Phase != string(activityshared.TurnPhaseWaitingApproval) ||
		waiting.ActiveTurnID != "turn-1" || waiting.Seq == 0 {
		t.Fatalf("waiting snapshot = %#v", waiting)
	}

	emitted = nil
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "approval_resolved",
		Payload: map[string]any{
			"turnId":    "turn-1",
			"requestId": "approval-1",
			"optionId":  "allow",
		},
	})
	running := claudeSDKSnapshotForEvent(t, emitted, activityshared.EventTurnUpdated)
	if running.Phase != string(activityshared.TurnPhaseRunning) || running.Seq <= waiting.Seq {
		t.Fatalf("resolved snapshot = %#v, want running with seq > %d", running, waiting.Seq)
	}

	emitted = nil
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-1", "stopReason": "end_turn"},
	})
	providerCompleted := activityEventsWithType(emitted, activityshared.EventRootProviderTurnCompleted)
	if len(providerCompleted) != 1 || providerCompleted[0].Payload.TurnID != "turn-1" ||
		providerCompleted[0].Payload.ProviderTurnID != "turn-1" ||
		providerCompleted[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("provider completion = %#v", providerCompleted)
	}
	if _, ok := activityshared.TurnLifecycleSnapshotFromEvent(providerCompleted[0]); ok {
		t.Fatalf("provider completion must not settle canonical lifecycle: %#v", providerCompleted[0])
	}
	select {
	case result := <-waiter.done:
		if result.err != nil {
			t.Fatalf("waiter err = %v", result.err)
		}
	default:
		t.Fatal("terminal event did not settle the waiter")
	}
}

// Cancel forwards the request but waits for the SDK's terminal confirmation.
func TestClaudeSDKCancelLiveTurnWaitsForProviderTerminal(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	// The live turn is identified by the adapter's own registry, not by the
	// Cancel argument (which is the cancel reason). Register a live turn and pass
	// an unrelated reason to prove the terminal is stamped for the real turnID.
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("cancel events = %#v, want no unconfirmed terminal", events)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" {
		t.Fatalf("sent requests = %#v, want one cancel", sent)
	}
}

// The controller calls adapter.Cancel(ctx, session, reason) — the third argument
// is the cancel reason ("user"), not a turnID. Cancel must not stamp either
// value as a terminal, and must leave the waiter registered so the sidecar's own
// turn_canceled can still settle it without dropping the natural terminal.
func TestClaudeSDKCancelUsesRegistryTurnNotReasonArg(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	// Reason is the free-form stop reason the controller passes, not a turnID.
	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	for _, event := range events {
		if event.Payload.TurnID == "user" {
			t.Fatalf("Cancel stamped a terminal for the reason string as a turnID: %#v", event)
		}
	}
	if len(events) != 0 {
		t.Fatalf("cancel events = %#v, want no unconfirmed terminal", events)
	}
	// The waiter must survive so the sidecar's natural turn_canceled still
	// settles it after the controller cancels the turn context.
	if adapter.claudeSDKTurnWaiter(adapterSession, "turn-live") == nil {
		t.Fatal("Cancel removed the live turn waiter; the sidecar settle would be dropped")
	}
}

// A cancel racing the turn's own settle must not fabricate a second,
// contradicting terminal event (the stuck-view class ADR 0008 removes).
func TestClaudeSDKCancelAfterSettleIsIdempotent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	adapter.registerClaudeSDKTurn(adapterSession, "turn-1", nil)
	adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-1"},
	})

	events, err := adapter.Cancel(context.Background(), session, "turn-1")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("cancel re-terminated a settled turn: %#v", events)
	}
}

// Goal set/clear keep the CLI in sync through its native /goal command and
// mirror the state locally for the GUI banner.
func TestClaudeSDKGoalControlSetAndClear(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	type controlResult struct {
		events []activityshared.Event
		goal   map[string]any
		err    error
	}
	results := make(chan controlResult, 1)
	go func() {
		events, goal, err := adapter.GoalControl(context.Background(), session, GoalControlSet, "ship it")
		results <- controlResult{events, goal, err}
	}()
	request := waitForClaudeSDKSentRequest(t, conn, "exec")
	if prompt := payloadString(request.Payload, "prompt"); prompt != "/goal ship it" {
		t.Fatalf("goal set prompt = %q", prompt)
	}
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	result := <-results
	if result.err != nil {
		t.Fatalf("GoalControl set: %v", result.err)
	}
	if result.goal["objective"] != "ship it" || result.goal["status"] != "active" {
		t.Fatalf("goal after set = %#v", result.goal)
	}
	assertClaudeSDKGoalUpdateEvent(t, result.events, "thread_goal_update")

	go func() {
		events, goal, err := adapter.GoalControl(context.Background(), session, GoalControlClear, "")
		results <- controlResult{events, goal, err}
	}()
	clearRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	conn.pushEvent(claudeSDKSidecarEvent{ID: clearRequest.ID, Type: "ok"})
	result = <-results
	if result.err != nil {
		t.Fatalf("GoalControl clear: %v", result.err)
	}
	if len(result.goal) != 0 {
		t.Fatalf("goal after clear = %#v", result.goal)
	}
	assertClaudeSDKGoalUpdateEvent(t, result.events, "thread_goal_cleared")
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("local goal not cleared: %#v", goal)
	}
	clearTurnID := payloadString(clearRequest.Payload, "turnId")
	if !adapter.isGoalClearControlTurn(adapterSession, clearTurnID) {
		t.Fatalf("clear turn %q was not registered as a control turn", clearTurnID)
	}
}

// A failed /goal send must leave the mirror untouched — the GUI must never
// show a goal state the CLI did not receive.
func TestClaudeSDKGoalControlSendFailureRollsBackMirror(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &failingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

	if _, _, err := adapter.GoalControl(context.Background(), session, GoalControlClear, ""); err == nil {
		t.Fatal("GoalControl clear must surface the send failure")
	}
	if goal := adapter.localGoal(adapterSession); goal["objective"] != "ship it" || goal["status"] != "active" {
		t.Fatalf("mirror mutated by failed clear: %#v", goal)
	}
	adapter.mu.Lock()
	clearControlTurnCount := len(adapterSession.goalClearControlTurns)
	adapter.mu.Unlock()
	if clearControlTurnCount != 0 {
		t.Fatalf("failed clear left %d control turns registered", clearControlTurnCount)
	}

	if _, _, err := adapter.GoalControl(context.Background(), session, GoalControlSet, "new objective"); err == nil {
		t.Fatal("GoalControl set must surface the send failure")
	}
	if goal := adapter.localGoal(adapterSession); goal["objective"] != "ship it" {
		t.Fatalf("mirror mutated by failed set: %#v", goal)
	}
}

type failingClaudeSDKConnection struct{}

func (*failingClaudeSDKConnection) Send([]byte) error {
	return errors.New("sidecar send failed")
}

func (*failingClaudeSDKConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, errors.New("sidecar receive failed")
}

func (*failingClaudeSDKConnection) Close() error { return nil }

// Claude Code has no paused goal state; the adapter must reject pause and
// resume instead of emulating semantics the CLI cannot honor. The GUI hides
// these controls via the missing CapabilityGoalPause.
func TestClaudeSDKGoalControlPauseAndResumeUnsupported(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

	for _, action := range []GoalControlAction{GoalControlPause, GoalControlResume} {
		if _, _, err := adapter.GoalControl(context.Background(), session, action, ""); err == nil {
			t.Fatalf("GoalControl %s must be unsupported for claude", action)
		}
	}
	if sent := conn.sentRequests(); len(sent) != 0 {
		t.Fatalf("unsupported goal actions must not reach the sidecar: %#v", sent)
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal mirror mutated by rejected action: %#v", goal)
	}
}

// ExecGoalControl ignores non-goal prompts and forwards /goal through the
// sidecar's native prompt queue while another turn holds the turn slot.
func TestClaudeSDKExecGoalControl(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	if _, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("plain steer"), ""); handled || err != nil {
		t.Fatalf("non-goal prompt handled=%v err=%v", handled, err)
	}

	type goalExecResult struct {
		events  []activityshared.Event
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		events, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal clear"), "")
		results <- goalExecResult{events, handled, err}
	}()
	clearRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	conn.pushEvent(claudeSDKSidecarEvent{ID: clearRequest.ID, Type: "ok"})
	result := <-results
	events, handled, err := result.events, result.handled, result.err
	if err != nil || !handled {
		t.Fatalf("ExecGoalControl handled=%v err=%v", handled, err)
	}
	var sawControlMessage bool
	for _, event := range events {
		if event.Payload.Role == activityshared.MessageRoleUser && event.Payload.Metadata["goalControl"] == true {
			sawControlMessage = true
			if event.Payload.TurnID != "" {
				t.Fatalf("goal-control audit message turn id = %q, want empty", event.Payload.TurnID)
			}
		}
	}
	if !sawControlMessage {
		t.Fatalf("no goal-control user message in %#v", events)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_cleared")
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("goal after ExecGoalControl clear = %#v", goal)
	}
	// Clear changes future Goal scheduling. The current provider Turn remains
	// authoritative and must run to its natural terminal event.
	assertClaudeSDKNoCancelForGoalExec(t, conn.sentRequests(), "/goal clear")
	if terminals := activityEventsWithType(events, activityshared.EventTurnCompleted); len(terminals) != 0 {
		t.Fatalf("goal clear emitted unconfirmed canonical terminal: %#v", terminals)
	}
	// The waiter still belongs to the sidecar's natural turn_canceled settle;
	// the synthetic terminal must not force-remove it.
	if adapter.claudeSDKTurnWaiter(adapterSession, "turn-live") == nil {
		t.Fatal("live turn waiter removed by goal control")
	}
}

func assertClaudeSDKNoCancelForGoalExec(
	t *testing.T,
	sent []claudeSDKSidecarRequest,
	prompt string,
) {
	t.Helper()
	foundExec := false
	for _, request := range sent {
		if request.Type == "cancel" {
			t.Fatalf("goal control canceled the current Turn before %q: %#v", prompt, sent)
		}
		if request.Type == "exec" && payloadString(request.Payload, "prompt") == prompt {
			foundExec = true
		}
	}
	if !foundExec {
		t.Fatalf("missing %q exec in %#v", prompt, sent)
	}
}

// A /goal set steered into a running turn must NOT interrupt it: the new
// objective queues behind the live turn.
func TestClaudeSDKExecGoalControlSetDoesNotInterrupt(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	type goalExecResult struct {
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		_, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal 换个新目标"), "")
		results <- goalExecResult{handled, err}
	}()
	request := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal 换个新目标")
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	result := <-results
	if result.err != nil || !result.handled {
		t.Fatalf("ExecGoalControl handled=%v err=%v", result.handled, result.err)
	}
	for _, request := range conn.sentRequests() {
		if request.Type == "cancel" {
			t.Fatalf("goal set interrupted the live turn: %#v", conn.sentRequests())
		}
	}
}

// Every reserved clear keyword must take the full clear path without
// interrupting the current Turn or arming a new Goal Turn.
func TestClaudeSDKGoalResetClearsWithoutArming(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	type goalExecResult struct {
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		_, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal reset"), "")
		results <- goalExecResult{handled, err}
	}()
	request := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal reset")
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	result := <-results
	if result.err != nil || !result.handled {
		t.Fatalf("ExecGoalControl handled=%v err=%v", result.handled, result.err)
	}
	assertClaudeSDKNoCancelForGoalExec(t, conn.sentRequests(), "/goal reset")
	adapter.mu.Lock()
	armTurnID := adapterSession.goalArmTurnID
	adapter.mu.Unlock()
	if armTurnID != "" {
		t.Fatalf("goal reset armed a goal turn: %q", armTurnID)
	}
}

// The direct control API path has the same non-interrupting semantics as the
// typed path: it clears future Goal work and lets the current Turn finish.
func TestClaudeSDKGoalControlClearDoesNotInterruptLiveTurn(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.mu.Lock()
	adapterSession.goalArmTurnID = "turn-goal-arm"
	adapterSession.rootProviderTurns = map[string]struct{}{"turn-goal-arm": {}}
	adapter.mu.Unlock()

	type controlResult struct {
		events []activityshared.Event
		err    error
	}
	results := make(chan controlResult, 1)
	go func() {
		events, _, err := adapter.GoalControl(context.Background(), session, GoalControlClear, "")
		results <- controlResult{events, err}
	}()
	clearRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	conn.pushEvent(claudeSDKSidecarEvent{ID: clearRequest.ID, Type: "ok"})
	result := <-results
	if result.err != nil {
		t.Fatalf("GoalControl clear: %v", result.err)
	}
	assertClaudeSDKNoCancelForGoalExec(t, conn.sentRequests(), "/goal clear")
	if terminals := activityEventsWithType(result.events, activityshared.EventTurnCompleted); len(terminals) != 0 {
		t.Fatalf("goal clear emitted unconfirmed canonical terminal: %#v", terminals)
	}
}

// Claude Code emits no goal_status attachment on achievement: the goal loop
// holds the provider turn open via Stop-hook feedback until the condition is
// met, so a normally completed provider turn flips the provider-native goal
// mirror to complete. Neither fact is a canonical root-turn terminal; tuttid
// may still keep that root turn waiting for provider-native children.
func TestClaudeSDKGoalCompletesWhenTurnSettles(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-goal"},
	})
	if err != nil || !terminal {
		t.Fatalf("turn_completed terminal=%v err=%v", terminal, err)
	}
	providerCompleted := activityEventsWithType(events, activityshared.EventRootProviderTurnCompleted)
	if len(providerCompleted) != 1 || providerCompleted[0].Payload.TurnID != "turn-goal" {
		t.Fatalf("root provider completion = %#v", providerCompleted)
	}
	if canonicalCompleted := activityEventsWithType(events, activityshared.EventTurnCompleted); len(canonicalCompleted) != 0 {
		t.Fatalf("provider and goal completion emitted canonical root completion: %#v", canonicalCompleted)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_update")
	if goal := adapter.localGoal(adapterSession); goal["status"] != "complete" {
		t.Fatalf("goal after completed turn = %#v", goal)
	}
}

// A manually stopped or failed turn keeps the goal active — matching the
// CLI, where an interrupted goal stays armed and resumes after the next user
// message. Interrupting an unmet goal surfaces as turn_canceled or
// turn_failed (the CLI returns an error_during_execution result), never as
// turn_completed, so a manual stop can never be read as achievement.
func TestClaudeSDKGoalSurvivesInterruptAndFailure(t *testing.T) {
	t.Parallel()

	for _, sidecarType := range []string{"turn_canceled", "turn_failed"} {
		adapter := NewClaudeCodeSDKAdapter(nil)
		conn := &recordingClaudeSDKConnection{}
		session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
		adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

		events, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
			Type:    sidecarType,
			Payload: map[string]any{"turnId": "turn-goal"},
		})
		if err != nil {
			t.Fatalf("%s: %v", sidecarType, err)
		}
		for _, event := range events {
			if event.Payload.Metadata["sessionUpdateKind"] != nil {
				t.Fatalf("%s must not touch the goal mirror: %#v", sidecarType, events)
			}
		}
		if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
			t.Fatalf("goal after %s = %#v", sidecarType, goal)
		}
	}
}

// While a /goal set is still queued behind a live turn, that turn's settle
// says nothing about the goal; only the arm turn's own completion counts.
// A canceled arm turn never reached the CLI, so the mirror clears.
func TestClaudeSDKGoalArmTurnGatesCompletion(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	type controlResult struct {
		err error
	}
	results := make(chan controlResult, 1)
	go func() {
		_, _, err := adapter.GoalControl(context.Background(), session, GoalControlSet, "ship it")
		results <- controlResult{err}
	}()
	setRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal ship it")
	conn.pushEvent(claudeSDKSidecarEvent{ID: setRequest.ID, Type: "ok"})
	if result := <-results; result.err != nil {
		t.Fatalf("GoalControl set: %v", result.err)
	}
	armTurnID := payloadString(setRequest.Payload, "turnId")
	if armTurnID == "" {
		t.Fatal("goal set exec carries no turnId")
	}

	// An earlier turn settling must not complete the not-yet-started goal.
	if _, _, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-earlier", claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": "turn-earlier"},
	}); err != nil {
		t.Fatalf("earlier turn_completed: %v", err)
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal completed by unrelated turn: %#v", goal)
	}

	// The arm turn's own completion is the achievement signal.
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, armTurnID, claudeSDKSidecarEvent{
		Type:    "turn_completed",
		Payload: map[string]any{"turnId": armTurnID},
	})
	if err != nil {
		t.Fatalf("arm turn_completed: %v", err)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_update")
	if goal := adapter.localGoal(adapterSession); goal["status"] != "complete" {
		t.Fatalf("goal after arm turn completed = %#v", goal)
	}
}

func TestClaudeSDKGoalArmTurnCarriesDurableGoalIdentity(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "preceding-user-turn", "preceding-provider-turn")

	done := make(chan error, 1)
	go func() {
		_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
			Action: GoalControlSet, Objective: "ship it", OperationID: "goal-op-7", Revision: 7, RepairEpoch: 2,
		})
		done <- err
	}()
	setRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal ship it")
	conn.pushEvent(claudeSDKSidecarEvent{ID: setRequest.ID, Type: "ok"})
	if err := <-done; err != nil {
		t.Fatalf("ApplyGoal set: %v", err)
	}
	turnID := payloadString(setRequest.Payload, "turnId")
	if payloadString(setRequest.Payload, "goalOperationId") != "goal-op-7" || payloadInt64(setRequest.Payload, "goalRevision") != 7 {
		t.Fatalf("goal exec payload = %#v", setRequest.Payload)
	}
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
		Type: "turn_started", Payload: map[string]any{
			"turnId": turnID, "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-7", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(2),
		},
	})
	if err != nil || len(events) != 1 {
		t.Fatalf("turn_started events=%#v error=%v", events, err)
	}
	metadata := events[0].Payload.Metadata
	if metadata["turnOrigin"] != "goal_arm" || metadata["sourceGoalOperationId"] != "goal-op-7" || metadata["sourceGoalRevision"] != int64(7) || metadata["sourceGoalRepairEpoch"] != int64(2) {
		t.Fatalf("goal arm metadata = %#v", metadata)
	}
	if events[0].Payload.TurnID != turnID || adapter.claudeSDKRootTurnID(adapterSession, "") != turnID {
		t.Fatalf("goal arm root mapping = event:%q adapter:%q, want %q", events[0].Payload.TurnID, adapter.claudeSDKRootTurnID(adapterSession, ""), turnID)
	}
}

func TestClaudeSDKGoalSetAckThenImmediateClearPreservesDelayedArmUntilTerminal(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	setDone := make(chan error, 1)
	go func() {
		_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
			Action: GoalControlSet, Objective: "ship it", OperationID: "goal-op-set", Revision: 1,
		})
		setDone <- err
	}()
	setRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal ship it")
	conn.pushEvent(claudeSDKSidecarEvent{ID: setRequest.ID, Type: "ok"})
	if err := <-setDone; err != nil {
		t.Fatalf("set ack: %v", err)
	}

	clearDone := make(chan error, 1)
	go func() {
		_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
			Action: GoalControlClear, OperationID: "goal-op-clear", Revision: 2, RepairEpoch: 7,
		})
		clearDone <- err
	}()
	clearRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	if payloadInt64(clearRequest.Payload, "goalRepairEpoch") != 7 {
		t.Fatalf("clear repair epoch payload=%#v", clearRequest.Payload)
	}
	conn.pushEvent(claudeSDKSidecarEvent{ID: clearRequest.ID, Type: "ok"})
	if err := <-clearDone; err != nil {
		t.Fatalf("clear ack: %v", err)
	}

	setTurnID := payloadString(setRequest.Payload, "turnId")
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, setTurnID, claudeSDKSidecarEvent{
		Type: "turn_started",
		Payload: map[string]any{
			"turnId": setTurnID, "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-set", "sourceGoalRevision": float64(1),
		},
	})
	if err != nil || len(events) != 1 {
		t.Fatalf("delayed arm events=%#v error=%v", events, err)
	}
	metadata := events[0].Payload.Metadata
	if metadata["sourceGoalOperationId"] != "goal-op-set" || metadata["sourceGoalRevision"] != int64(1) {
		t.Fatalf("delayed arm provenance=%#v", metadata)
	}
	assertClaudeSDKNoCancelForGoalExec(t, conn.sentRequests(), "/goal clear")

	clearEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, payloadString(clearRequest.Payload, "turnId"), claudeSDKSidecarEvent{
		Type: "goal_command_started",
		Payload: map[string]any{
			"turnId":      payloadString(clearRequest.Payload, "turnId"),
			"operationId": "goal-op-clear", "revision": float64(2), "repairEpoch": float64(7), "action": "clear",
		},
	})
	if err != nil || len(clearEvents) != 1 {
		t.Fatalf("clear applied events=%#v error=%v", clearEvents, err)
	}
	evidence := payloadObject(clearEvents[0].Payload.Metadata["goalControlEvidence"])
	if evidence["phase"] != "applied" || evidence["operationId"] != "goal-op-clear" || evidence["revision"] != int64(2) || evidence["repairEpoch"] != int64(7) {
		t.Fatalf("clear applied evidence=%#v", evidence)
	}
}

func TestClaudeSDKGoalArmTurnCanceledClearsMirror(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	done := make(chan error, 1)
	go func() {
		_, _, err := adapter.GoalControl(context.Background(), session, GoalControlSet, "ship it")
		done <- err
	}()
	setRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal ship it")
	conn.pushEvent(claudeSDKSidecarEvent{ID: setRequest.ID, Type: "ok"})
	if err := <-done; err != nil {
		t.Fatalf("GoalControl set: %v", err)
	}
	armTurnID := payloadString(setRequest.Payload, "turnId")

	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, armTurnID, claudeSDKSidecarEvent{
		Type:    "turn_canceled",
		Payload: map[string]any{"turnId": armTurnID},
	})
	if err != nil {
		t.Fatalf("arm turn_canceled: %v", err)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_cleared")
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("mirror kept a goal the CLI never armed: %#v", goal)
	}
}

func TestClaudeSDKDelayedOlderRepairEpochIsPreciselyCanceled(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.mu.Lock()
	adapterSession.goalOperationID = "goal-op"
	adapterSession.goalRevision = 7
	adapterSession.goalRepairEpoch = 2
	adapter.mu.Unlock()
	_, _, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-old", claudeSDKSidecarEvent{
		Type: "turn_started",
		Payload: map[string]any{
			"turnId": "goal-turn-old", "turnOrigin": "goal_continuation",
			"sourceGoalOperationId": "goal-op", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(1),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" || payloadString(sent[0].Payload, "turnId") != "goal-turn-old" || payloadInt64(sent[0].Payload, "goalRepairEpoch") != 1 {
		t.Fatalf("precise stale repair cancellation = %#v", sent)
	}
}

func TestClaudeSDKStaleFailureCannotRestoreNewerGoalState(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	adapterSession := &claudeSDKAdapterSession{}
	adapterSession.liveState.goal = map[string]any{"objective": "new", "status": "active"}
	adapterSession.goalOperationID = "goal-op-2"
	adapterSession.goalRevision = 2
	adapterSession.goalArmTurnID = "arm-2"

	adapter.restoreClaudeGoalMirrorIfCurrent(
		adapterSession,
		"goal-op-1",
		1,
		0,
		map[string]any{"objective": "old", "status": "active"},
	)
	adapter.restoreClaudeGoalArmIfCurrent(adapterSession, "goal-op-1", 1, 0, "arm-1", "old-arm")

	if goal := adapter.localGoal(adapterSession); asString(goal["objective"]) != "new" {
		t.Fatalf("stale failure restored old mirror: %#v", goal)
	}
	if adapterSession.goalArmTurnID != "arm-2" {
		t.Fatalf("stale failure restored old arm: %q", adapterSession.goalArmTurnID)
	}
}

func assertClaudeSDKGoalUpdateEvent(t *testing.T, events []activityshared.Event, updateType string) {
	t.Helper()
	for _, event := range events {
		if event.Payload.Metadata == nil {
			continue
		}
		if event.Payload.Metadata["sessionUpdateKind"] == updateType {
			return
		}
	}
	t.Fatalf("no %s event in %#v", updateType, events)
}

func waitForClaudeSDKSentRequestMatching(t *testing.T, conn *blockingClaudeSDKConnection, requestType string, prompt string) claudeSDKSidecarRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, request := range conn.sentRequests() {
			if request.Type == requestType && strings.TrimSpace(payloadString(request.Payload, "prompt")) == prompt {
				return request
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s %q; sent=%#v", requestType, prompt, conn.sentRequests())
	return claudeSDKSidecarRequest{}
}
