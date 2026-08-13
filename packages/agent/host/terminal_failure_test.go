package agenthost

import (
	"context"
	"errors"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type recordingTerminalFailureObserver struct {
	failures []TerminalFailure
}

func (o *recordingTerminalFailureObserver) ObserveTerminalFailure(_ context.Context, failure TerminalFailure) {
	o.failures = append(o.failures, failure)
}

type terminalFailureSequenceClock struct {
	now time.Time
}

func (c *terminalFailureSequenceClock) Now() time.Time {
	current := c.now
	c.now = c.now.Add(250 * time.Millisecond)
	return current
}

func TestCommandBoundaryCarriesStableIdentityAndDuration(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{
		TerminalFailureObserver: observer,
		Clock: &terminalFailureSequenceClock{
			now: time.Unix(1_700_000_000, 0),
		},
	})

	_, _ = host.CreateSession(context.Background(), "workspace-1", CreateSessionInput{
		ActivationID:   "activation-1",
		AgentSessionID: "session-1",
		ClientSubmitID: "create-submit-1",
		TurnID:         "turn-initial",
	})
	_, _ = host.SendInput(
		context.Background(),
		SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		SendInput{ClientSubmitID: "send-submit-1", TurnID: "turn-2"},
	)

	if len(observer.failures) != 2 {
		t.Fatalf("terminal failures = %#v, want 2", observer.failures)
	}
	for index, want := range []struct {
		flow, operationID, requestID, clientSubmitID, turnID string
	}{
		{flow: "session_create", operationID: "activation-1", requestID: "activation-1", clientSubmitID: "create-submit-1", turnID: "turn-initial"},
		{flow: "message_send", operationID: "send-submit-1", clientSubmitID: "send-submit-1", turnID: "turn-2"},
	} {
		got := observer.failures[index]
		if got.Flow != want.flow || got.OperationID != want.operationID ||
			got.RequestID != want.requestID ||
			got.ClientSubmitID != want.clientSubmitID || got.TurnID != want.turnID ||
			got.DurationMS != 250 {
			t.Fatalf("terminal failure %d = %#v, want identity %#v and duration 250", index, got, want)
		}
	}
}

func TestCommandBoundaryEmitsOneFailureForTheFirstFailedStep(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	cause := NewProviderError("provider_timeout", "provider timed out after 30s", "debug", errors.New("deadline"))

	ctx, command := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "message_send", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	host.observeStep(ctx, "message_send", "runtime_session_ready", "workspace-1", "session-1", "claude", host.now(), cause)
	host.observeStep(ctx, "message_send", "runtime_exec", "workspace-1", "session-1", "claude", host.now(), errors.New("later stage"))
	command.finish(ctx, host, cause)

	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "message_send" || got.FailureStage != "runtime_session_ready" ||
		got.WorkspaceID != "workspace-1" || got.AgentSessionID != "session-1" || got.Provider != "claude" {
		t.Fatalf("failure identity = %#v", got)
	}
	if got.ErrorCode != "provider_timeout" || got.ErrorMessage != "provider timed out after 30s" {
		t.Fatalf("failure payload = %#v", got)
	}
}

func TestObserveStepDoesNotEmitTerminalFailure(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	ctx, _ := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "message_send", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	host.observeStep(ctx, "message_send", "runtime_exec", "workspace-1", "session-1", "claude", host.now(), errors.New("boom"))
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want none until the command boundary", observer.failures)
	}
}

func TestCommandBoundarySkipsTerminalFailureOnSuccess(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	ctx, command := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "message_send", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	host.observeStep(ctx, "message_send", "runtime_exec", "workspace-1", "session-1", "claude", host.now(), nil)
	command.finish(ctx, host, nil)
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want none", observer.failures)
	}
}

func TestCommandBoundaryIgnoresCleanupStepsAfterPrimaryFailure(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	primary := errors.New("runtime start failed")

	ctx, command := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "session_create", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	host.observeStep(ctx, "session_create", "runtime_started", "workspace-1", "session-1", "codex", host.now(), primary)
	host.observeStep(ctx, "session_create_cleanup", "runtime_closed", "workspace-1", "session-1", "codex", host.now(), errors.New("cleanup failed"))
	command.finish(ctx, host, primary)

	if len(observer.failures) != 1 || observer.failures[0].FailureStage != "runtime_started" {
		t.Fatalf("terminal failures = %#v, want one runtime_started failure", observer.failures)
	}
}

