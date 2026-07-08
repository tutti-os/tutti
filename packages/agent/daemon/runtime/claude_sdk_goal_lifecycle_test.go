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
		pendingRequests: make(map[string]*pendingACPRequest),
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

// The adapter must publish adapter-origin lifecycle snapshots at every turn
// transition it emits, with a per-session monotonic seq, so the session flips
// to snapshot-authority mode and never recomputes lifecycle from discrete
// events (ADR 0008 Phase B).
func TestClaudeSDKAdapterStampsLifecycleSnapshots(t *testing.T) {
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
	settled := claudeSDKSnapshotForEvent(t, emitted, activityshared.EventTurnCompleted)
	if settled.Phase != string(activityshared.TurnPhaseSettled) ||
		settled.Outcome != string(activityshared.TurnOutcomeCompleted) ||
		settled.ActiveTurnID != "" || settled.Seq <= running.Seq {
		t.Fatalf("settled snapshot = %#v", settled)
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

// Cancel on a live turn synthesizes a stamped terminal transition and
// forwards the cancel to the sidecar.
func TestClaudeSDKCancelLiveTurnEmitsStampedTerminal(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	// The live turn is identified by the adapter's own registry, not by the
	// Cancel argument (which is the cancel reason). Register a live turn and pass
	// an unrelated reason to prove the terminal is stamped for the real turnID.
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	// turn.canceled folds into turn.completed with an interrupted outcome at
	// event construction.
	snapshot := claudeSDKSnapshotForEvent(t, events, activityshared.EventTurnCompleted)
	if snapshot.Phase != string(activityshared.TurnPhaseSettled) ||
		snapshot.Outcome != string(activityshared.TurnOutcomeInterrupted) ||
		snapshot.ActiveTurnID != "" {
		t.Fatalf("cancel snapshot = %#v", snapshot)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" {
		t.Fatalf("sent requests = %#v, want one cancel", sent)
	}
}

// The controller calls adapter.Cancel(ctx, session, reason) — the third argument
// is the cancel reason ("user"), not a turnID. Cancel must stamp the interrupted
// terminal for the real live turnID taken from its own registry, never for the
// reason string, and must leave the waiter registered so the sidecar's own
// turn_canceled can still settle it (removing it would break /goal clear and
// drop the natural settle).
func TestClaudeSDKCancelUsesRegistryTurnNotReasonArg(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	// Reason is the free-form stop reason the controller passes, not a turnID.
	events, err := adapter.Cancel(context.Background(), session, "user")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	var canceledTurnIDs []string
	for _, event := range events {
		if event.Type == activityshared.EventTurnCompleted {
			canceledTurnIDs = append(canceledTurnIDs, event.Payload.TurnID)
		}
		if event.Payload.TurnID == "user" {
			t.Fatalf("Cancel stamped a terminal for the reason string as a turnID: %#v", event)
		}
	}
	if len(canceledTurnIDs) != 1 || canceledTurnIDs[0] != "turn-live" {
		t.Fatalf("canceled turn ids = %#v, want [turn-live]", canceledTurnIDs)
	}
	// The waiter must survive so the sidecar's natural turn_canceled still settles
	// it (the /goal clear contract; the controller separately cancels the turn
	// context to unblock Exec).
	if adapter.claudeSDKTurnWaiter(adapterSession, "turn-live") == nil {
		t.Fatal("Cancel removed the live turn waiter; the sidecar settle would be dropped")
	}
}

// A cancel racing the turn's own settle must not fabricate a second,
// contradicting terminal event (the stuck-view class ADR 0008 removes).
func TestClaudeSDKCancelAfterSettleIsIdempotent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
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
	defer conn.Close()
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
	defer conn.Close()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	if _, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("plain steer"), "", "turn-steer"); handled || err != nil {
		t.Fatalf("non-goal prompt handled=%v err=%v", handled, err)
	}

	type goalExecResult struct {
		events  []activityshared.Event
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		events, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal clear"), "", "turn-goal")
		results <- goalExecResult{events, handled, err}
	}()
	clearRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	conn.pushEvent(claudeSDKSidecarEvent{ID: clearRequest.ID, Type: "ok"})
	result := <-results
	events, handled, err := result.events, result.handled, result.err
	if err != nil || !handled {
		t.Fatalf("ExecGoalControl handled=%v err=%v", handled, err)
	}
	var sawSteeredMessage bool
	for _, event := range events {
		if event.Payload.Role == activityshared.MessageRoleUser && event.Payload.Metadata["goalControl"] == true {
			sawSteeredMessage = true
		}
	}
	if !sawSteeredMessage {
		t.Fatalf("no goal-control user message in %#v", events)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_cleared")
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("goal after ExecGoalControl clear = %#v", goal)
	}
	// Clear must interrupt the live turn BEFORE forwarding the command: the
	// sidecar queues goal execs behind the live turn, and a goal turn only
	// settles once the goal is met — a queued clear would never run while
	// the goal loop keeps working.
	assertClaudeSDKCancelBeforeGoalExec(t, conn.sentRequests(), "/goal clear")
	interrupted := claudeSDKSnapshotForEvent(t, events, activityshared.EventTurnCompleted)
	if interrupted.Outcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("interrupt snapshot = %#v", interrupted)
	}
	// The waiter still belongs to the sidecar's natural turn_canceled settle;
	// the synthetic terminal must not force-remove it.
	if adapter.claudeSDKTurnWaiter(adapterSession, "turn-live") == nil {
		t.Fatal("live turn waiter removed by goal control")
	}
}

