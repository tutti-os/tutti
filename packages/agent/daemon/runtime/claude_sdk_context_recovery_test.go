package agentruntime

import (
	"context"
	"strings"
	"testing"
)

func TestClaudeSDKContextRecoveryHostContextUsesTuttiCLIOnDemand(t *testing.T) {
	t.Parallel()

	hostContext := renderClaudeSDKContextRecoveryHostContext(
		Session{AgentSessionID: "tutti-session-1"},
		claudeSDKContextRecoveryState{
			Generation: 1,
			State:      claudeSDKContextRecoveryStateHandoff,
		},
	)
	for _, expected := range []string{
		`kind="claude-context-recovery"`,
		"tutti-session-1",
		`agent get --session-id "$TUTTI_AGENT_SESSION_ID" --json`,
		"Retrieve only the earlier turns needed",
		"Do not claim to remember content you have not read",
	} {
		if !strings.Contains(hostContext, expected) {
			t.Fatalf("host context missing %q: %s", expected, hostContext)
		}
	}
}

func TestClaudeSDKContextRecoveryHostContextIsSentOnlyWhileHandoffPending(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "tutti-session-1"}
	for _, state := range []claudeSDKContextRecoveryState{
		{Generation: 1, State: claudeSDKContextRecoveryStatePending},
		{Generation: 1, State: claudeSDKContextRecoveryStateCompleted},
		{Generation: 1, State: claudeSDKContextRecoveryStateHandoff, HandoffSent: true},
	} {
		if got := renderClaudeSDKContextRecoveryHostContext(session, state); got != "" {
			t.Fatalf("state=%#v rendered host context %q", state, got)
		}
	}
}

func TestClaudeSDKContextRecoveryRetriesHandoffAfterPreAcceptanceFailure(t *testing.T) {
	t.Parallel()

	adapterSession := &claudeSDKAdapterSession{contextRecovery: claudeSDKContextRecoveryState{
		Generation: 1,
		State:      claudeSDKContextRecoveryStateHandoff,
	}}
	if _, claimed := adapterSession.claimContextRecoveryHandoff(); !claimed {
		t.Fatal("first handoff was not marked sent")
	}
	adapterSession.resetContextRecoveryHandoffSent()
	if got := renderClaudeSDKContextRecoveryHostContext(
		Session{AgentSessionID: "tutti-session-1"},
		adapterSession.contextRecoverySnapshot(),
	); got == "" {
		t.Fatal("handoff was not made retryable")
	}
}