func TestCommandBoundaryUsesPreconditionStageWithoutAFailedStep(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	ctx, command := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "session_create", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	command.finish(ctx, host, ErrInvalidArgument)
	if len(observer.failures) != 1 || observer.failures[0].FailureStage != commandPreconditionStage {
		t.Fatalf("terminal failures = %#v, want one precondition failure", observer.failures)
	}
}

func TestCommandBoundaryDefersToASpecificEmission(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	ctx, command := host.beginCommand(context.Background(), commandTerminalFailureInput{
		flow: "message_send", workspaceID: "workspace-1", agentSessionID: "session-1",
	})
	host.observeGuidanceTargetFailure(
		ctx, SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"codex", "turn-1", "guidance-1", host.now(), ErrActiveTurnTargetMismatch,
	)
	command.finish(ctx, host, ErrActiveTurnTargetMismatch)
	if len(observer.failures) != 1 || observer.failures[0].Flow != "guidance" {
		t.Fatalf("terminal failures = %#v, want only the guidance emission", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaCoversInteractivePlanToolAndTurn(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	delta := CommittedDelta{
		RuntimeOperation: &RuntimeOperationCommitted{
			Stage: RuntimeOperationFailed, Provider: "codex", IsChildSession: true,
			Operation: storesqlite.RuntimeOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-interactive",
				Kind: storesqlite.RuntimeOperationKindInteractiveResponse, RequestID: "request-1", TurnID: "turn-1",
				LastError: "interactive submit rejected", Payload: map[string]any{"interactionKind": "plan"},
			},
		},
		GoalOperation: &GoalOperationCommitted{
			Stage: GoalOperationFailed, Provider: "claude-code", IsChildSession: true,
			Operation: storesqlite.GoalControlOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-goal",
				ClientSubmitID: "goal-1", LastError: "goal runtime unavailable",
			},
		},
		RootTurnsSettled: []RootTurnSettled{{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "cursor", StartupReconciled: true,
			Turn: storesqlite.Turn{
				TurnID: "turn-2", Outcome: storesqlite.TurnOutcomeFailed, SourceGoalOperationID: "goal-op-2",
				ErrorCode: "provider_timeout", ErrorMessage: "turn timed out",
				StartedAtUnixMS: 100, SettledAtUnixMS: 350,
			},
		}},
		SessionMessages: &SessionMessagesCommitted{
			Input: canonical.ReportSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "session-1"}, Provider: "openclaw",
			Result: storesqlite.MessageReportResult{
				Messages: []storesqlite.Message{{
					MessageID: "toolcall:1", AgentSessionID: "session-1", TurnID: "turn-2",
					Kind: "tool_call", Status: "failed",
					Payload: map[string]any{"toolName": "Bash", "errorMessage": "command exited 1"},
				}},
				StatusTransitionedMessageIDs: []string{"toolcall:1"},
			},
		},
	}

	ObserveTerminalFailuresFromDelta(context.Background(), observer, delta)
	if len(observer.failures) != 4 {
		t.Fatalf("failures = %#v, want 4", observer.failures)
	}
	byFlow := map[string]TerminalFailure{}
	for _, failure := range observer.failures {
		byFlow[failure.Flow] = failure
	}
	if byFlow["interactive_response"].InteractionKind != "plan" || byFlow["interactive_response"].ErrorMessage != "interactive submit rejected" ||
		byFlow["interactive_response"].Provider != "codex" || !byFlow["interactive_response"].IsChildSession {
		t.Fatalf("interactive failure = %#v", byFlow["interactive_response"])
	}
	if byFlow["goal_control"].ClientSubmitID != "goal-1" || byFlow["goal_control"].ErrorMessage != "goal runtime unavailable" ||
		byFlow["goal_control"].Provider != "claude-code" || !byFlow["goal_control"].IsChildSession {
		t.Fatalf("goal failure = %#v", byFlow["goal_control"])
	}
	if byFlow["turn"].TurnID != "turn-2" || byFlow["turn"].ErrorCode != "provider_timeout" ||
		byFlow["turn"].Provider != "cursor" || byFlow["turn"].OperationID != "goal-op-2" ||
		byFlow["turn"].TurnOutcome != storesqlite.TurnOutcomeFailed || byFlow["turn"].DurationMS != 250 ||
		!byFlow["turn"].StartupReconciled {
		t.Fatalf("turn failure = %#v", byFlow["turn"])
	}
	if byFlow["tool_call"].ToolNameFamily != "bash" || byFlow["tool_call"].ErrorMessage != "command exited 1" ||
		byFlow["tool_call"].Provider != "openclaw" {
		t.Fatalf("tool failure = %#v", byFlow["tool_call"])
	}
}

