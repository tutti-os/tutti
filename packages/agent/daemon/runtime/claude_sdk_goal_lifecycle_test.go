package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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

type blockingFirstClaudeGoalReporter struct {
	mu      sync.Mutex
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	reports []agentsessionstore.ReportActivityInput
}

func (r *blockingFirstClaudeGoalReporter) Report(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	r.once.Do(func() {
		close(r.entered)
		select {
		case <-r.release:
		case <-ctx.Done():
		}
	})
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	r.reports = append(r.reports, report)
	r.mu.Unlock()
	return nil
}

func (r *blockingFirstClaudeGoalReporter) ReportSubmitProvenance(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	return r.Report(ctx, report)
}

func (r *blockingFirstClaudeGoalReporter) snapshot() []agentsessionstore.ReportActivityInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]agentsessionstore.ReportActivityInput(nil), r.reports...)
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
	adapter.beginClaudeSDKRootTurn(
		adapterSession,
		"turn-1",
		"provider-turn-1",
	)

	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
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
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
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
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "turn-1",
			"providerTurnId": "turn-1",
			"stopReason":     "end_turn",
		},
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
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-live", "")
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
	if payloadString(sent[0].Payload, "turnId") != "turn-live" {
		t.Fatalf("cancel payload = %#v, want turnId=turn-live", sent[0].Payload)
	}
	if payloadInt64(sent[0].Payload, "interruptTimeoutMs") != claudeSDKCancelInterruptTimeout.Milliseconds() {
		t.Fatalf("cancel payload = %#v, want interrupt timeout", sent[0].Payload)
	}
	if payloadInt64(sent[0].Payload, "drainTimeoutMs") != claudeSDKCancelDrainTimeout.Milliseconds() {
		t.Fatalf("cancel payload = %#v, want drain timeout", sent[0].Payload)
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

	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-live", "")
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
	if payloadString(conn.sentRequests()[0].Payload, "turnId") != "turn-live" {
		t.Fatalf("cancel payload = %#v, want registry turnId", conn.sentRequests()[0].Payload)
	}
}

func TestClaudeSDKCancelBeforeProviderAcceptanceIsForwarded(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-accept", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-accept", nil)

	if _, err := adapter.Cancel(context.Background(), session, "user"); err != nil {
		t.Fatalf("Cancel before provider acceptance: %v", err)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" ||
		payloadString(sent[0].Payload, "turnId") != "turn-accept" {
		t.Fatalf("cancel before acceptance = %#v", sent)
	}
}

func TestClaudeSDKCancelProviderActiveWaitsOnlyAfterSendingCancel(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-provider-active", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-provider-active", nil)

	done := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user")
		done <- err
	}()
	request := waitForClaudeSDKSentRequest(t, conn, "cancel")
	conn.pushEvent(claudeSDKSidecarEvent{
		ID: request.ID, Type: "ok",
		Payload: map[string]any{
			"canceled": true, "disposition": "provider_active",
			"turnId": "turn-provider-active", "providerTurnId": "provider-turn-active",
			"dispatchPhase": "identity_resolved",
		},
	})
	select {
	case err := <-done:
		t.Fatalf("Cancel returned before durable acceptance completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	adapter.completeClaudeSDKProviderAcceptance(adapterSession, "turn-provider-active", nil)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Cancel after durable acceptance: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Cancel did not resume after durable acceptance")
	}
}

func TestClaudeSDKCancelProviderActiveReturnsDurableAcceptanceFailure(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{
		cancelDisposition:    "provider_active",
		cancelProviderTurnID: "provider-turn-failed",
	}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-acceptance-failed", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-acceptance-failed", nil)
	acceptanceErr := errors.New("durable acceptance failed")
	adapter.completeClaudeSDKProviderAcceptance(adapterSession, "turn-acceptance-failed", acceptanceErr)

	_, err := adapter.Cancel(context.Background(), session, "user")
	if !errors.Is(err, acceptanceErr) {
		t.Fatalf("Cancel error = %v, want durable acceptance failure", err)
	}
}

func TestClaudeSDKCancelUnknownDispositionFailsClosed(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{cancelDisposition: "future_state"}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-unknown-disposition", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-unknown-disposition", nil)

	_, err := adapter.Cancel(context.Background(), session, "user")
	if err == nil || !strings.Contains(err.Error(), "unknown cancel disposition") {
		t.Fatalf("Cancel error = %v, want unknown disposition failure", err)
	}
}

func TestClaudeSDKCancelUnknownDispatchPhaseFailsClosed(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{cancelDispatchPhase: "future_phase"}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-unknown-phase", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-unknown-phase", nil)

	_, err := adapter.Cancel(context.Background(), session, "user")
	if err == nil || !strings.Contains(err.Error(), "unknown cancel dispatch phase") {
		t.Fatalf("Cancel error = %v, want unknown dispatch phase failure", err)
	}
}

func TestClaudeSDKCancelMismatchIsNotTargetAbsent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	canceled := false
	conn := &ackClaudeSDKConnection{
		cancelResult:      &canceled,
		cancelDisposition: "mismatch",
	}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-mismatch", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-mismatch", nil)

	_, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{{
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-mismatch",
	}}, "user")
	if !errors.Is(err, ErrCancelTargetMismatch) || errors.Is(err, ErrSessionNoActiveTurn) {
		t.Fatalf("CancelTargets error = %v, want target mismatch", err)
	}
	if adapter.turnAlreadySettled(adapterSession, "turn-mismatch") {
		t.Fatal("mismatched cancel permanently fenced the still-live Turn")
	}
	projected, terminal, projectionErr := adapter.sidecarTurnEvents(adapterSession, session, "turn-mismatch", claudeSDKSidecarEvent{
		Type: "tool_started",
		Payload: map[string]any{
			"turnId":     "turn-mismatch",
			"toolCallId": "tool-after-mismatch",
			"toolName":   "Bash",
			"input":      map[string]any{"command": "pwd"},
		},
	})
	if projectionErr != nil || terminal || len(projected) == 0 {
		t.Fatalf("post-mismatch projection events=%#v terminal=%v err=%v", projected, terminal, projectionErr)
	}
}

