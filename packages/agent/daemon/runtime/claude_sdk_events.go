package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func payloadInt64(payload map[string]any, key string) int64 {
	switch value := payload[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		result, _ := value.Int64()
		return result
	default:
		return 0
	}
}

func (*ClaudeCodeSDKAdapter) applySidecarSessionEvent(adapterSession *claudeSDKAdapterSession, session Session, event claudeSDKSidecarEvent) []activityshared.Event {
	if event.Type == "usage_updated" {
		adapterSession.applyUsageUpdated(event.Payload)
		return nil
	}
	if event.Type != "session_started" && event.Type != "session_state" {
		return nil
	}
	adapterSession.applySessionPayload(&session, event.Payload)
	if event.Type != "session_started" {
		return nil
	}
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, claudeSDKRuntimeContext(session, adapterSession))}
}

func (a *ClaudeCodeSDKAdapter) sidecarTurnEvents(adapterSession *claudeSDKAdapterSession, session Session, turnID string, event claudeSDKSidecarEvent) ([]activityshared.Event, bool, error) {
	adapterSession.applySessionPayload(&session, event.Payload)
	providerTurnID := strings.TrimSpace(turnID)
	eventTurnID := firstNonEmptyString(payloadString(event.Payload, "turnId"), payloadString(event.Payload, "turnID"))
	if eventTurnID != "" && providerTurnID != "" && eventTurnID != providerTurnID {
		return nil, false, nil
	}
	if providerTurnID == "" {
		providerTurnID = eventTurnID
	}
	goalClearControlTurn := a.isGoalClearControlTurn(adapterSession, providerTurnID)
	if goalClearControlTurn && isClaudeSDKGoalClearHiddenEvent(event.Type) {
		return nil, false, nil
	}
	if goalClearControlTurn && isClaudeSDKTerminalEvent(event.Type) {
		a.forgetGoalClearControlTurn(adapterSession, providerTurnID)
		return nil, true, nil
	}
	rootTurnID := a.claudeSDKRootTurnID(adapterSession, providerTurnID)
	switch event.Type {
	case "ok":
		return nil, false, nil
	case "session_state":
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession))}, false, nil
	case "turn_started":
		metadata := map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}
		providerCreatedGoalTurn := false
		if origin := payloadString(event.Payload, "turnOrigin"); origin != "" {
			metadata["turnOrigin"] = origin
			if origin == "goal_arm" || origin == "goal_continuation" {
				providerCreatedGoalTurn = true
				// Goal control does not pre-allocate a canonical Turn. The provider's
				// turn_started event is the first authoritative Turn fact, so it also
				// starts a fresh root mapping instead of inheriting the preceding user
				// Turn from this long-lived SDK session.
				rootTurnID = providerTurnID
				a.beginClaudeSDKRootTurn(adapterSession, rootTurnID, providerTurnID)
				operationID := payloadString(event.Payload, "sourceGoalOperationId")
				revision := payloadInt64(event.Payload, "sourceGoalRevision")
				repairEpoch := payloadInt64(event.Payload, "sourceGoalRepairEpoch")
				metadata["sourceGoalOperationId"] = operationID
				metadata["sourceGoalRevision"] = revision
				metadata["sourceGoalRepairEpoch"] = repairEpoch
				a.mu.Lock()
				latestRevision, latestRepairEpoch := adapterSession.goalRevision, adapterSession.goalRepairEpoch
				a.mu.Unlock()
				if revision > 0 && revision == latestRevision && repairEpoch < latestRepairEpoch {
					a.cancelClaudeSDKGoalTurn(adapterSession, session, providerTurnID, revision, repairEpoch)
				}
			}
		}
		if !providerCreatedGoalTurn {
			a.rememberClaudeSDKRootProviderTurn(adapterSession, providerTurnID)
		}
		if payloadBoolValue(event.Payload, "synthetic") {
			metadata["synthetic"] = true
		}
		return []activityshared.Event{claudeSDKRootProviderTurnStartedEvent(session, rootTurnID, providerTurnID, metadata)}, false, nil
	case "goal_command_started":
		evidence := map[string]any{
			"source":         "claude_goal_command_started",
			"confidence":     "lifecycle_inferred",
			"phase":          "applied",
			"operationId":    payloadString(event.Payload, "operationId"),
			"revision":       payloadInt64(event.Payload, "revision"),
			"repairEpoch":    payloadInt64(event.Payload, "repairEpoch"),
			"action":         payloadString(event.Payload, "action"),
			"providerTurnId": turnID,
		}
		runtimeContext := claudeSDKRuntimeContext(session, adapterSession)
		runtimeContext["goalControlEvidence"] = evidence
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), runtimeContext)}, false, nil
	case "goal_command_superseded":
		return nil, false, nil
	case "commands_updated":
		if adapterSession.applyCommandsUpdated(session.AgentSessionID, event.Payload) {
			a.emitCommandSnapshot(claudeSDKCommandSnapshot(session.AgentSessionID, adapterSession.liveState))
		}
		return nil, false, nil
	case "session_title_updated":
		if titleEvent, ok := normalizedSessionTitleEvent(session, event.Payload); ok {
			return []activityshared.Event{titleEvent}, false, nil
		}
		return nil, false, nil
	case "error":
		return nil, false, errors.New(payloadString(event.Payload, "error"))
	case "approval_requested", "user_input_requested":
		events, err := a.claudeSDKInteractiveRequested(adapterSession, session, rootTurnID, providerTurnID, event.Payload)
		return events, false, err
	case "approval_resolved", "user_input_resolved":
		return a.claudeSDKInteractiveResolved(adapterSession, session, rootTurnID, event.Payload), false, nil
	case "compact_started":
		compact, ok := a.compactMessageEvent(adapterSession, session, rootTurnID, messageStreamStateStreaming, "running", "")
		if !ok {
			return nil, false, nil
		}
		return []activityshared.Event{compact}, false, nil
	case "compact_completed":
		compact, ok := a.compactMessageEvent(adapterSession, session, rootTurnID, messageStreamStateCompleted, "completed", "")
		if !ok {
			return nil, false, nil
		}
		return []activityshared.Event{compact}, false, nil
	case "compact_failed":
		detail := payloadString(event.Payload, "reason")
		if detail == "" {
			detail = strings.TrimSpace(strings.TrimPrefix(payloadString(event.Payload, "content"), "Compacting failed:"))
		}
		compact, ok := a.compactMessageEvent(adapterSession, session, rootTurnID, messageStreamStateFailed, "failed", detail)
		if !ok {
			return nil, false, nil
		}
		return []activityshared.Event{compact}, false, nil
	case "assistant_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(providerTurnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return a.claudeSDKAssistantEvents(adapterSession, session, rootTurnID, messageID, content, false), false, nil
	case "assistant_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(providerTurnID))
		return a.claudeSDKAssistantEvents(
			adapterSession,
			session,
			rootTurnID,
			messageID,
			payloadString(event.Payload, "content"),
			true,
		), false, nil
	case "assistant_failed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(providerTurnID))
		return a.claudeSDKAssistantFailedEvents(
			adapterSession,
			session,
			rootTurnID,
			messageID,
			payloadString(event.Payload, "content"),
		), false, nil
	case "thinking_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(providerTurnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return a.claudeSDKThinkingEvents(adapterSession, session, rootTurnID, messageID, content, false), false, nil
	case "thinking_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(providerTurnID))
		return a.claudeSDKThinkingEvents(
			adapterSession,
			session,
			rootTurnID,
			messageID,
			payloadString(event.Payload, "content"),
			true,
		), false, nil
	case "tool_started", "tool_updated":
		if a.claudeSDKToolEventTargetsClosedTurn(adapterSession, rootTurnID, event.Payload) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, rootTurnID, event.Payload, EventCallStarted, messageStreamStateStreaming, event.Type)
		events = a.projectClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "tool_completed":
		if a.claudeSDKToolEventTargetsClosedTurn(adapterSession, rootTurnID, event.Payload) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, rootTurnID, event.Payload, EventCallCompleted, messageStreamStateCompleted, event.Type)
		events = a.projectClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "tool_failed":
		if a.claudeSDKToolEventTargetsClosedTurn(adapterSession, rootTurnID, event.Payload) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, rootTurnID, event.Payload, EventCallFailed, messageStreamStateFailed, event.Type)
		events = a.projectClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "task_started", "task_progress", "task_completed":
		if child, ok := adapterSession.claudeSDKChildForPayload(event.Payload); ok &&
			a.turnAlreadySettled(adapterSession, child.TurnID) {
			return nil, false, nil
		}
		return adapterSession.claudeSDKTaskLifecycleEvents(session, rootTurnID, event.Type, event.Payload), false, nil
	case "plan_updated":
		return claudeSDKPlanEvents(session, rootTurnID, event.Payload), false, nil
	case "usage_updated":
		if adapterSession.applyUsageUpdated(event.Payload) {
			if event, ok := normalizedUsageUpdatedEvent(session); ok {
				return []activityshared.Event{event}, false, nil
			}
		}
		return nil, false, nil
	case "speed_updated":
		if adapterSession.applySpeedUpdated(event.Payload) {
			if event, ok := normalizedConfigOptionsUpdatedEvent(session, map[string]any{"key": "fast"}); ok {
				return []activityshared.Event{event}, false, nil
			}
		}
		return nil, false, nil
	case "goal_updated":
		updateType := adapterSession.applyGoalUpdated(event.Payload)
		if updateType == "" {
			return nil, false, nil
		}
		events := make([]activityshared.Event, 0, 2)
		if goalEvent, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
			events = append(events, goalEvent)
		}
		events = append(events, newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession)))
		return events, false, nil
	case "turn_completed":
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishCompleted, "")
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, providerTurnID, activityshared.TurnOutcomeCompleted, map[string]any{
			"adapter":    claudeSDKSidecarAdapterName,
			"stopReason": firstNonEmpty(payloadString(event.Payload, "stopReason"), "end_turn"),
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, providerTurnID, true)...)
		return events, true, nil
	case "turn_canceled":
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishInterrupted, "interrupted")
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, providerTurnID, activityshared.TurnOutcomeCanceled, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, providerTurnID, false)...)
		return events, true, nil
	case "turn_failed":
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishFailed, "turn_failed")
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, providerTurnID, activityshared.TurnOutcomeFailed, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
			"error":   payloadString(event.Payload, "error"),
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, providerTurnID, false)...)
		return events, true, nil
	default:
		return nil, false, nil
	}
}

