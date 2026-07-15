package agentruntime

import (
	"context"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

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
	turnID = strings.TrimSpace(turnID)
	eventTurnID := firstNonEmptyString(payloadString(event.Payload, "turnId"), payloadString(event.Payload, "turnID"))
	if eventTurnID != "" && turnID != "" && eventTurnID != turnID {
		return nil, false, nil
	}
	if turnID == "" {
		turnID = eventTurnID
	}
	turnID = adapterSession.backgroundAgentTurnID(event.Payload, turnID)
	switch event.Type {
	case "ok":
		return nil, false, nil
	case "session_state":
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession))}, false, nil
	case "turn_started":
		metadata := map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}
		if payloadBoolValue(event.Payload, "synthetic") {
			metadata["synthetic"] = true
		}
		return []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", metadata)}, false, nil
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
		events, err := a.claudeSDKInteractiveRequested(adapterSession, session, turnID, event.Payload)
		return events, false, err
	case "approval_resolved", "user_input_resolved":
		return a.claudeSDKInteractiveResolved(adapterSession, session, turnID, event.Payload), false, nil
	case "compact_started":
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateStreaming, firstNonEmpty(payloadString(event.Payload, "content"), "Compacting..."))}, false, nil
	case "compact_completed":
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateCompleted, firstNonEmpty(payloadString(event.Payload, "content"), "Compacting completed."))}, false, nil
	case "compact_failed":
		content := firstNonEmpty(payloadString(event.Payload, "content"), "Compacting failed.")
		return []activityshared.Event{adapterSession.compactMessageEvent(session, turnID, messageStreamStateFailed, content)}, false, nil
	case "assistant_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(turnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return a.claudeSDKAssistantEvents(adapterSession, session, turnID, messageID, content, false), false, nil
	case "assistant_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.assistantMessageID(turnID))
		return a.claudeSDKAssistantEvents(
			adapterSession,
			session,
			turnID,
			messageID,
			payloadString(event.Payload, "content"),
			true,
		), false, nil
	case "thinking_delta":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(turnID))
		content := firstNonEmpty(payloadString(event.Payload, "snapshot"), payloadString(event.Payload, "content"))
		return a.claudeSDKThinkingEvents(adapterSession, session, turnID, messageID, content, false), false, nil
	case "thinking_completed":
		messageID := firstNonEmptyString(payloadString(event.Payload, "messageId"), adapterSession.thinkingMessageID(turnID))
		return a.claudeSDKThinkingEvents(
			adapterSession,
			session,
			turnID,
			messageID,
			payloadString(event.Payload, "content"),
			true,
		), false, nil
	case "tool_started", "tool_updated":
		if a.turnAlreadySettled(adapterSession, turnID) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallStarted, messageStreamStateStreaming, event.Type)
		a.trackClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "tool_completed":
		if a.turnAlreadySettled(adapterSession, turnID) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallCompleted, messageStreamStateCompleted, event.Type)
		a.trackClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "tool_failed":
		if a.turnAlreadySettled(adapterSession, turnID) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, turnID, event.Payload, EventCallFailed, messageStreamStateFailed, event.Type)
		a.trackClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "task_started", "task_progress", "task_completed":
		return adapterSession.claudeSDKTaskLifecycleEvents(session, turnID, event.Type, event.Payload), false, nil
	case "plan_updated":
		return claudeSDKPlanEvents(session, turnID, event.Payload), false, nil
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
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, claudeSDKTurnFinishCompleted, "")
		events = append(events, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"adapter":    claudeSDKSidecarAdapterName,
			"stopReason": firstNonEmpty(payloadString(event.Payload, "stopReason"), "end_turn"),
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, true)...)
		return events, true, nil
	case "turn_canceled":
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, claudeSDKTurnFinishInterrupted, "interrupted")
		events = append(events, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, false)...)
		return events, true, nil
	case "turn_failed":
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, claudeSDKTurnFinishFailed, "turn_failed")
		events = append(events, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
			"error":   payloadString(event.Payload, "error"),
		}))
		events = append(events, a.goalEventsOnTurnSettled(adapterSession, session, turnID, false)...)
		return events, true, nil
	default:
		return nil, false, nil
	}
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

func (a *ClaudeCodeSDKAdapter) dispatchClaudeSDKEvent(agentSessionID string, adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) {
	if a == nil || adapterSession == nil {
		return
	}
	if response := a.takeClaudeSDKResponseWaiter(adapterSession, event); response != nil {
		response <- event
		return
	}
	turnID := payloadString(event.Payload, "turnId")
	if turnID == "" {
		turnID = payloadString(event.Payload, "turnID")
	}
	waiter := a.claudeSDKTurnWaiter(adapterSession, turnID)
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
	if terminal {
		// No Exec()/ExecAsync() waiter is tracking this turnID. Drop only
		// terminals for turns we never started on the session sink (queued
		// orphans from sidecar turnQueue / settleQueuedTurn). Synthetic
		// background continuations publish turn_started without a waiter;
		// their completed/failed/canceled must close that same lifecycle.
		if !a.consumeOpenSessionTurn(adapterSession, turnID) {
			return
		}
	} else {
		a.rememberOpenSessionTurns(adapterSession, next)
	}
	if err != nil {
		next = append(next, newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error": err.Error(),
		}))
	}
	a.emitClaudeSDKSessionEvents(agentSessionID, next)
}

// rememberOpenSessionTurns records turn IDs whose start was published through
// the session event sink so a later waiter-less terminal can close them.
func (a *ClaudeCodeSDKAdapter) rememberOpenSessionTurns(
	adapterSession *claudeSDKAdapterSession,
	events []activityshared.Event,
) {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, event := range events {
		if event.Type != activityshared.EventTurnStarted {
			continue
		}
		turnID := strings.TrimSpace(event.Payload.TurnID)
		if turnID == "" {
			continue
		}
		if adapterSession.openSessionTurns == nil {
			adapterSession.openSessionTurns = make(map[string]struct{})
		}
		// Sessions are long-lived; keep the guard bounded rather than growing
		// one entry per synthetic continuation forever.
		if len(adapterSession.openSessionTurns) > 64 {
			adapterSession.openSessionTurns = make(map[string]struct{})
		}
		adapterSession.openSessionTurns[turnID] = struct{}{}
	}
}

// consumeOpenSessionTurn reports whether turnID was started on the session
// sink and removes it so the matching terminal can be emitted once.
func (a *ClaudeCodeSDKAdapter) consumeOpenSessionTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := adapterSession.openSessionTurns[turnID]; !ok {
		return false
	}
	delete(adapterSession.openSessionTurns, turnID)
	return true
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
	if len(events) > 0 {
		waiter.events = append(waiter.events, events...)
		if waiter.emit != nil {
			waiter.emit(events)
		}
	}
	if err == nil && !terminal {
		return
	}
	a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
	waiter.done <- claudeSDKTurnResult{
		events: append([]activityshared.Event(nil), waiter.events...),
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
		waiter.done <- claudeSDKTurnResult{
			events: append([]activityshared.Event(nil), waiter.events...),
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
	adapterSession.session = applySessionEvents(adapterSession.session, events)
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