func TestClaudeSDKCancelTargetsPassesExactTurnID(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-exact", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-exact", nil)

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{{
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-exact",
	}}, "user")
	if err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	if len(result.ConfirmedTargets) != 1 {
		t.Fatalf("confirmed = %#v", result.ConfirmedTargets)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" ||
		payloadString(sent[0].Payload, "turnId") != "turn-exact" {
		t.Fatalf("cancel payload = %#v, want exact turnId", sent)
	}
}

func TestClaudeSDKCancelTargetsReportsExactTurnAbsent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	canceled := false
	conn := &ackClaudeSDKConnection{cancelResult: &canceled}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-absent", "")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-absent", nil)

	result, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{{
		AgentSessionID: session.AgentSessionID,
		TurnID:         "turn-absent",
	}}, "user")
	if !errors.Is(err, ErrSessionNoActiveTurn) {
		t.Fatalf("CancelTargets error = %v, want %v", err, ErrSessionNoActiveTurn)
	}
	if len(result.ConfirmedTargets) != 0 {
		t.Fatalf("confirmed = %#v, want none", result.ConfirmedTargets)
	}
	if adapter.turnAlreadySettled(adapterSession, "turn-absent") {
		t.Fatal("absent cancel permanently fenced the unconfirmed Turn")
	}
}

// A cancel racing the turn's own settle must not fabricate a second,
// contradicting terminal event (the stuck-view class ADR 0008 removes).
func TestClaudeSDKCancelAfterSettleIsIdempotent(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &ackClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	adapter.beginClaudeSDKRootTurn(adapterSession, "turn-1", "provider-turn-1")
	adapter.registerClaudeSDKTurn(adapterSession, "turn-1", nil)
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
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

func TestClaudeSDKGoalCompletesOnlyFromProviderGoalObservation(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "turn-goal",
			"providerTurnId": "turn-goal",
		},
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
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal after completed turn = %#v", goal)
	}
	malformed, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "turn-goal", "updateType": "thread_goal_update", "goal": map[string]any{},
		},
	})
	if err != nil || terminal || len(malformed) != 0 {
		t.Fatalf("malformed active goal events=%#v terminal=%v err=%v", malformed, terminal, err)
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("malformed active goal changed mirror=%#v", goal)
	}

	updates, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "turn-goal", "source": "active_goal", "updateType": "thread_goal_update",
			"goal": map[string]any{
				"objective": "ship it", "status": "active", "iterations": float64(2), "reason": "not yet",
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("active goal terminal=%v err=%v", terminal, err)
	}
	assertClaudeSDKGoalUpdateEvent(t, updates, "thread_goal_update")
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" || goal["iterations"] != int64(2) || goal["reason"] != "not yet" {
		t.Fatalf("active goal mirror = %#v", goal)
	}

	updates, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "turn-goal", "source": "active_goal", "updateType": "thread_goal_completed",
		},
	})
	if err != nil || terminal {
		t.Fatalf("completed goal terminal=%v err=%v", terminal, err)
	}
	assertClaudeSDKGoalUpdateEvent(t, updates, "thread_goal_update")
	if goal := adapter.localGoal(adapterSession); goal["status"] != "complete" {
		t.Fatalf("completed goal mirror = %#v", goal)
	}

	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})
	updates, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "turn-goal", "source": "goal_status", "updateType": "thread_goal_update",
			"goal": map[string]any{
				"objective": "ship it", "status": "complete", "iterations": float64(3),
				"reason": "all steps finished", "durationMs": float64(16_386), "tokens": float64(1_479),
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("goal_status completion terminal=%v err=%v", terminal, err)
	}
	assertClaudeSDKGoalUpdateEvent(t, updates, "thread_goal_update")
	goal := adapter.localGoal(adapterSession)
	if goal["status"] != "complete" || goal["iterations"] != int64(3) || goal["durationMs"] != int64(16_386) || goal["tokens"] != int64(1_479) || goal["reason"] != "all steps finished" {
		t.Fatalf("goal_status completion mirror = %#v", goal)
	}

	adapter.applyLocalGoal(adapterSession, map[string]any{
		"objective": "ship it", "status": "active", "startedAtUnixMs": int64(100),
	})
	updates, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "turn-goal", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "turn-goal", "source": "goal_status", "updateType": "thread_goal_update",
			"goal": map[string]any{"objective": "ship it", "status": "blocked"},
		},
	})
	if err != nil || terminal {
		t.Fatalf("blocked goal terminal=%v err=%v", terminal, err)
	}
	assertClaudeSDKGoalUpdateEvent(t, updates, "thread_goal_update")
	goal = adapter.localGoal(adapterSession)
	if goal["status"] != "blocked" || goal["startedAtUnixMs"] != int64(100) {
		t.Fatalf("blocked goal mirror = %#v", goal)
	}
}

func TestNormalizeClaudeGoalTimingPreservesGenerationStartAndTerminalDuration(t *testing.T) {
	active := normalizeClaudeGoalTiming(
		map[string]any{"objective": "ship it", "status": "active"},
		map[string]any{"objective": "ship it", "status": "active", "startedAtUnixMs": int64(20)},
		30,
	)
	if active["startedAtUnixMs"] != int64(20) {
		t.Fatalf("active Goal timing = %#v", active)
	}
	blocked := normalizeClaudeGoalTiming(
		map[string]any{"objective": "ship it", "status": "blocked"},
		active,
		50,
	)
	if blocked["startedAtUnixMs"] != int64(20) || blocked["durationMs"] != int64(30) {
		t.Fatalf("blocked Goal timing = %#v", blocked)
	}
}

func TestClaudeSDKExplicitClearUsesNilActiveGoalAsClear(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, &recordingClaudeSDKConnection{})
	adapter.applyLocalGoal(adapterSession, map[string]any{"objective": "ship it", "status": "active"})

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-clear-turn", claudeSDKSidecarEvent{
		Type: "goal_observed",
		Payload: map[string]any{
			"turnId": "goal-clear-turn", "action": "clear", "source": "active_goal", "updateType": "thread_goal_cleared",
		},
	})
	if err != nil || terminal {
		t.Fatalf("clear active goal terminal=%v err=%v", terminal, err)
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_cleared")
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("goal after explicit clear=%#v", goal)
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

// While a /goal set is still queued behind a live turn, terminal Turn events
// say nothing about the goal. A canceled arm turn never reached the CLI, so
// the optimistic mirror clears.
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
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         "turn-earlier",
			"providerTurnId": "turn-earlier",
		},
	}); err != nil {
		t.Fatalf("earlier turn_completed: %v", err)
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal completed by unrelated turn: %#v", goal)
	}

	// The arm turn's own completion is still not Goal status evidence.
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, armTurnID, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId":         armTurnID,
			"providerTurnId": armTurnID,
		},
	})
	if err != nil {
		t.Fatalf("arm turn_completed: %v", err)
	}
	for _, event := range events {
		if event.Payload.Metadata["sessionUpdateKind"] != nil {
			t.Fatalf("arm turn completion changed goal: %#v", events)
		}
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal after arm turn completed = %#v", goal)
	}
}