func isClaudeSDKGoalClearHiddenEvent(eventType string) bool {
	switch eventType {
	case "turn_started", "assistant_delta", "assistant_completed", "assistant_failed", "thinking_delta", "thinking_completed":
		return true
	default:
		return false
	}
}

func isClaudeSDKTerminalEvent(eventType string) bool {
	switch eventType {
	case "turn_completed", "turn_canceled", "turn_failed":
		return true
	default:
		return false
	}
}

func claudeSDKRootProviderTurnStartedEvent(session Session, rootTurnID string, providerTurnID string, metadata map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, "claude-sdk:provider-turn-started:"+providerTurnID, rootTurnID)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnStarted(ctx, rootTurnID, providerTurnID)
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func claudeSDKRootProviderTurnCompletedEvent(session Session, rootTurnID string, providerTurnID string, outcome activityshared.TurnOutcome, metadata map[string]any) activityshared.Event {
	ctx, ok := activityEventContext(session, "claude-sdk:provider-turn-completed:"+providerTurnID, rootTurnID)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnCompleted(ctx, rootTurnID, providerTurnID, outcome)
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func (a *ClaudeCodeSDKAdapter) beginClaudeSDKRootTurn(adapterSession *claudeSDKAdapterSession, rootTurnID string, providerTurnID string) {
	if a == nil || adapterSession == nil {
		return
	}
	rootTurnID = strings.TrimSpace(rootTurnID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	a.mu.Lock()
	adapterSession.rootTurnID = rootTurnID
	adapterSession.rootProviderTurns = make(map[string]struct{})
	if providerTurnID != "" {
		adapterSession.rootProviderTurns[providerTurnID] = struct{}{}
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootTurnID(adapterSession *claudeSDKAdapterSession, fallback string) string {
	if a == nil || adapterSession == nil {
		return strings.TrimSpace(fallback)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if rootTurnID := strings.TrimSpace(adapterSession.rootTurnID); rootTurnID != "" {
		return rootTurnID
	}
	adapterSession.rootTurnID = strings.TrimSpace(fallback)
	return adapterSession.rootTurnID
}

func (a *ClaudeCodeSDKAdapter) rememberClaudeSDKRootProviderTurn(adapterSession *claudeSDKAdapterSession, providerTurnID string) {
	if a == nil || adapterSession == nil || strings.TrimSpace(providerTurnID) == "" {
		return
	}
	a.mu.Lock()
	if adapterSession.rootProviderTurns == nil {
		adapterSession.rootProviderTurns = make(map[string]struct{})
	}
	adapterSession.rootProviderTurns[strings.TrimSpace(providerTurnID)] = struct{}{}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) consumeClaudeSDKRootProviderTurn(adapterSession *claudeSDKAdapterSession, providerTurnID string) bool {
	if a == nil || adapterSession == nil || strings.TrimSpace(providerTurnID) == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	providerTurnID = strings.TrimSpace(providerTurnID)
	if _, ok := adapterSession.rootProviderTurns[providerTurnID]; !ok {
		return false
	}
	delete(adapterSession.rootProviderTurns, providerTurnID)
	return true
}

func (a *ClaudeCodeSDKAdapter) startClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession) error {
	if a == nil || adapterSession == nil || adapterSession.reader == nil {
		return ErrSessionDisconnected
	}
	a.mu.Lock()
	if adapterSession.readerStarted {
		a.mu.Unlock()
		return nil
	}
	adapterSession.readerStarted = true
	a.mu.Unlock()
	go a.runClaudeSDKReader(agentSessionID, adapterSession)
	return nil
}

func (a *ClaudeCodeSDKAdapter) runClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession) {
	for {
		event, err := adapterSession.reader.next(context.Background())
		if err != nil {
			a.failClaudeSDKReader(agentSessionID, adapterSession, err)
			return
		}
		a.dispatchClaudeSDKEvent(agentSessionID, adapterSession, event)
	}
}

// nextTurnLifecycleSeq allocates the next per-session lifecycle snapshot
// sequence number.
func (a *ClaudeCodeSDKAdapter) nextTurnLifecycleSeq(adapterSession *claudeSDKAdapterSession) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	adapterSession.lifecycleSeq++
	return adapterSession.lifecycleSeq
}

// stampTurnLifecycleSnapshots stamps an adapter-origin TurnLifecycle snapshot
// onto every turn.* event in the batch (ADR 0008); see
// stampAdapterTurnLifecycleEvents for the contract. It also records terminal
// transitions so Cancel can tell an already-settled turn apart from a live
// one.
func (a *ClaudeCodeSDKAdapter) stampTurnLifecycleSnapshots(adapterSession *claudeSDKAdapterSession, events []activityshared.Event) []activityshared.Event {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return events
	}
	events = stampAdapterTurnLifecycleEvents(events, func() uint64 {
		return a.nextTurnLifecycleSeq(adapterSession)
	})
	a.mu.Lock()
	for _, event := range events {
		switch event.Type {
		// turn.canceled folds into turn.completed with an interrupted
		// outcome at construction (newTurnActivityEventWithID), so these two
		// cover every terminal transition.
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			turnID := strings.TrimSpace(event.Payload.TurnID)
			if turnID == "" {
				continue
			}
			if adapterSession.settledTurns == nil {
				adapterSession.settledTurns = make(map[string]string)
			}
			// Sessions are long-lived; keep the guard bounded rather than
			// growing one entry per turn forever.
			if len(adapterSession.settledTurns) > 64 {
				adapterSession.settledTurns = make(map[string]string)
			}
			outcome := strings.TrimSpace(event.Payload.TurnOutcome)
			if outcome == "" {
				if snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event); ok {
					outcome = snapshot.Outcome
				}
			}
			adapterSession.settledTurns[turnID] = outcome
		}
	}
	a.mu.Unlock()
	return events
}

