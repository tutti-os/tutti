package agentruntime

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func lifecycleWith(phase string, turnID string, outcome string) *TurnLifecycle {
	lifecycle := &TurnLifecycle{Phase: phase}
	if turnID != "" {
		lifecycle.ActiveTurnID = &turnID
	}
	if outcome != "" {
		lifecycle.Outcome = &outcome
	}
	return lifecycle
}

func TestAdapterTurnLifecycleSnapshotsCarryStartedAt(t *testing.T) {
	t.Parallel()

	ctx := activityshared.EventContext{
		AgentSessionID:   "session-1",
		Provider:         activityshared.ProviderCodex,
		OccurredAtUnixMS: 1000,
	}
	events := []activityshared.Event{
		activityshared.NewTurnStarted(ctx, "turn-1"),
		activityshared.NewTurnUpdated(activityshared.EventContext{AgentSessionID: "session-1", Provider: activityshared.ProviderCodex, OccurredAtUnixMS: 1500}, "turn-1", activityshared.TurnPhaseWaitingApproval),
		activityshared.NewTurnCompleted(activityshared.EventContext{AgentSessionID: "session-1", Provider: activityshared.ProviderCodex, OccurredAtUnixMS: 2000}, "turn-1", activityshared.TurnOutcomeCompleted),
	}
	startedByTurn := map[string]int64{}
	seq := uint64(0)
	stamped := stampAdapterTurnLifecycleEvents(
		events,
		func() uint64 { seq++; return seq },
		func(turnID string, event activityshared.Event) adapterTurnLifecycleTiming {
			turnID = strings.TrimSpace(turnID)
			if event.Type == activityshared.EventTurnStarted {
				startedByTurn[turnID] = event.OccurredAtUnixMS
			}
			return adapterTurnLifecycleTiming{StartedAtUnixMS: startedByTurn[turnID]}
		},
	)

	for index, event := range stamped {
		snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
		if !ok {
			t.Fatalf("event %d missing lifecycle snapshot", index)
		}
		if snapshot.StartedAtUnixMS != 1000 {
			t.Fatalf("event %d startedAtUnixMs = %d, want 1000", index, snapshot.StartedAtUnixMS)
		}
		if snapshot.TurnID != "turn-1" {
			t.Fatalf("event %d turnId = %q, want turn-1", index, snapshot.TurnID)
		}
		if event.Type == activityshared.EventTurnCompleted && snapshot.CompletedAtUnixMS != 2000 {
			t.Fatalf("event %d completedAtUnixMs = %d, want 2000", index, snapshot.CompletedAtUnixMS)
		}
	}
}

func TestClaudeAdapterDuplicateTerminalKeepsFirstLifecycleTiming(t *testing.T) {
	t.Parallel()

	adapter := &ClaudeCodeSDKAdapter{}
	adapterSession := &claudeSDKAdapterSession{}
	session := Session{AgentSessionID: "session-1", Provider: ProviderClaudeCode}
	start := newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)
	start.OccurredAtUnixMS = 1000
	adapter.stampTurnLifecycleSnapshots(adapterSession, []activityshared.Event{start})

	firstTerminal := newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)
	firstTerminal.OccurredAtUnixMS = 2000
	adapter.stampTurnLifecycleSnapshots(adapterSession, []activityshared.Event{firstTerminal})

	duplicateTerminal := newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)
	duplicateTerminal.OccurredAtUnixMS = 3000
	stamped := adapter.stampTurnLifecycleSnapshots(adapterSession, []activityshared.Event{duplicateTerminal})
	snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(stamped[0])
	if !ok {
		t.Fatal("duplicate terminal missing lifecycle snapshot")
	}
	if snapshot.StartedAtUnixMS != 1000 || snapshot.CompletedAtUnixMS != 2000 {
		t.Fatalf("duplicate terminal timing = (%d, %d), want first terminal timing (1000, 2000)", snapshot.StartedAtUnixMS, snapshot.CompletedAtUnixMS)
	}
}