func TestClaudeSDKPendingGoalCancelRollsBackExactArmWithoutTurnTerminal(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, &recordingClaudeSDKConnection{})
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, next []activityshared.Event) {
		events = append(events, next...)
	})
	adapter.applyLocalGoal(adapterSession, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})
	adapterSession.goalOperationID = "goal-operation-1"
	adapterSession.goalRevision = 1
	adapterSession.goalArmTurnID = "goal-turn-pending"
	adapterSession.pendingGoalCommands = map[string]claudeSDKPendingGoalCommand{
		"goal-turn-pending": {
			identity: goalOperationIdentity{
				operationID: "goal-operation-1",
				revision:    1,
			},
			action: "set",
		},
	}
	adapterSession.goalTurnBindings = map[string]claudeSDKGoalTurnBinding{
		"goal-turn-pending": {turnID: "goal-turn-pending"},
	}

	err := adapter.dispatchClaudeSDKEvent(
		session.AgentSessionID,
		adapterSession,
		claudeSDKSidecarEvent{
			Type: "goal_command_canceled",
			Payload: map[string]any{
				"turnId":      "goal-turn-pending",
				"operationId": "goal-operation-1",
				"revision":    1,
				"repairEpoch": 0,
				"action":      "set",
				"reason":      "cancel_requested",
			},
		},
	)
	if err != nil {
		t.Fatalf("goal_command_canceled: %v", err)
	}
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("goal mirror after pending cancel = %#v, want empty", goal)
	}
	if adapterSession.goalArmTurnID != "" {
		t.Fatalf("goal arm after pending cancel = %q, want empty", adapterSession.goalArmTurnID)
	}
	if _, ok := adapterSession.goalTurnBindings["goal-turn-pending"]; ok {
		t.Fatal("pending Goal binding survived exact cancellation")
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_cleared")
	if terminals := activityEventsWithType(events, activityshared.EventTurnCompleted); len(terminals) != 0 {
		t.Fatalf("pending Goal cancel fabricated a Turn terminal: %#v", terminals)
	}
}

func TestClaudeSDKPendingGoalClearCancelRestoresPreviousMirror(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, &recordingClaudeSDKConnection{})
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, next []activityshared.Event) {
		events = append(events, next...)
	})
	previous := map[string]any{"objective": "keep shipping", "status": "active"}
	adapterSession.goalOperationID = "goal-clear-operation"
	adapterSession.goalRevision = 3
	adapterSession.goalRepairEpoch = 1
	adapterSession.goalClearControlTurns = map[string]struct{}{"goal-clear-pending": {}}
	adapterSession.pendingGoalCommands = map[string]claudeSDKPendingGoalCommand{
		"goal-clear-pending": {
			identity: goalOperationIdentity{
				operationID: "goal-clear-operation",
				revision:    3,
				repairEpoch: 1,
			},
			action:       "clear",
			previousGoal: previous,
		},
	}

	err := adapter.dispatchClaudeSDKEvent(
		session.AgentSessionID,
		adapterSession,
		claudeSDKSidecarEvent{
			Type: "goal_command_canceled",
			Payload: map[string]any{
				"turnId":      "goal-clear-pending",
				"operationId": "goal-clear-operation",
				"revision":    3,
				"repairEpoch": 1,
				"action":      "clear",
			},
		},
	)
	if err != nil {
		t.Fatalf("goal clear cancel: %v", err)
	}
	if goal := adapter.localGoal(adapterSession); asString(goal["objective"]) != "keep shipping" {
		t.Fatalf("goal mirror after clear cancel = %#v, want previous", goal)
	}
	if _, ok := adapterSession.goalClearControlTurns["goal-clear-pending"]; ok {
		t.Fatal("clear-control bookkeeping survived exact cancellation")
	}
	assertClaudeSDKGoalUpdateEvent(t, events, "thread_goal_update")
}

func TestClaudeSDKStalePendingGoalCancelDoesNotRollbackNewerIdentity(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, &recordingClaudeSDKConnection{})
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, next []activityshared.Event) {
		events = append(events, next...)
	})
	adapterSession.goalOperationID = "goal-operation-new"
	adapterSession.goalRevision = 2
	adapterSession.goalArmTurnID = "goal-turn-new"
	adapterSession.pendingGoalCommands = map[string]claudeSDKPendingGoalCommand{
		"goal-turn-old": {
			identity: goalOperationIdentity{
				operationID: "goal-operation-old",
				revision:    1,
			},
			action: "set",
		},
	}
	adapter.applyLocalGoal(adapterSession, map[string]any{
		"objective": "new goal",
		"status":    "active",
	})

	err := adapter.dispatchClaudeSDKEvent(
		session.AgentSessionID,
		adapterSession,
		claudeSDKSidecarEvent{
			Type: "goal_command_canceled",
			Payload: map[string]any{
				"turnId":      "goal-turn-old",
				"operationId": "goal-operation-old",
				"revision":    1,
				"repairEpoch": 0,
				"action":      "set",
			},
		},
	)
	if err != nil {
		t.Fatalf("stale goal cancel: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("stale goal cancel emitted updates: %#v", events)
	}
	if goal := adapter.localGoal(adapterSession); asString(goal["objective"]) != "new goal" {
		t.Fatalf("stale cancel rolled back newer goal: %#v", goal)
	}
	if adapterSession.goalArmTurnID != "goal-turn-new" {
		t.Fatalf("stale cancel cleared newer arm: %q", adapterSession.goalArmTurnID)
	}
}