// turnAlreadySettled reports whether a terminal event for the turn already
// left this adapter.
func (a *ClaudeCodeSDKAdapter) turnAlreadySettled(adapterSession *claudeSDKAdapterSession, turnID string) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, settled := adapterSession.settledTurns[strings.TrimSpace(turnID)]
	return settled
}

// claudeSDKToolEventTargetsClosedTurn preserves the SDK's normal weak ordering:
// an active child may still report after the root provider turn has ended. Once
// services/tuttid explicitly cancels that exact child turn, however, later SDK
// tool events are cancellation fallout and must not reopen or reclassify it.
func (a *ClaudeCodeSDKAdapter) claudeSDKToolEventTargetsClosedTurn(
	adapterSession *claudeSDKAdapterSession,
	rootTurnID string,
	payload map[string]any,
) bool {
	if child, ok := adapterSession.claudeSDKChildForPayload(payload); ok {
		return a.turnAlreadySettled(adapterSession, child.TurnID)
	}
	return a.turnAlreadySettled(adapterSession, rootTurnID)
}

func (a *ClaudeCodeSDKAdapter) markClaudeSDKTurnClosed(adapterSession *claudeSDKAdapterSession, turnID string, outcome string) {
	if a == nil || adapterSession == nil || strings.TrimSpace(turnID) == "" {
		return
	}
	a.mu.Lock()
	if adapterSession.settledTurns == nil {
		adapterSession.settledTurns = make(map[string]string)
	}
	adapterSession.settledTurns[strings.TrimSpace(turnID)] = strings.TrimSpace(outcome)
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) dispatchClaudeSDKEvent(agentSessionID string, adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) {
	if a == nil || adapterSession == nil {
		return
	}
	a.logClaudeSDKLifecycleEvent(agentSessionID, adapterSession, event)
	if response := a.takeClaudeSDKResponseWaiter(adapterSession, event); response != nil {
		response <- event
		return
	}
	turnID := payloadString(event.Payload, "turnId")
	if turnID == "" {
		turnID = payloadString(event.Payload, "turnID")
	}
	waiter := a.claudeSDKTurnWaiter(adapterSession, turnID)
	if claudeSDKSidecarTurnTerminal(event.Type) {
		known := a.consumeClaudeSDKRootProviderTurn(adapterSession, turnID)
		goalClearControlTurn := a.isGoalClearControlTurn(adapterSession, turnID)
		if waiter == nil && !known && !goalClearControlTurn {
			return
		}
	}
	session := a.claudeSDKSessionSnapshot(adapterSession)
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session.AgentSessionID = agentSessionID
	}
	next, terminal, err := a.sidecarTurnEvents(adapterSession, session, turnID, event)
	next = a.stampTurnLifecycleSnapshots(adapterSession, next)
	if len(next) > 0 {
		a.updateClaudeSDKSessionSnapshot(adapterSession, next)
	}
	if waiter != nil {
		a.completeClaudeSDKWaiterEvent(adapterSession, waiter, turnID, next, terminal, err)
		return
	}
	if err != nil {
		next = append(next, newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error": err.Error(),
		}))
	}
	a.emitClaudeSDKSessionEvents(agentSessionID, next)
}

