package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// ObserveTerminalFailuresFromDelta extracts aggregated terminal failures from
// an already-committed delta.
//
// Host.notifyCommitted owns this for every delta it publishes, so a
// CommitObserver must never call it again for the deltas it receives. Only a
// report path that commits and calls NotifyCommitted without going through
// Host — the daemon's direct activity-state, session-message, and stale-turn
// reports — calls it, exactly once, next to its own NotifyCommitted.
func ObserveTerminalFailuresFromDelta(ctx context.Context, observer TerminalFailureObserver, delta CommittedDelta) {
	if observer == nil {
		return
	}
	for _, failure := range terminalFailuresFromDelta(delta) {
		if failure.ErrorMessage == "" && failure.ErrorCode == "" {
			continue
		}
		observer.ObserveTerminalFailure(ctx, failure)
	}
}

func terminalFailuresFromDelta(delta CommittedDelta) []TerminalFailure {
	failures := make([]TerminalFailure, 0, 4)
	childBySession := map[string]bool{}
	if delta.ActivityState != nil {
		sessionID := firstNonEmptyTrimmed(
			delta.ActivityState.Input.AgentSessionID,
			delta.ActivityState.Result.RootTurn.AgentSessionID,
		)
		if sessionID != "" {
			childBySession[sessionID] = sessionStateIsChild(delta.ActivityState.Input.State)
		}
	}
	if delta.RuntimeOperation != nil && delta.RuntimeOperation.Stage == RuntimeOperationFailed {
		if failure, ok := terminalFailureFromRuntimeOperation(*delta.RuntimeOperation); ok {
			failures = append(failures, failure)
		}
	}
	if delta.GoalOperation != nil &&
		(delta.GoalOperation.Stage == GoalOperationFailed || delta.GoalOperation.Stage == GoalOperationTerminal) {
		if failure, ok := terminalFailureFromGoalOperation(*delta.GoalOperation); ok {
			failures = append(failures, failure)
		}
	}
	for _, settled := range delta.RootTurnsSettled {
		if failure, ok := terminalFailureFromRootTurn(settled); ok {
			failures = append(failures, failure)
		}
	}
	if delta.SessionMessages != nil {
		failures = append(failures, terminalFailuresFromSessionMessages(*delta.SessionMessages, childBySession)...)
	}
	return failures
}

func terminalFailureFromRuntimeOperation(committed RuntimeOperationCommitted) (TerminalFailure, bool) {
	op := committed.Operation
	flow := runtimeOperationFailureFlow(op.Kind)
	if flow == "" {
		return TerminalFailure{}, false
	}
	message := strings.TrimSpace(op.LastError)
	if message == "" {
		message = strings.TrimSpace(op.Result)
	}
	if message == "" {
		message = "runtime operation failed"
	}
	return TerminalFailure{
		Flow:            flow,
		FailureStage:    "runtime_exec",
		WorkspaceID:     strings.TrimSpace(op.WorkspaceID),
		AgentSessionID:  strings.TrimSpace(op.AgentSessionID),
		TurnID:          strings.TrimSpace(op.TurnID),
		OperationID:     strings.TrimSpace(op.OperationID),
		ClientSubmitID:  runtimeOperationPayloadText(op.Payload, "clientSubmitId"),
		RequestID:       strings.TrimSpace(op.RequestID),
		Provider:        strings.TrimSpace(committed.Provider),
		ErrorCode:       strings.TrimSpace(op.Result),
		ErrorMessage:    message,
		InteractionKind: runtimeOperationInteractionKind(op),
		IsChildSession:  committed.IsChildSession,
		Retryable:       false,
	}, true
}

func runtimeOperationFailureFlow(kind string) string {
	switch strings.TrimSpace(kind) {
	case storesqlite.RuntimeOperationKindInteractiveResponse:
		return "interactive_response"
	case storesqlite.RuntimeOperationKindPlanDecision:
		return "plan_decision"
	case storesqlite.RuntimeOperationKindCancelTurn:
		return "turn_cancel"
	case storesqlite.RuntimeOperationKindEditRetry:
		return "edit_retry"
	default:
		return ""
	}
}

func runtimeOperationInteractionKind(op storesqlite.RuntimeOperation) string {
	if value := runtimeOperationPayloadText(op.Payload, "interactionKind"); value != "" {
		return value
	}
	if op.Kind == storesqlite.RuntimeOperationKindPlanDecision {
		return storesqlite.InteractionKindPlan
	}
	return ""
}

func terminalFailureFromGoalOperation(committed GoalOperationCommitted) (TerminalFailure, bool) {
	op := committed.Operation
	message := strings.TrimSpace(op.LastError)
	if message == "" {
		message = strings.TrimSpace(committed.State.LastError)
	}
	if message == "" && committed.Stage == GoalOperationTerminal {
		message = "goal control terminal incident"
	}
	if message == "" {
		return TerminalFailure{}, false
	}
	workspaceID := strings.TrimSpace(op.WorkspaceID)
	sessionID := strings.TrimSpace(op.AgentSessionID)
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(committed.State.WorkspaceID)
	}
	if sessionID == "" {
		sessionID = strings.TrimSpace(committed.State.AgentSessionID)
	}
	return TerminalFailure{
		Flow:           "goal_control",
		FailureStage:   string(committed.Stage),
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		OperationID:    strings.TrimSpace(op.OperationID),
		ClientSubmitID: strings.TrimSpace(op.ClientSubmitID),
		Provider:       strings.TrimSpace(committed.Provider),
		ErrorMessage:   message,
		IsChildSession: committed.IsChildSession,
		Retryable:      false,
	}, true
}