func assertClaudeSDKCancelBeforeGoalExec(
	t *testing.T,
	sent []claudeSDKSidecarRequest,
	prompt string,
) {
	t.Helper()
	cancelIndex, execIndex := -1, -1
	for i, request := range sent {
		switch {
		case request.Type == "cancel" && cancelIndex == -1:
			cancelIndex = i
		case request.Type == "exec" &&
			payloadString(request.Payload, "prompt") == prompt &&
			execIndex == -1:
			execIndex = i
		}
	}
	if cancelIndex == -1 || execIndex == -1 || cancelIndex > execIndex {
		t.Fatalf("want sidecar cancel before %q exec, got %#v", prompt, sent)
	}
}

// A /goal set steered into a running turn must NOT interrupt it: the new
// objective queues behind the live turn; only clear kills the running goal
// loop.
func TestClaudeSDKExecGoalControlSetDoesNotInterrupt(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer conn.Close()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	type goalExecResult struct {
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		_, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal 换个新目标"), "", "turn-goal")
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

// Every reserved clear keyword must take the full clear path — /goal reset
// interrupts like clear and must not arm a goal turn as if it set a new
// objective.
func TestClaudeSDKGoalResetClearsWithoutArming(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer conn.Close()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	type goalExecResult struct {
		handled bool
		err     error
	}
	results := make(chan goalExecResult, 1)
	go func() {
		_, handled, err := adapter.ExecGoalControl(context.Background(), session, textPrompt("/goal reset"), "", "turn-goal")
		results <- goalExecResult{handled, err}
	}()
	request := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal reset")
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	result := <-results
	if result.err != nil || !result.handled {
		t.Fatalf("ExecGoalControl handled=%v err=%v", result.handled, result.err)
	}
	assertClaudeSDKCancelBeforeGoalExec(t, conn.sentRequests(), "/goal reset")
	adapter.mu.Lock()
	armTurnID := adapterSession.goalArmTurnID
	adapter.mu.Unlock()
	if armTurnID != "" {
		t.Fatalf("goal reset armed a goal turn: %q", armTurnID)
	}
}

// The direct control API path (GoalControlClear) has the same queued-exec
// hazard as the typed path and must interrupt the live turn first too.
func TestClaudeSDKGoalControlClearInterruptsLiveTurn(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer conn.Close()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

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
	assertClaudeSDKCancelBeforeGoalExec(t, conn.sentRequests(), "/goal clear")
	interrupted := claudeSDKSnapshotForEvent(t, result.events, activityshared.EventTurnCompleted)
	if interrupted.Outcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("interrupt snapshot = %#v", interrupted)
	}
}

// Claude Code emits no goal_status attachment on achievement: the goal loop
// holds the turn open via Stop-hook feedback until the condition is met, so
// a normally completed turn IS the achievement signal and must flip the
// mirror to complete (the user-visible "goal done" state).
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
			if event.Payload.Metadata["acpSessionUpdate"] != nil {
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
	defer conn.Close()
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

func TestClaudeSDKGoalArmTurnCanceledClearsMirror(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer conn.Close()
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

func assertClaudeSDKGoalUpdateEvent(t *testing.T, events []activityshared.Event, updateType string) {
	t.Helper()
	for _, event := range events {
		if event.Payload.Metadata == nil {
			continue
		}
		if event.Payload.Metadata["acpSessionUpdate"] == updateType {
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