func (a *ClaudeCodeSDKAdapter) logClaudeSDKLifecycleEvent(agentSessionID string, adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) {
	if !claudeSDKLifecycleEventDiagnostic(event) {
		return
	}
	a.mu.Lock()
	adapterSession.diagnosticEventSeq++
	sequence := adapterSession.diagnosticEventSeq
	providerSessionID := strings.TrimSpace(adapterSession.providerSessionID)
	rootTurnID := strings.TrimSpace(adapterSession.rootTurnID)
	a.mu.Unlock()

	payload := event.Payload
	args := []any{
		"event", "agent_session.claude_sdk.lifecycle_event",
		"sequence", sequence,
		"agent_session_id", strings.TrimSpace(agentSessionID),
		"provider_session_id", providerSessionID,
		"root_turn_id", rootTurnID,
		"sidecar_event_type", strings.TrimSpace(event.Type),
	}
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "turn_id", payloadKey: "turnId"},
		{logKey: "sdk_message_type", payloadKey: "sdkMessageType"},
		{logKey: "sdk_message_subtype", payloadKey: "sdkMessageSubtype"},
		{logKey: "active_turn_id_before", payloadKey: "activeTurnIdBefore"},
		{logKey: "task_id", payloadKey: "taskId"},
		{logKey: "agent_id", payloadKey: "agentId"},
		{logKey: "tool_use_id", payloadKey: "toolUseId"},
		{logKey: "tool_call_id", payloadKey: "toolCallId"},
		{logKey: "parent_tool_use_id", payloadKey: "parentToolUseId"},
		{logKey: "tool_name", payloadKey: "toolName"},
		{logKey: "status", payloadKey: "status"},
		{logKey: "stop_reason", payloadKey: "stopReason"},
	} {
		if value := strings.TrimSpace(payloadString(payload, field.payloadKey)); value != "" {
			args = append(args, field.logKey, value)
		}
	}
	if payloadBoolValue(payload, "synthetic") {
		args = append(args, "synthetic", true)
	}
	if payloadBoolValue(payload, "taskNotification") {
		args = append(args, "task_notification", true)
	}
	if payloadBoolValue(payload, "rootContinuationCandidate") {
		args = append(args, "root_continuation_candidate", true)
	}
	if payloadBoolValue(payload, "sdkResultIsError") {
		args = append(args, "sdk_result_is_error", true)
	}
	if apiErrorStatus := payloadInt64(payload, "sdkApiErrorStatus"); apiErrorStatus > 0 {
		args = append(args, "sdk_api_error_status", apiErrorStatus)
	}
	if payloadBoolValue(payload, "syntheticTimeout") {
		args = append(args, "synthetic_timeout", true)
	}
	slog.Info("agent session Claude SDK lifecycle event", args...)
}