func TestCodexAdapterDuplicateTerminalKeepsFirstLifecycleTiming(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{
		sessions: map[string]*codexAppServerSession{"session-1": {}},
	}
	session := Session{AgentSessionID: "session-1", Provider: ProviderCodex}
	start := newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)
	start.OccurredAtUnixMS = 1000
	adapter.stampTurnLifecycleSnapshots(session.AgentSessionID, []activityshared.Event{start})

	firstTerminal := newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusReady, "", "", nil)
	firstTerminal.OccurredAtUnixMS = 2000
	adapter.stampTurnLifecycleSnapshots(session.AgentSessionID, []activityshared.Event{firstTerminal})

	duplicateTerminal := newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusReady, "", "", nil)
	duplicateTerminal.OccurredAtUnixMS = 3000
	stamped := adapter.stampTurnLifecycleSnapshots(session.AgentSessionID, []activityshared.Event{duplicateTerminal})
	snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(stamped[0])
	if !ok {
		t.Fatal("duplicate terminal missing lifecycle snapshot")
	}
	if snapshot.StartedAtUnixMS != 1000 || snapshot.CompletedAtUnixMS != 2000 {
		t.Fatalf("duplicate terminal timing = (%d, %d), want first terminal timing (1000, 2000)", snapshot.StartedAtUnixMS, snapshot.CompletedAtUnixMS)
	}
}

// statusForAuthoritySession is THE status derivation for snapshot-authority
// sessions (ADR 0008); this table pins it.
func TestStatusForAuthoritySession(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		lifecycle   *TurnLifecycle
		batchLevel  string
		priorStatus string
		want        string
	}{
		{"running turn", lifecycleWith("running", "t1", ""), "", "", SessionStatusWorking},
		{"submitted turn", lifecycleWith("submitted", "t1", ""), "", "", SessionStatusWorking},
		{"waiting approval", lifecycleWith("waiting_approval", "t1", ""), "", "", SessionStatusWaiting},
		{"waiting input", lifecycleWith("waiting_input", "t1", ""), "", "", SessionStatusWaiting},
		{"legacy waiting", lifecycleWith("waiting", "t1", ""), "", "", SessionStatusWaiting},
		{"settled completed", lifecycleWith("settled", "", "completed"), "", "", SessionStatusReady},
		{"settled interrupted", lifecycleWith("settled", "", "interrupted"), "", "", SessionStatusCanceled},
		{"settled failed", lifecycleWith("settled", "", "failed"), "", "", SessionStatusFailed},
		{"session failed wins", lifecycleWith("running", "t1", ""), SessionStatusFailed, "", SessionStatusFailed},
		{"metadata batch keeps prior", nil, "", SessionStatusCanceled, SessionStatusCanceled},
		{"no signals defaults ready", nil, "", "", SessionStatusReady},
		{"running beats batch working", lifecycleWith("running", "t1", ""), SessionStatusWorking, "", SessionStatusWorking},
	}
	for _, testCase := range cases {
		session := Session{Status: testCase.priorStatus, TurnLifecycle: testCase.lifecycle}
		got := statusForAuthoritySession(session, testCase.batchLevel)
		if got != testCase.want {
			t.Fatalf("%s: status = %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

// The published state-patch stream for a snapshot-authority session must
// never report the session as available/settled between submit and settle —
// the flicker regression that motivated ADR 0008.
func TestControllerCodexStreamNeverIdlesMidTurn(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.holdTurn = true
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
	stream, unsubscribe, ok := controller.Subscribe("room-1", agentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})

	// Metadata refreshes that used to flap the status to ready.
	transport.conn.notify(appServerNotifyTokenUsage, map[string]any{
		"threadId":   "codex-thread-1",
		"tokenUsage": map[string]any{"total": map[string]any{"totalTokens": 7}},
	})
	transport.conn.notify(appServerNotifyRateLimitsUpdated, map[string]any{
		"threadId":   "codex-thread-1",
		"rateLimits": map[string]any{"primary": map[string]any{"usedPercent": 10}},
	})
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && len(session.RuntimeContext) > 0
	})
	transport.conn.completePendingTurn()
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && session.Status != SessionStatusWorking
	})

	sawSettled := false
	drained := false
	for !drained {
		select {
		case event := <-stream:
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if event.EventType != StreamEventStatePatch || !ok || patch.TurnLifecycle == nil {
				continue
			}
			phase := strings.TrimSpace(patch.TurnLifecycle.Phase)
			if phase == "settled" {
				sawSettled = true
				continue
			}
			if sawSettled {
				continue
			}
			if !activityshared.TurnLifecyclePhaseIsLive(phase) {
				t.Fatalf("state patch published a non-live lifecycle %q before the turn settled", phase)
			}
			if patch.SubmitAvailability != nil && patch.SubmitAvailability.State == "available" {
				t.Fatalf("state patch published available submit mid-turn (phase %q)", phase)
			}
		default:
			drained = true
		}
	}
	if !sawSettled {
		t.Fatal("stream never published a settled lifecycle patch")
	}
}