func TestTerminalFailuresFromDeltaDoesNotTreatInterruptedOrCanceledTurnsAsFailures(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		RootTurnsSettled: []RootTurnSettled{
			{Turn: storesqlite.Turn{TurnID: "turn-interrupted", Outcome: storesqlite.TurnOutcomeInterrupted, ErrorMessage: "daemon restarted"}},
			{Turn: storesqlite.Turn{TurnID: "turn-canceled", Outcome: storesqlite.TurnOutcomeCanceled, ErrorMessage: "user canceled"}},
		},
	})
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want interrupted and canceled turns excluded", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaEmitsPlanDecisionFailures(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		RuntimeOperation: &RuntimeOperationCommitted{
			Stage: RuntimeOperationFailed,
			Operation: storesqlite.RuntimeOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-plan",
				Kind: storesqlite.RuntimeOperationKindPlanDecision, TurnID: "turn-plan",
				LastError: "plan decision send failed",
			},
		},
	})
	if len(observer.failures) != 1 || observer.failures[0].Flow != "plan_decision" {
		t.Fatalf("failures = %#v", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaEmitsEditRetryFailures(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		RuntimeOperation: &RuntimeOperationCommitted{
			Stage: RuntimeOperationFailed,
			Operation: storesqlite.RuntimeOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-edit-retry",
				Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: "turn-edit",
				LastError: "edit retry disabled",
			},
		},
	})
	if len(observer.failures) != 1 || observer.failures[0].Flow != "edit_retry" {
		t.Fatalf("failures = %#v", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaMarksChildSessionTurnAndTool(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		ActivityState: &ActivityStateCommitted{
			Input: canonical.ReportSessionStateInput{
				WorkspaceID: "ws-1", AgentSessionID: "child-1",
				State: canonical.WorkspaceAgentSessionStateUpdate{
					Kind: storesqlite.SessionKindChild, ParentToolCallID: "call-1",
				},
			},
		},
		RootTurnsSettled: []RootTurnSettled{{
			WorkspaceID: "ws-1", AgentSessionID: "child-1", IsChildSession: true,
			Turn: storesqlite.Turn{
				TurnID: "turn-child", Outcome: storesqlite.TurnOutcomeFailed,
				ErrorMessage: "child turn failed",
			},
		}},
		SessionMessages: &SessionMessagesCommitted{
			Input: canonical.ReportSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "child-1"},
			Result: storesqlite.MessageReportResult{
				Messages: []storesqlite.Message{{
					MessageID: "toolcall:child", AgentSessionID: "child-1", TurnID: "turn-child",
					Kind: "tool_call", Status: "failed",
					Payload: map[string]any{"toolName": "Bash", "errorMessage": "child tool failed"},
				}},
				StatusTransitionedMessageIDs: []string{"toolcall:child"},
			},
		},
	})
	if len(observer.failures) != 2 {
		t.Fatalf("failures = %#v, want 2", observer.failures)
	}
	for _, failure := range observer.failures {
		if !failure.IsChildSession {
			t.Fatalf("expected child session marker on %#v", failure)
		}
	}
}