func TestClaudeSDKFenceCancelsPendingGoalBeforeProviderStart(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{
		"objective": "previous goal",
		"status":    "active",
	})

	applyDone := make(chan error, 1)
	go func() {
		_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
			Action: GoalControlSet, Objective: "new goal",
			OperationID: "goal-operation-pending", Revision: 4, RepairEpoch: 2,
		})
		applyDone <- err
	}()
	execRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal new goal")
	conn.pushEvent(claudeSDKSidecarEvent{ID: execRequest.ID, Type: "ok"})
	if err := <-applyDone; err != nil {
		t.Fatalf("ApplyGoal: %v", err)
	}
	turnID := payloadString(execRequest.Payload, "turnId")

	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-operation-pending", Revision: 4, RepairEpoch: 2,
		Reason: "superseded",
	}); err != nil {
		t.Fatalf("FenceGoalGeneration: %v", err)
	}
	cancelRequest := waitForClaudeSDKSentRequest(t, conn, "cancel")
	if payloadString(cancelRequest.Payload, "turnId") != turnID {
		t.Fatalf("pending Goal cancel payload = %#v, want turn %q", cancelRequest.Payload, turnID)
	}
	conn.pushEvent(claudeSDKSidecarEvent{
		Type: "goal_command_canceled",
		Payload: map[string]any{
			"turnId":      turnID,
			"operationId": "goal-operation-pending",
			"revision":    4,
			"repairEpoch": 2,
			"action":      "set",
			"reason":      "cancel_requested",
		},
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		goal := adapter.localGoal(adapterSession)
		adapter.mu.Lock()
		_, pending := adapterSession.pendingGoalCommands[turnID]
		adapter.mu.Unlock()
		if asString(goal["objective"]) == "previous goal" && !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pending Goal did not converge after fence: goal=%#v pending=%v", goal, pending)
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, request := range conn.sentRequests() {
		if request.Type == "exec" && request.ID != execRequest.ID {
			t.Fatalf("fenced pending Goal was dispatched again: %#v", conn.sentRequests())
		}
	}
}

func TestClaudeSDKTypedGoalCancellationConvergesAcrossStartBacklog(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name             string
		action           GoalControlAction
		objective        string
		fenceBeforeStart bool
		observeBeforeEnd bool
	}{
		{name: "fenced set", action: GoalControlSet, objective: "new goal", fenceBeforeStart: true},
		{name: "fenced clear", action: GoalControlClear, fenceBeforeStart: true},
		{name: "started set", action: GoalControlSet, objective: "new goal"},
		{name: "started clear", action: GoalControlClear},
		{name: "observed set commits", action: GoalControlSet, objective: "new goal", observeBeforeEnd: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := NewClaudeCodeSDKAdapter(nil)
			conn := newBlockingClaudeSDKConnection()
			defer func() { _ = conn.Close() }()
			session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
			adapter.applyLocalGoal(adapterSession, map[string]any{
				"objective": "previous goal",
				"status":    "active",
			})
			var emitted []activityshared.Event
			adapter.SetSessionEventSink(func(_ string, next []activityshared.Event) {
				emitted = append(emitted, next...)
			})

			applyDone := make(chan error, 1)
			go func() {
				_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
					Action: test.action, Objective: test.objective,
					OperationID: "goal-operation-backlog", Revision: 9, RepairEpoch: 2,
				})
				applyDone <- err
			}()
			command := "/goal clear"
			if test.action == GoalControlSet {
				command = "/goal new goal"
			}
			execRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", command)
			conn.pushEvent(claudeSDKSidecarEvent{ID: execRequest.ID, Type: "ok"})
			if err := <-applyDone; err != nil {
				t.Fatalf("ApplyGoal: %v", err)
			}
			turnID := payloadString(execRequest.Payload, "turnId")
			providerTurnID := "provider-" + turnID

			if test.fenceBeforeStart {
				if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
					OperationID: "goal-operation-backlog", Revision: 9, RepairEpoch: 2,
					Reason: "superseded",
				}); err != nil {
					t.Fatalf("FenceGoalGeneration: %v", err)
				}
				cancelRequest := waitForClaudeSDKSentRequest(t, conn, "cancel")
				if payloadString(cancelRequest.Payload, "turnId") != turnID {
					t.Fatalf("cancel payload = %#v, want turn %q", cancelRequest.Payload, turnID)
				}
			}

			provenance := map[string]any{
				"turnId": turnID, "providerTurnId": providerTurnID,
				"sourceGoalOperationId": "goal-operation-backlog",
				"sourceGoalRevision":    float64(9),
				"sourceGoalRepairEpoch": float64(2),
			}
			if test.action == GoalControlSet {
				provenance["turnOrigin"] = "goal_arm"
			}
			for _, sidecarEvent := range []claudeSDKSidecarEvent{
				{Type: "provider_turn_identity_resolved", Payload: clonePayload(provenance)},
				{Type: "goal_command_started", Payload: map[string]any{
					"turnId": turnID, "providerTurnId": providerTurnID,
					"operationId": "goal-operation-backlog", "revision": float64(9),
					"repairEpoch": float64(2), "action": string(test.action),
				}},
			} {
				if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, sidecarEvent); err != nil {
					t.Fatalf("dispatch %s: %v", sidecarEvent.Type, err)
				}
			}
			if test.action == GoalControlSet {
				turnStarted := clonePayload(provenance)
				delete(turnStarted, "providerTurnId")
				if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
					Type: "turn_started", Payload: turnStarted,
				}); err != nil {
					t.Fatalf("dispatch turn_started: %v", err)
				}
			}

			if test.observeBeforeEnd {
				if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
					Type: "goal_observed",
					Payload: map[string]any{
						"turnId": turnID, "providerTurnId": providerTurnID,
						"action": "set", "source": "active_goal",
						"updateType": "thread_goal_update",
						"goal":       map[string]any{"objective": "new goal", "status": "active"},
					},
				}); err != nil {
					t.Fatalf("dispatch goal_observed: %v", err)
				}
			}
			if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
				Type: "turn_canceled",
				Payload: map[string]any{
					"turnId": turnID, "providerTurnId": providerTurnID,
				},
			}); err != nil {
				t.Fatalf("dispatch turn_canceled: %v", err)
			}

			wantObjective := "previous goal"
			if test.observeBeforeEnd {
				wantObjective = "new goal"
			}
			if goal := adapter.localGoal(adapterSession); asString(goal["objective"]) != wantObjective {
				t.Fatalf("goal after cancellation = %#v, want objective %q", goal, wantObjective)
			}
			adapter.mu.Lock()
			_, pending := adapterSession.pendingGoalCommands[turnID]
			_, clearControl := adapterSession.goalClearControlTurns[turnID]
			armTurnID := adapterSession.goalArmTurnID
			fencedTurns := len(adapterSession.fencedGoalTurns)
			bindings := len(adapterSession.goalTurnBindings)
			adapter.mu.Unlock()
			if pending || clearControl || armTurnID == turnID || fencedTurns != 0 || bindings != 0 {
				t.Fatalf("Goal bookkeeping survived terminal: pending=%v clear=%v arm=%q fences=%d bindings=%d",
					pending, clearControl, armTurnID, fencedTurns, bindings)
			}
			started := activityEventsWithType(emitted, activityshared.EventRootProviderTurnStarted)
			wantStarts := 0
			if !test.fenceBeforeStart && test.action == GoalControlSet {
				wantStarts = 1
			}
			if len(started) != wantStarts {
				t.Fatalf("canonical starts = %#v, want %d", started, wantStarts)
			}
		})
	}
}