// applyLifecycleSnapshotToPatch must be provider-agnostic: any provider whose
// adapter stamps snapshots gets the copied patch, no codex special case.
func TestApplyLifecycleSnapshotToPatchProviderAgnostic(t *testing.T) {
	t.Parallel()

	session := Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-1",
		Provider:          ProviderClaudeCode,
		ProviderSessionID: "claude-1",
	}
	event := newTurnActivityEvent(session, EventTurnUpdated, "turn-9", SessionStatusWorking, "", "", nil)
	activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
		Origin:            activityshared.TurnLifecycleOriginAdapter,
		Seq:               1,
		ActiveTurnID:      "turn-9",
		Phase:             string(activityshared.TurnPhaseRunning),
		Settling:          true,
		StartedAtUnixMS:   1000,
		CompletedAtUnixMS: 2000,
	})
	patch, ok := statePatchFromSessionEvent(agentsessionstore.EventSource{Provider: ProviderClaudeCode}, event, "agent-1", 1)
	if !ok {
		t.Fatal("turn.started did not produce a state patch")
	}
	if patch.TurnLifecycle == nil || patch.TurnLifecycle.Phase != string(activityshared.TurnPhaseRunning) {
		t.Fatalf("patch lifecycle not copied from snapshot: %#v", patch.TurnLifecycle)
	}
	if patch.Turn == nil || patch.Turn.StartedAtUnixMS != 1000 || patch.Turn.CompletedAtUnixMS != 2000 || !patch.Turn.Settling {
		t.Fatalf("patch turn timing not copied from snapshot: %#v", patch.Turn)
	}
	if !patch.TurnLifecycle.Settling {
		t.Fatalf("patch lifecycle settling = false, want true: %#v", patch.TurnLifecycle)
	}
	if patch.SubmitAvailability == nil || patch.SubmitAvailability.State != "blocked" {
		t.Fatalf("patch submit availability not derived: %#v", patch.SubmitAvailability)
	}
	if _, isMessage := messageUpdateFromSessionEvent(agentsessionstore.EventSource{}, event, "agent-1", 1); isMessage {
		t.Fatal("stamped turn event must never become a message update")
	}
}

// A rejected/errored approval must not strand the lifecycle in
// waiting_approval: the error path appends a back-to-running snapshot.
func TestCodexAppServerAdapterApprovalErrorPathResumesLifecycle(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.commandApproval = true

	var streamedMu sync.Mutex
	var streamed []activityshared.Event
	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
	}()
	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "approval-1") != nil
	})

	adapter.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)

	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		sawWaiting := false
		for _, event := range streamed {
			snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
			if !ok {
				continue
			}
			if snapshot.Phase == string(activityshared.TurnPhaseWaitingApproval) {
				sawWaiting = true
				continue
			}
			if sawWaiting && snapshot.Phase == string(activityshared.TurnPhaseRunning) {
				return true
			}
		}
		return false
	})

	transport.conn.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Exec did not finish after approval rejection")
	}
}

// Predicate parity: the canonical Go live-phase list this repo's TypeScript
// mirror (activity-core LIVE_TURN_LIFECYCLE_PHASES) must match.
func TestLiveTurnLifecyclePhasesCanonicalList(t *testing.T) {
	t.Parallel()

	want := []string{"submitted", "running", "waiting_approval", "waiting_input"}
	if len(activityshared.LiveTurnLifecyclePhases) != len(want) {
		t.Fatalf("canonical list = %v, want %v", activityshared.LiveTurnLifecyclePhases, want)
	}
	for index, phase := range want {
		if activityshared.LiveTurnLifecyclePhases[index] != phase {
			t.Fatalf("canonical list = %v, want %v", activityshared.LiveTurnLifecyclePhases, want)
		}
	}
}