func claudeSDKLifecycleEventDiagnostic(event claudeSDKSidecarEvent) bool {
	switch strings.TrimSpace(event.Type) {
	case "sdk_lifecycle_observed",
		"turn_started", "turn_completed", "turn_canceled", "turn_failed",
		"task_started", "task_progress", "task_completed":
		return true
	case "tool_started", "tool_completed", "tool_failed":
		return strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Agent") ||
			strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Task")
	default:
		return false
	}
}

func claudeSDKSidecarTurnTerminal(eventType string) bool {
	switch eventType {
	case "turn_completed", "turn_canceled", "turn_failed":
		return true
	default:
		return false
	}
}

func (a *ClaudeCodeSDKAdapter) registerClaudeSDKTurn(adapterSession *claudeSDKAdapterSession, turnID string, emit EventSink) *claudeSDKTurnWaiter {
	waiter := &claudeSDKTurnWaiter{
		turnID: strings.TrimSpace(turnID),
		emit:   emit,
		done:   make(chan claudeSDKTurnResult, 1),
	}
	a.mu.Lock()
	if adapterSession.turns == nil {
		adapterSession.turns = make(map[string]*claudeSDKTurnWaiter)
	}
	adapterSession.turns[waiter.turnID] = waiter
	a.mu.Unlock()
	return waiter
}