func TestClaudeSDKFencedPendingGoalConsumesLateSuperseded(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.applyLocalGoal(adapterSession, map[string]any{
		"objective": "previous goal",
		"status":    "active",
	})

	applyGoal := func(input GoalApplyInput, command string) string {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			_, err := adapter.ApplyGoal(context.Background(), session, input)
			done <- err
		}()
		request := waitForClaudeSDKSentRequestMatching(t, conn, "exec", command)
		conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
		if err := <-done; err != nil {
			t.Fatalf("ApplyGoal %s: %v", input.Action, err)
		}
		return payloadString(request.Payload, "turnId")
	}
	oldTurnID := applyGoal(GoalApplyInput{
		Action: GoalControlSet, Objective: "superseded goal",
		OperationID: "goal-operation-old", Revision: 1,
	}, "/goal superseded goal")
	newTurnID := applyGoal(GoalApplyInput{
		Action:      GoalControlClear,
		OperationID: "goal-operation-new", Revision: 2,
	}, "/goal clear")

	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-operation-old", Revision: 1, Reason: "superseded",
	}); err != nil {
		t.Fatalf("FenceGoalGeneration: %v", err)
	}
	waitForClaudeSDKSentRequest(t, conn, "cancel")
	if err := adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "goal_command_superseded",
		Payload: map[string]any{
			"turnId": oldTurnID, "operationId": "goal-operation-old",
			"revision": float64(1), "action": "set", "supersededByRevision": float64(2),
		},
	}); err != nil {
		t.Fatalf("dispatch late goal_command_superseded: %v", err)
	}

	adapter.mu.Lock()
	_, oldPending := adapterSession.pendingGoalCommands[oldTurnID]
	_, newPending := adapterSession.pendingGoalCommands[newTurnID]
	fencedTurns := len(adapterSession.fencedGoalTurns)
	bindings := len(adapterSession.goalTurnBindings)
	aliases := len(adapterSession.rootProviderTurns)
	adapter.mu.Unlock()
	if oldPending || !newPending || fencedTurns != 0 || bindings != 0 || aliases != 0 {
		t.Fatalf("late superseded cleanup: oldPending=%v newPending=%v fences=%d bindings=%d aliases=%d",
			oldPending, newPending, fencedTurns, bindings, aliases)
	}
	if goal := adapter.localGoal(adapterSession); len(goal) != 0 {
		t.Fatalf("stale superseded event rolled back newer clear mirror: %#v", goal)
	}

	countCancels := func() int {
		count := 0
		for _, request := range conn.sentRequests() {
			if request.Type == "cancel" {
				count++
			}
		}
		return count
	}
	cancelCount := countCancels()
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-operation-old", Revision: 1, Reason: "retry",
	}); err != nil {
		t.Fatalf("repeat FenceGoalGeneration: %v", err)
	}
	if nextCancelCount := countCancels(); nextCancelCount != cancelCount {
		t.Fatalf("repeat fence sent another cancel: before=%d after=%d", cancelCount, nextCancelCount)
	}
}