func terminalFailureFromRootTurn(settled RootTurnSettled) (TerminalFailure, bool) {
	outcome := strings.TrimSpace(settled.Turn.Outcome)
	switch outcome {
	case storesqlite.TurnOutcomeFailed:
	default:
		return TerminalFailure{}, false
	}
	message := strings.TrimSpace(settled.Turn.ErrorMessage)
	if message == "" {
		message = "turn " + outcome
	}
	return TerminalFailure{
		Flow:              "turn",
		FailureStage:      "settled",
		WorkspaceID:       strings.TrimSpace(settled.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(settled.AgentSessionID),
		TurnID:            strings.TrimSpace(settled.Turn.TurnID),
		OperationID:       strings.TrimSpace(settled.Turn.SourceGoalOperationID),
		Provider:          strings.TrimSpace(settled.Provider),
		ErrorCode:         strings.TrimSpace(settled.Turn.ErrorCode),
		ErrorMessage:      message,
		TurnOutcome:       outcome,
		DurationMS:        settledTurnDurationMS(settled.Turn),
		StartupReconciled: settled.StartupReconciled,
		IsChildSession:    settled.IsChildSession,
		Retryable:         false,
	}, true
}

func terminalFailuresFromSessionMessages(committed SessionMessagesCommitted, childBySession map[string]bool) []TerminalFailure {
	workspaceID := strings.TrimSpace(committed.Input.WorkspaceID)
	// Result.Messages also carries messages the report replayed without
	// changing anything. Only a real transition into the failed status is a
	// new incident.
	transitioned := make(map[string]struct{}, len(committed.Result.StatusTransitionedMessageIDs))
	for _, messageID := range committed.Result.StatusTransitionedMessageIDs {
		transitioned[strings.TrimSpace(messageID)] = struct{}{}
	}
	failures := make([]TerminalFailure, 0)
	for _, message := range committed.Result.Messages {
		if !isFailedToolCallMessage(message) {
			continue
		}
		if _, ok := transitioned[strings.TrimSpace(message.MessageID)]; !ok {
			continue
		}
		messageText := toolCallFailureMessage(message)
		sessionID := firstNonEmptyTrimmed(message.AgentSessionID, committed.Input.AgentSessionID)
		failures = append(failures, TerminalFailure{
			Flow:           "tool_call",
			FailureStage:   "settled",
			WorkspaceID:    workspaceID,
			AgentSessionID: sessionID,
			TurnID:         strings.TrimSpace(message.TurnID),
			RequestID:      strings.TrimSpace(message.MessageID),
			Provider:       strings.TrimSpace(committed.Provider),
			ErrorCode:      strings.TrimSpace(message.Status),
			ErrorMessage:   messageText,
			ToolNameFamily: toolNameFamily(message.Payload),
			IsChildSession: committed.IsChildSession || childBySession[sessionID],
			Retryable:      false,
		})
	}
	return failures
}

func settledTurnDurationMS(turn storesqlite.Turn) int64 {
	if turn.StartedAtUnixMS <= 0 || turn.SettledAtUnixMS < turn.StartedAtUnixMS {
		return 0
	}
	return turn.SettledAtUnixMS - turn.StartedAtUnixMS
}

func isFailedToolCallMessage(message storesqlite.Message) bool {
	if strings.TrimSpace(message.Kind) != "tool_call" {
		return false
	}
	switch strings.TrimSpace(message.Status) {
	case "failed", "errored":
		return true
	default:
		return false
	}
}

func toolCallFailureMessage(message storesqlite.Message) string {
	for _, key := range []string{"error", "errorMessage", "message"} {
		if value := toolCallPayloadFailureText(message.Payload, key); value != "" {
			return value
		}
	}
	status := strings.TrimSpace(message.Status)
	if status == "" {
		return "tool call failed"
	}
	return "tool call " + status
}

// toolCallPayloadFailureText prefers the provider's own text. Normalized ACP
// tool failures carry it in a nested body under payload.error, while imported
// and legacy shapes keep a plain string on the same key.
func toolCallPayloadFailureText(payload map[string]any, key string) string {
	if value := runtimeOperationPayloadText(payload, key); value != "" {
		return value
	}
	nested, ok := payload[key].(map[string]any)
	if !ok {
		return ""
	}
	return firstNonEmptyTrimmed(
		runtimeOperationPayloadText(nested, "text"),
		runtimeOperationPayloadText(nested, "message"),
		runtimeOperationPayloadText(nested, "errorMessage"),
		runtimeOperationPayloadText(nested, "stderr"),
		runtimeOperationPayloadText(nested, "stdout"),
		runtimeOperationPayloadText(nested, "output"),
	)
}

func toolNameFamily(payload map[string]any) string {
	raw := firstNonEmptyTrimmed(
		runtimeOperationPayloadText(payload, "toolName"),
		runtimeOperationPayloadText(payload, "name"),
		runtimeOperationPayloadText(payload, "tool_name"),
	)
	if raw == "" {
		return "unknown"
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	normalized = strings.ReplaceAll(normalized, " ", "_")
	switch {
	case strings.Contains(normalized, "bash"), strings.Contains(normalized, "shell"), strings.Contains(normalized, "terminal"):
		return "bash"
	case strings.Contains(normalized, "edit"), strings.Contains(normalized, "write"), strings.Contains(normalized, "apply_patch"):
		return "edit"
	case strings.Contains(normalized, "read"), strings.Contains(normalized, "grep"), strings.Contains(normalized, "glob"), strings.Contains(normalized, "search"):
		return "read"
	case strings.Contains(normalized, "browser"), strings.Contains(normalized, "web"):
		return "browser"
	default:
		if len(normalized) > 48 {
			return normalized[:48]
		}
		return normalized
	}
}

func firstNonEmptyTrimmed(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