func (a *ClaudeCodeSDKAdapter) unregisterClaudeSDKTurn(adapterSession *claudeSDKAdapterSession, turnID string, waiter *claudeSDKTurnWaiter) {
	if a == nil || adapterSession == nil || waiter == nil {
		return
	}
	a.mu.Lock()
	if current := adapterSession.turns[strings.TrimSpace(turnID)]; current == waiter {
		delete(adapterSession.turns, strings.TrimSpace(turnID))
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) claudeSDKTurnWaiter(adapterSession *claudeSDKAdapterSession, turnID string) *claudeSDKTurnWaiter {
	if a == nil || adapterSession == nil || strings.TrimSpace(turnID) == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return adapterSession.turns[strings.TrimSpace(turnID)]
}

func (a *ClaudeCodeSDKAdapter) completeClaudeSDKWaiterEvent(
	adapterSession *claudeSDKAdapterSession,
	waiter *claudeSDKTurnWaiter,
	turnID string,
	events []activityshared.Event,
	terminal bool,
	err error,
) {
	if waiter == nil {
		return
	}
	waiter.mu.Lock()
	if waiter.completed {
		waiter.mu.Unlock()
		return
	}
	if len(events) > 0 {
		waiter.events = append(waiter.events, events...)
	}
	completed := err != nil || terminal
	var resultEvents []activityshared.Event
	if completed {
		waiter.completed = true
		resultEvents = append([]activityshared.Event(nil), waiter.events...)
	}
	emit := waiter.emit
	waiter.mu.Unlock()
	if len(events) > 0 && emit != nil {
		emit(events)
	}
	if !completed {
		return
	}
	a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
	waiter.done <- claudeSDKTurnResult{
		events: resultEvents,
		err:    err,
	}
}

func (a *ClaudeCodeSDKAdapter) failClaudeSDKReader(agentSessionID string, adapterSession *claudeSDKAdapterSession, err error) {
	if a == nil || adapterSession == nil {
		return
	}
	a.markSessionInvalid(adapterSession)
	a.mu.Lock()
	turns := make([]*claudeSDKTurnWaiter, 0, len(adapterSession.turns))
	for turnID, waiter := range adapterSession.turns {
		turns = append(turns, waiter)
		delete(adapterSession.turns, turnID)
	}
	responses := make([]chan claudeSDKSidecarEvent, 0, len(adapterSession.pendingResponses))
	for id, response := range adapterSession.pendingResponses {
		responses = append(responses, response)
		delete(adapterSession.pendingResponses, id)
	}
	a.mu.Unlock()
	for _, waiter := range turns {
		waiter.mu.Lock()
		if waiter.completed {
			waiter.mu.Unlock()
			continue
		}
		waiter.completed = true
		events := append([]activityshared.Event(nil), waiter.events...)
		waiter.mu.Unlock()
		waiter.done <- claudeSDKTurnResult{
			events: events,
			err:    err,
		}
	}
	for _, response := range responses {
		response <- claudeSDKSidecarEvent{Type: "error", Payload: map[string]any{"error": err.Error(), "transport": true}}
	}
	// Any interactive/permission request still awaiting a human decision when
	// the sidecar connection is lost must be resolved explicitly. Without
	// this, the pending approval bookkeeping is discarded silently along
	// with the session (below), leaving the GUI's permission dialog with no
	// terminal event: on the next reconnect/resume it simply vanishes with
	// no explanation while the turn itself fails, giving the appearance that
	// the request was answered (or bypassed) when it never was.
	session := a.claudeSDKSessionSnapshot(adapterSession)
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session.AgentSessionID = agentSessionID
	}
	pendingFailureEvents := a.claudeSDKPendingRequestFailureEvents(adapterSession, session, "", err)
	pendingFailureEvents = append(pendingFailureEvents, a.finishAllClaudeSDKTurnLifecycles(
		adapterSession,
		session,
		claudeSDKTurnFinishFailed,
		err.Error(),
	)...)
	a.removeSession(agentSessionID, adapterSession)
	a.emitClaudeSDKSessionEvents(agentSessionID, pendingFailureEvents)
}