func TestClaudeSDKGoalArmTurnCarriesDurableGoalIdentity(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.beginClaudeSDKRootTurn(adapterSession, "preceding-user-turn", "preceding-provider-turn")
	adapter.consumeClaudeSDKRootProviderTurn(adapterSession, "preceding-provider-turn")

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
	promptCorrelationID := payloadString(setRequest.Payload, "promptCorrelationId")
	if promptCorrelationID == "" || promptCorrelationID == turnID {
		t.Fatalf("goal prompt correlation id = %q, want opaque identity distinct from turn %q", promptCorrelationID, turnID)
	}
	if payloadString(setRequest.Payload, "goalOperationId") != "goal-op-7" || payloadInt64(setRequest.Payload, "goalRevision") != 7 {
		t.Fatalf("goal exec payload = %#v", setRequest.Payload)
	}
	identityEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": turnID, "providerTurnId": "provider-turn-7", "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-7", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(2),
		},
	})
	if err != nil || len(identityEvents) != 1 {
		t.Fatalf("provider identity events=%#v error=%v", identityEvents, err)
	}
	identityMetadata := identityEvents[0].Payload.Metadata
	if identityMetadata["turnOrigin"] != "goal_arm" || identityMetadata["sourceGoalOperationId"] != "goal-op-7" ||
		identityMetadata["sourceGoalRevision"] != int64(7) || identityMetadata["sourceGoalRepairEpoch"] != int64(2) {
		t.Fatalf("goal provider identity metadata = %#v", identityMetadata)
	}
	identityPatch, ok := statePatchFromSessionEvent(reportTestSource(), identityEvents[0], session.AgentSessionID, 100)
	if !ok || identityPatch.Turn == nil || identityPatch.RootProviderTurn == nil {
		t.Fatalf("goal provider identity patch = %#v, want atomic turn and provider transition", identityPatch)
	}
	if identityPatch.Turn.TurnID != turnID || identityPatch.Turn.Origin != "goal_arm" ||
		identityPatch.RootProviderTurn.ProviderTurnID != "provider-turn-7" {
		t.Fatalf("goal provider identity patch = %#v", identityPatch)
	}
	adapter.finishClaudeSDKGoalTurnPublication(adapterSession, identityEvents)
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
		Type: "turn_started", Payload: map[string]any{
			"turnId": turnID, "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-7", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(2),
		},
	})
	if err != nil || len(events) != 0 {
		t.Fatalf("duplicate turn_started events=%#v error=%v", events, err)
	}
	if adapter.claudeSDKRootTurnID(adapterSession, "") != turnID {
		t.Fatalf("goal arm root mapping = %q, want %q", adapter.claudeSDKRootTurnID(adapterSession, ""), turnID)
	}
	completedEvents, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId": turnID, "providerTurnId": "provider-turn-7", "stopReason": "end_turn",
		},
	})
	if err != nil || !terminal {
		t.Fatalf("goal arm completion events=%#v terminal=%v error=%v", completedEvents, terminal, err)
	}
	providerCompleted := activityEventsWithType(completedEvents, activityshared.EventRootProviderTurnCompleted)
	if len(providerCompleted) != 1 {
		t.Fatalf("goal arm provider completion events=%#v", completedEvents)
	}
	completedPatch, ok := statePatchFromSessionEvent(reportTestSource(), providerCompleted[0], session.AgentSessionID, 200)
	if !ok || completedPatch.Turn != nil || completedPatch.RootProviderTurn == nil ||
		completedPatch.RootProviderTurn.RootTurnID != turnID ||
		completedPatch.RootProviderTurn.ProviderTurnID != "provider-turn-7" ||
		completedPatch.RootProviderTurn.Phase != agentsessionstore.RootProviderTurnPhaseCompleted {
		t.Fatalf("goal arm provider completion patch=%#v", completedPatch)
	}
	if goal := adapter.localGoal(adapterSession); goal["status"] != "active" {
		t.Fatalf("goal arm completion mirror=%#v", goal)
	}
	adapter.mu.Lock()
	_, bindingRetained := adapterSession.goalTurnBindings[turnID]
	adapter.mu.Unlock()
	if bindingRetained {
		t.Fatalf("settled goal arm retained provenance binding for %q", turnID)
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
	identityEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, setTurnID, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": setTurnID, "providerTurnId": "provider-goal-set", "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-set", "sourceGoalRevision": float64(1),
		},
	})
	if err != nil || len(identityEvents) != 1 {
		t.Fatalf("delayed arm identity events=%#v error=%v", identityEvents, err)
	}
	identityMetadata := identityEvents[0].Payload.Metadata
	if identityMetadata["sourceGoalOperationId"] != "goal-op-set" || identityMetadata["sourceGoalRevision"] != int64(1) {
		t.Fatalf("delayed arm identity provenance=%#v", identityMetadata)
	}
	adapter.finishClaudeSDKGoalTurnPublication(adapterSession, identityEvents)
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, setTurnID, claudeSDKSidecarEvent{
		Type: "turn_started",
		Payload: map[string]any{
			"turnId": setTurnID, "turnOrigin": "goal_arm",
			"sourceGoalOperationId": "goal-op-set", "sourceGoalRevision": float64(1),
		},
	})
	if err != nil || len(events) != 0 {
		t.Fatalf("delayed arm duplicate events=%#v error=%v", events, err)
	}
	assertClaudeSDKNoCancelForGoalExec(t, conn.sentRequests(), "/goal clear")
	clearTurnID := payloadString(clearRequest.Payload, "turnId")

	clearEvents, _, err := adapter.sidecarTurnEvents(adapterSession, session, clearTurnID, claudeSDKSidecarEvent{
		Type: "goal_command_started",
		Payload: map[string]any{
			"turnId":      clearTurnID,
			"operationId": "goal-op-clear", "revision": float64(2), "repairEpoch": float64(7), "action": "clear",
		},
	})
	if err != nil || len(clearEvents) != 2 {
		t.Fatalf("clear applied events=%#v error=%v", clearEvents, err)
	}
	if clearEvents[0].Type != activityshared.EventGoalControlApplied {
		t.Fatalf("clear applied event type=%q", clearEvents[0].Type)
	}
	evidence := clearEvents[0].Payload.Metadata
	if evidence["operationId"] != "goal-op-clear" || evidence["revision"] != int64(2) || evidence["repairEpoch"] != int64(7) || evidence["action"] != "clear" {
		t.Fatalf("clear applied evidence=%#v", evidence)
	}
}

func TestClaudeSDKGoalClearProviderIdentityStaysTurnless(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)

	done := make(chan error, 1)
	go func() {
		_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
			Action: GoalControlClear, OperationID: "goal-op-clear", Revision: 2, RepairEpoch: 7,
		})
		done <- err
	}()
	request := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal clear")
	conn.pushEvent(claudeSDKSidecarEvent{ID: request.ID, Type: "ok"})
	if err := <-done; err != nil {
		t.Fatalf("clear ack: %v", err)
	}
	turnID := payloadString(request.Payload, "turnId")
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, turnID, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": turnID, "providerTurnId": "provider-goal-clear",
			"sourceGoalOperationId": "goal-op-clear", "sourceGoalRevision": float64(2), "sourceGoalRepairEpoch": float64(7),
		},
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("goal clear identity events=%#v terminal=%v error=%v", events, terminal, err)
	}
	if rootTurnID := adapter.claudeSDKRootTurnID(adapterSession, ""); rootTurnID != "" {
		t.Fatalf("goal clear created root turn %q", rootTurnID)
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
		Type: "turn_canceled",
		Payload: map[string]any{
			"turnId":         armTurnID,
			"providerTurnId": armTurnID,
		},
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
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": "goal-turn-old", "providerTurnId": "provider-goal-turn-old", "turnOrigin": "goal_continuation",
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

func TestClaudeSDKFencedGoalGenerationNeverBecomesCanonical(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-fenced", Revision: 7, RepairEpoch: 2, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-fenced", claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": "goal-turn-fenced", "providerTurnId": "provider-goal-turn-fenced", "turnOrigin": "goal_continuation",
			"sourceGoalOperationId": "goal-fenced", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(2),
		},
	})
	if err != nil || len(events) != 0 {
		t.Fatalf("fenced turn events=%#v error=%v", events, err)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" ||
		payloadString(sent[0].Payload, "turnId") != "goal-turn-fenced" {
		t.Fatalf("fenced turn cancellation=%#v", sent)
	}
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-fenced", claudeSDKSidecarEvent{
		Type: "turn_started", Payload: map[string]any{
			"turnId": "goal-turn-fenced", "turnOrigin": "goal_continuation",
			"sourceGoalOperationId": "goal-fenced", "sourceGoalRevision": float64(7), "sourceGoalRepairEpoch": float64(2),
		},
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("fenced turn_started events=%#v terminal=%v error=%v", events, terminal, err)
	}
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-fenced", claudeSDKSidecarEvent{
		Type: "turn_canceled", Payload: map[string]any{"turnId": "goal-turn-fenced", "providerTurnId": "provider-goal-turn-fenced"},
	})
	if err != nil || !terminal || len(events) != 0 {
		t.Fatalf("fenced terminal events=%#v terminal=%v error=%v", events, terminal, err)
	}
}