func TestTerminalFailuresFromDeltaSkipsAlreadyAppliedToolCalls(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		SessionMessages: &SessionMessagesCommitted{
			Input: canonical.ReportSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "session-1"},
			Result: storesqlite.MessageReportResult{
				Messages: []storesqlite.Message{
					{
						MessageID: "toolcall:replayed", AgentSessionID: "session-1", TurnID: "turn-1",
						Kind: "tool_call", Status: "failed",
						Payload: map[string]any{"toolName": "Bash", "errorMessage": "command exited 1"},
					},
					{
						MessageID: "toolcall:new", AgentSessionID: "session-1", TurnID: "turn-1",
						Kind: "tool_call", Status: "failed",
						Payload: map[string]any{"toolName": "Bash", "errorMessage": "command exited 2"},
					},
				},
				StatusTransitionedMessageIDs: []string{"toolcall:new"},
			},
		},
	})
	if len(observer.failures) != 1 || observer.failures[0].RequestID != "toolcall:new" {
		t.Fatalf("failures = %#v, want only the newly failed tool call", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaMarksChildSessionFromCommittedMessages(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
		SessionMessages: &SessionMessagesCommitted{
			Input:          canonical.ReportSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "child-1"},
			IsChildSession: true,
			Result: storesqlite.MessageReportResult{
				Messages: []storesqlite.Message{{
					MessageID: "toolcall:child", AgentSessionID: "child-1", TurnID: "turn-child",
					Kind: "tool_call", Status: "failed",
					Payload: map[string]any{"toolName": "Bash", "errorMessage": "child tool failed"},
				}},
				StatusTransitionedMessageIDs: []string{"toolcall:child"},
			},
		},
	})
	if len(observer.failures) != 1 || !observer.failures[0].IsChildSession {
		t.Fatalf("failures = %#v, want one child-session tool failure", observer.failures)
	}
}

func TestTerminalFailuresFromDeltaReadsNestedToolErrorText(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    string
	}{
		{
			name:    "top level string",
			payload: map[string]any{"toolName": "Bash", "error": "command exited 1"},
			want:    "command exited 1",
		},
		{
			name:    "nested text",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"text": "Exit code 137", "status": "failed"}},
			want:    "Exit code 137",
		},
		{
			name:    "nested message",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"message": "permission denied"}},
			want:    "permission denied",
		},
		{
			name:    "nested error message",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"errorMessage": "tool crashed"}},
			want:    "tool crashed",
		},
		{
			name:    "nested stderr",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"stderr": "no such file"}},
			want:    "no such file",
		},
		{
			// acpNormalizeToolOutput keys a scalar provider output as "output".
			name:    "nested scalar output",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"output": "connection reset"}},
			want:    "connection reset",
		},
		{
			name:    "no readable text falls back to the status",
			payload: map[string]any{"toolName": "Bash", "error": map[string]any{"exitCode": 137}},
			want:    "tool call failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			observer := &recordingTerminalFailureObserver{}
			ObserveTerminalFailuresFromDelta(context.Background(), observer, CommittedDelta{
				SessionMessages: &SessionMessagesCommitted{
					Input: canonical.ReportSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "session-1"},
					Result: storesqlite.MessageReportResult{
						Messages: []storesqlite.Message{{
							MessageID: "toolcall:nested", AgentSessionID: "session-1", TurnID: "turn-1",
							Kind: "tool_call", Status: "failed", Payload: tt.payload,
						}},
						StatusTransitionedMessageIDs: []string{"toolcall:nested"},
					},
				},
			})
			if len(observer.failures) != 1 || observer.failures[0].ErrorMessage != tt.want {
				t.Fatalf("failures = %#v, want error message %q", observer.failures, tt.want)
			}
		})
	}
}

func TestObserveGuidanceTargetFailureEmitsAggregatedTerminalFailure(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{TerminalFailureObserver: observer})
	host.observeGuidanceTargetFailure(
		context.Background(),
		SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"codex", "turn-1", "guidance-1", host.now(), ErrActiveTurnTargetMismatch,
	)
	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "guidance" || got.FailureStage != "guidance_target" || got.TurnID != "turn-1" {
		t.Fatalf("failure identity = %#v", got)
	}
	if got.ErrorCode != "active_turn_target_mismatch" || got.ClientSubmitID != "guidance-1" {
		t.Fatalf("failure payload = %#v", got)
	}
}