func (a *ClaudeCodeSDKAdapter) takeClaudeSDKResponseWaiter(adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) chan claudeSDKSidecarEvent {
	if a == nil || adapterSession == nil || strings.TrimSpace(event.ID) == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	response := adapterSession.pendingResponses[strings.TrimSpace(event.ID)]
	if response != nil {
		delete(adapterSession.pendingResponses, strings.TrimSpace(event.ID))
	}
	return response
}

func (a *ClaudeCodeSDKAdapter) registerClaudeSDKResponse(adapterSession *claudeSDKAdapterSession, requestID string) chan claudeSDKSidecarEvent {
	response := make(chan claudeSDKSidecarEvent, 1)
	a.mu.Lock()
	if adapterSession.pendingResponses == nil {
		adapterSession.pendingResponses = make(map[string]chan claudeSDKSidecarEvent)
	}
	adapterSession.pendingResponses[strings.TrimSpace(requestID)] = response
	a.mu.Unlock()
	return response
}

func (a *ClaudeCodeSDKAdapter) unregisterClaudeSDKResponse(adapterSession *claudeSDKAdapterSession, requestID string, response chan claudeSDKSidecarEvent) {
	if a == nil || adapterSession == nil || response == nil {
		return
	}
	a.mu.Lock()
	if current := adapterSession.pendingResponses[strings.TrimSpace(requestID)]; current == response {
		delete(adapterSession.pendingResponses, strings.TrimSpace(requestID))
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) claudeSDKSessionSnapshot(adapterSession *claudeSDKAdapterSession) Session {
	if a == nil || adapterSession == nil {
		return Session{}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return adapterSession.session
}

func (a *ClaudeCodeSDKAdapter) updateClaudeSDKSessionSnapshot(adapterSession *claudeSDKAdapterSession, events []activityshared.Event) {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	adapterSession.session = applySessionEvents(adapterSession.session, eventsOwnedBySession(events, adapterSession.session.AgentSessionID))
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) emitClaudeSDKSessionEvents(agentSessionID string, events []activityshared.Event) {
	if a == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	sink := a.eventSink
	a.mu.Unlock()
	if sink != nil {
		sink(agentSessionID, events)
	}
}