func TestClaudeSDKFenceQuiescesAlreadyAdmittedGoalGeneration(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	identityPayload := map[string]any{
		"turnId": "goal-turn-admitted", "providerTurnId": "provider-goal-turn-admitted", "turnOrigin": "goal_continuation",
		"sourceGoalOperationId": "goal-admitted", "sourceGoalRevision": float64(8), "sourceGoalRepairEpoch": float64(3),
	}
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-admitted", claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: identityPayload,
	})
	if err != nil || len(events) != 1 {
		t.Fatalf("admitted identity events=%#v error=%v", events, err)
	}
	adapter.finishClaudeSDKGoalTurnPublication(adapterSession, events)
	startReport := reportActivityInput(session, events)
	if len(startReport.StatePatches) != 1 || startReport.StatePatches[0].Turn == nil ||
		startReport.StatePatches[0].RootProviderTurn == nil {
		t.Fatalf("admitted identity report=%#v", startReport)
	}
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-admitted", Revision: 8, RepairEpoch: 3, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "cancel" || payloadString(sent[0].Payload, "turnId") != "goal-turn-admitted" {
		t.Fatalf("admitted goal cancellation=%#v", sent)
	}
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-admitted", claudeSDKSidecarEvent{
		Type: "turn_started", Payload: map[string]any{
			"turnId": "goal-turn-admitted", "turnOrigin": "goal_continuation",
			"sourceGoalOperationId": "goal-admitted", "sourceGoalRevision": float64(8), "sourceGoalRepairEpoch": float64(3),
		},
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("fenced admitted turn_started events=%#v terminal=%v error=%v", events, terminal, err)
	}
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-admitted", claudeSDKSidecarEvent{
		Type: "turn_canceled", Payload: map[string]any{
			"turnId": "goal-turn-admitted", "providerTurnId": "provider-goal-turn-admitted",
		},
	})
	if err != nil || !terminal {
		t.Fatalf("fenced admitted terminal events=%#v terminal=%v error=%v", events, terminal, err)
	}
	completed := activityEventsWithType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnID != "goal-turn-admitted" {
		t.Fatalf("fenced admitted completion events=%#v", events)
	}
	terminalReport := reportActivityInput(session, events)
	settlementFound := false
	for _, patch := range terminalReport.StatePatches {
		if patch.RootProviderTurn != nil && patch.RootProviderTurn.Phase == agentsessionstore.RootProviderTurnPhaseCompleted {
			settlementFound = true
			break
		}
	}
	if !settlementFound {
		t.Fatalf("fenced admitted terminal report=%#v", terminalReport)
	}
}

func TestClaudeSDKFenceWinsBetweenGoalAdmissionAndPublication(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	payload := map[string]any{
		"turnId": "goal-turn-racing", "providerTurnId": "provider-goal-turn-racing", "turnOrigin": "goal_continuation",
		"sourceGoalOperationId": "goal-racing", "sourceGoalRevision": float64(9), "sourceGoalRepairEpoch": float64(4),
	}
	admission, err := adapter.admitClaudeSDKGoalTurn(
		adapterSession,
		"goal-turn-racing",
		"provider-goal-turn-racing",
		payload,
	)
	if err != nil || admission.denied() || !admission.goalTurn {
		t.Fatalf("initial admission=%#v error=%v", admission, err)
	}
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-racing", Revision: 9, RepairEpoch: 4, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	if adapter.publishClaudeSDKGoalTurn(adapterSession, "goal-turn-racing") {
		t.Fatal("fence that won before publication allowed Goal start")
	}
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-racing", claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: payload,
	})
	if err != nil || terminal || len(events) != 0 {
		t.Fatalf("raced identity events=%#v terminal=%v error=%v", events, terminal, err)
	}
	events, terminal, err = adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-racing", claudeSDKSidecarEvent{
		Type: "turn_canceled", Payload: map[string]any{
			"turnId": "goal-turn-racing", "providerTurnId": "provider-goal-turn-racing",
		},
	})
	if err != nil || !terminal || len(events) != 0 {
		t.Fatalf("raced terminal events=%#v terminal=%v error=%v", events, terminal, err)
	}
}

func TestClaudeSDKFenceBetweenRepeatedAdmissionAndPublicationSettlesPublishedTurn(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	payload := map[string]any{
		"turnId": "goal-turn-repeated", "providerTurnId": "provider-goal-turn-repeated", "turnOrigin": "goal_continuation",
		"sourceGoalOperationId": "goal-repeated", "sourceGoalRevision": float64(10), "sourceGoalRepairEpoch": float64(4),
	}
	events, _, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-repeated", claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: payload,
	})
	if err != nil || len(events) != 1 {
		t.Fatalf("identity events=%#v error=%v", events, err)
	}
	adapter.finishClaudeSDKGoalTurnPublication(adapterSession, events)

	// The sidecar emits turn_started after identity resolution. A fence may
	// arrive after this second admission but before its duplicate start fact is
	// published; the first start is already durable and must still be settled.
	admission, err := adapter.admitClaudeSDKGoalTurn(
		adapterSession,
		"goal-turn-repeated",
		"provider-goal-turn-repeated",
		payload,
	)
	if err != nil || admission.denied() {
		t.Fatalf("repeated admission=%#v error=%v", admission, err)
	}
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-repeated", Revision: 10, RepairEpoch: 4, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "goal-turn-repeated", claudeSDKSidecarEvent{
		Type: "turn_canceled", Payload: map[string]any{
			"turnId": "goal-turn-repeated", "providerTurnId": "provider-goal-turn-repeated",
		},
	})
	if err != nil || !terminal || len(activityEventsWithType(events, activityshared.EventRootProviderTurnCompleted)) != 1 {
		t.Fatalf("published turn settlement events=%#v terminal=%v error=%v", events, terminal, err)
	}
}