func TestClaudeSDKContextRecoveryClaimsHandoffBeforeTerminalEvent(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapterSession.contextRecovery = claudeSDKContextRecoveryState{
		Generation: 1,
		State:      claudeSDKContextRecoveryStateHandoff,
	}

	done := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(
			context.Background(),
			session,
			[]PromptContentBlock{{Type: "text", Text: "continue"}},
			"",
			"turn-recovery",
			nil,
			nil,
		)
		done <- err
	}()
	request := waitForClaudeSDKSentRequest(t, conn, "exec")
	if !strings.Contains(
		payloadString(request.Payload, "hostContext"),
		`kind="claude-context-recovery"`,
	) {
		t.Fatalf("exec payload missing recovery handoff: %#v", request.Payload)
	}
	conn.pushEvent(claudeSDKSidecarEvent{Type: "turn_completed", Payload: map[string]any{
		"turnId": "turn-recovery", "providerTurnId": "provider-turn-recovery",
	}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if state := adapterSession.contextRecoverySnapshot(); state.State != claudeSDKContextRecoveryStateCompleted {
		t.Fatalf("recovery state=%#v, want completed", state)
	}
}

func TestClaudeSDKContextRecoveryRejectsInvalidHostGoalPlan(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.StartContextRecovery(t.Context(), session, &ContextRecoveryGoal{
		Objective: "ship it",
	}); err == nil {
		t.Fatal("invalid Host Goal plan was accepted")
	}
}

func TestClaudeSDKContextRecoveryReappliesActiveGoalWithSameIdentity(t *testing.T) {
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-old"
	session.RuntimeContext = map[string]any{
		"goal": map[string]any{"objective": "ship it", "status": "active"},
		claudeSDKContextRecoveryRuntimeKey: claudeSDKContextRecoveryRuntimeContext(
			claudeSDKContextRecoveryState{
				Generation: 1,
				State:      claudeSDKContextRecoveryStatePending,
			},
		),
	}
	prepared, required, err := adapter.PrepareContextRecovery(session)
	if err != nil || !required {
		t.Fatalf("PrepareContextRecovery required=%v error=%v", required, err)
	}
	prepared.ProviderSessionID = ""
	done := make(chan error, 1)
	go func() {
		_, startErr := adapter.StartContextRecovery(
			context.Background(),
			prepared,
			&ContextRecoveryGoal{
				Objective: "ship it", OperationID: "goal-operation-7",
				Revision: 7, RepairEpoch: 2,
			},
		)
		done <- startErr
	}()
	waitForClaudeSDKSentRequest(t, conn, "start")
	conn.pushEvent(claudeSDKSidecarEvent{Type: "session_started", Payload: map[string]any{
		"providerSessionId": "provider-session-new",
	}})
	goalRequest := waitForClaudeSDKSentRequestMatching(t, conn, "exec", "/goal ship it")
	if payloadString(goalRequest.Payload, "goalOperationId") != "goal-operation-7" ||
		payloadInt64(goalRequest.Payload, "goalRevision") != 7 ||
		payloadInt64(goalRequest.Payload, "goalRepairEpoch") != 2 {
		t.Fatalf("restored Goal identity=%#v", goalRequest.Payload)
	}
	conn.pushEvent(claudeSDKSidecarEvent{
		ID: goalRequest.ID, Type: "ok",
	})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	adapterSession := adapter.getSession(session.AgentSessionID)
	if adapterSession == nil || adapterSession.providerSessionID != "provider-session-new" {
		t.Fatalf("recovered adapter session=%#v", adapterSession)
	}
	identity := goalOperationIdentity{
		operationID: adapterSession.goalOperationID,
		revision:    adapterSession.goalRevision,
		repairEpoch: adapterSession.goalRepairEpoch,
	}
	if identity.operationID != "goal-operation-7" || identity.revision != 7 ||
		identity.repairEpoch != 2 {
		t.Fatalf("recovered Goal identity=%#v", identity)
	}
}

func TestClaudeSDKContextRecoveryDoesNotReactivateTerminalGoal(t *testing.T) {
	for _, status := range []string{"complete", "blocked"} {
		t.Run(status, func(t *testing.T) {
			conn := newBlockingClaudeSDKConnection()
			defer func() { _ = conn.Close() }()
			transport := &recordingClaudeSDKTransport{conn: conn}
			adapter := NewClaudeCodeSDKAdapter(transport)
			session := standardTestSession(ProviderClaudeCode)
			session.ProviderSessionID = "provider-session-old"
			session.RuntimeContext = map[string]any{
				"goal": map[string]any{
					"objective": "ship it",
					"status":    status,
				},
				claudeSDKContextRecoveryRuntimeKey: claudeSDKContextRecoveryRuntimeContext(
					claudeSDKContextRecoveryState{
						Generation: 1,
						State:      claudeSDKContextRecoveryStatePending,
					},
				),
			}
			prepared, required, err := adapter.PrepareContextRecovery(session)
			if err != nil || !required {
				t.Fatalf("PrepareContextRecovery required=%v error=%v", required, err)
			}
			prepared.ProviderSessionID = ""
			done := make(chan error, 1)
			go func() {
				_, startErr := adapter.StartContextRecovery(context.Background(), prepared, nil)
				done <- startErr
			}()
			waitForClaudeSDKSentRequest(t, conn, "start")
			conn.pushEvent(claudeSDKSidecarEvent{Type: "session_started", Payload: map[string]any{
				"providerSessionId": "provider-session-new",
			}})
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			requests := conn.sentRequests()
			if len(requests) != 1 || requests[0].Type != "start" {
				t.Fatalf("terminal Goal was reactivated: %#v", requests)
			}
			adapterSession := adapter.getSession(session.AgentSessionID)
			if goal := adapter.localGoal(adapterSession); payloadString(goal, "status") != status {
				t.Fatalf("terminal Goal mirror=%#v, want status=%q", goal, status)
			}
		})
	}
}

func TestControllerColdClaudeContextRecoveryDoesNotReactivateCompletedGoal(t *testing.T) {
	conn := newBlockingClaudeSDKConnection()
	defer func() { _ = conn.Close() }()
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	done := make(chan error, 1)
	go func() {
		_, resumeErr := controller.Resume(context.Background(), ResumeInput{
			RoomID:            "room-context-recovery",
			AgentSessionID:    "session-context-recovery-cold",
			Provider:          ProviderClaudeCode,
			ProviderSessionID: "provider-session-exhausted",
			CWD:               "/workspace",
			RuntimeContext: map[string]any{
				"goal": map[string]any{
					"objective": "ship it",
					"status":    "complete",
				},
				claudeSDKContextRecoveryRuntimeKey: claudeSDKContextRecoveryRuntimeContext(
					claudeSDKContextRecoveryState{
						Generation: 1,
						State:      claudeSDKContextRecoveryStatePending,
					},
				),
			},
			ContextRecoveryGoal: nil,
		})
		done <- resumeErr
	}()
	waitForClaudeSDKSentRequest(t, conn, "start")
	conn.pushEvent(claudeSDKSidecarEvent{Type: "session_started", Payload: map[string]any{
		"providerSessionId": "provider-session-new",
	}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	requests := conn.sentRequests()
	if len(requests) != 1 || requests[0].Type != "start" {
		t.Fatalf("completed Goal was reactivated during cold recovery: %#v", requests)
	}
	adapterSession := adapter.getSession("session-context-recovery-cold")
	if goal := adapter.localGoal(adapterSession); payloadString(goal, "status") != "complete" {
		t.Fatalf("completed Goal mirror=%#v", goal)
	}
}