func TestClaudeSDKGoalLateProviderIdentityPublishesOnceAndSettles(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	var emitted []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		emitted = append(emitted, events...)
	})
	provenance := map[string]any{
		"turnId": "goal-turn-late-identity", "turnOrigin": "goal_arm",
		"sourceGoalOperationId": "goal-late-identity", "sourceGoalRevision": float64(11), "sourceGoalRepairEpoch": float64(2),
	}

	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_started", Payload: provenance,
	})
	if len(emitted) != 0 {
		t.Fatalf("unbound Goal start published canonical events=%#v", emitted)
	}
	identityPayload := clonePayload(provenance)
	identityPayload["providerTurnId"] = "provider-goal-late-identity"
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: identityPayload,
	})
	started := activityEventsWithType(emitted, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.TurnID != "goal-turn-late-identity" ||
		started[0].Payload.ProviderTurnID != "provider-goal-late-identity" {
		t.Fatalf("late identity start events=%#v", emitted)
	}

	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_completed",
		Payload: map[string]any{
			"turnId": "goal-turn-late-identity", "providerTurnId": "provider-goal-late-identity", "stopReason": "end_turn",
		},
	})
	completed := activityEventsWithType(emitted, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnID != "goal-turn-late-identity" ||
		completed[0].Payload.ProviderTurnID != "provider-goal-late-identity" {
		t.Fatalf("late identity settlement events=%#v", emitted)
	}
	if failures := activityEventsWithType(emitted, activityshared.EventSessionFailed); len(failures) != 0 {
		t.Fatalf("late identity emitted session failure=%#v", failures)
	}
}

func TestClaudeSDKFencedUnboundGoalLateIdentityCleansAliases(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	var emitted []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		emitted = append(emitted, events...)
	})
	provenance := map[string]any{
		"turnId": "goal-turn-fenced-unbound", "turnOrigin": "goal_continuation",
		"sourceGoalOperationId": "goal-fenced-unbound", "sourceGoalRevision": float64(12), "sourceGoalRepairEpoch": float64(3),
	}
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_started", Payload: provenance,
	})
	if err := adapter.FenceGoalGeneration(context.Background(), session, GoalGenerationFenceInput{
		OperationID: "goal-fenced-unbound", Revision: 12, RepairEpoch: 3, Reason: "binding_revoked",
	}); err != nil {
		t.Fatal(err)
	}
	identityPayload := clonePayload(provenance)
	identityPayload["providerTurnId"] = "provider-goal-fenced-unbound"
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: identityPayload,
	})
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_canceled",
		Payload: map[string]any{
			"turnId": "goal-turn-fenced-unbound", "providerTurnId": "provider-goal-fenced-unbound",
		},
	})
	adapter.mu.Lock()
	fencedTurns := len(adapterSession.fencedGoalTurns)
	bindings := len(adapterSession.goalTurnBindings)
	providerAliases := len(adapterSession.rootProviderTurns)
	adapter.mu.Unlock()
	if fencedTurns != 0 || bindings != 0 || providerAliases != 0 {
		t.Fatalf("fenced late identity cleanup: fences=%d bindings=%d providerAliases=%d", fencedTurns, bindings, providerAliases)
	}
	if failures := activityEventsWithType(emitted, activityshared.EventSessionFailed); len(failures) != 0 {
		t.Fatalf("fenced late identity emitted session failure=%#v", failures)
	}

	nextIdentity := map[string]any{
		"turnId": "goal-turn-next", "providerTurnId": "provider-goal-next", "turnOrigin": "goal_continuation",
		"sourceGoalOperationId": "goal-next", "sourceGoalRevision": float64(13), "sourceGoalRepairEpoch": float64(0),
	}
	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved", Payload: nextIdentity,
	})
	started := activityEventsWithType(emitted, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.TurnID != "goal-turn-next" ||
		started[0].Payload.ProviderTurnID != "provider-goal-next" {
		t.Fatalf("next Goal identity after cleanup events=%#v", emitted)
	}
}

func TestClaudeSDKGoalFenceFlushesPublishedStartBeforeReturning(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	reporter := &blockingFirstClaudeGoalReporter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	controller := NewController([]Adapter{adapter}, reporter)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	controller.store(session)

	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "provider_turn_identity_resolved",
		Payload: map[string]any{
			"turnId": "goal-turn-flush", "providerTurnId": "provider-goal-turn-flush", "turnOrigin": "goal_continuation",
			"sourceGoalOperationId": "goal-flush", "sourceGoalRevision": float64(10), "sourceGoalRepairEpoch": float64(5),
		},
	})
	select {
	case <-reporter.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("Goal start did not reach the durable reporter")
	}

	fenceDone := make(chan error, 1)
	go func() {
		fenceDone <- controller.FenceGoalGeneration(context.Background(), GoalGenerationFenceRequest{
			RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
			OperationID: "goal-flush", Revision: 10, RepairEpoch: 5,
			Reason: "binding_revoked", RequireLive: true,
		})
	}()
	select {
	case err := <-fenceDone:
		t.Fatalf("Fence returned before the published start was durable: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(reporter.release)
	select {
	case err := <-fenceDone:
		if err != nil {
			t.Fatalf("FenceGoalGeneration: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Fence did not return after the start report became durable")
	}

	_ = adapter.dispatchClaudeSDKEvent(session.AgentSessionID, adapterSession, claudeSDKSidecarEvent{
		Type: "turn_canceled",
		Payload: map[string]any{
			"turnId": "goal-turn-flush", "providerTurnId": "provider-goal-turn-flush",
		},
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		reports := reporter.snapshot()
		if len(reports) >= 2 {
			if len(reports[0].StatePatches) != 1 || reports[0].StatePatches[0].Turn == nil ||
				reports[0].StatePatches[0].RootProviderTurn == nil {
				t.Fatalf("durable Goal start report=%#v", reports[0])
			}
			settlementFound := false
			for _, patch := range reports[1].StatePatches {
				if patch.RootProviderTurn != nil && patch.RootProviderTurn.Phase == agentsessionstore.RootProviderTurnPhaseCompleted {
					settlementFound = true
					break
				}
			}
			if !settlementFound {
				t.Fatalf("durable Goal terminal report=%#v", reports[1])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for terminal report; reports=%#v", reports)
		}
		time.Sleep(10 * time.Millisecond)
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
