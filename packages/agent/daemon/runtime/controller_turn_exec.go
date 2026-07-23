package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) beginTurn(session Session, turnID string, cancel context.CancelFunc) (Session, error) {
	return c.beginTurnWithTuttiModeSnapshot(session, turnID, cancel, nil)
}

func (c *Controller) beginTurnWithTuttiModeSnapshot(
	session Session,
	turnID string,
	cancel context.CancelFunc,
	tuttiModeSnapshot *TuttiModeTurnSnapshot,
) (Session, error) {
	if c == nil {
		return Session{}, fmt.Errorf("agent session controller is unavailable")
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	session.Status = SessionStatusWorking
	session.TurnLifecycle = submittedTurnLifecycle(turnID)
	session.SubmitAvailability = blockedSubmitAvailability("active_turn")
	session.UpdatedAtUnixMS = unixMS(now())
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.turns[key]; ok {
		return Session{}, ErrSessionActiveTurn
	}
	c.sessions[key] = session
	c.turns[key] = activeTurn{
		turnID:            turnID,
		cancel:            cancel,
		tuttiModeSnapshot: cloneTuttiModeTurnSnapshot(tuttiModeSnapshot),
	}
	return session, nil
}

func (c *Controller) rollbackSubmittedTurn(session Session, turnID string) {
	if c == nil {
		return
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	turn, ok := c.turns[key]
	if !ok || strings.TrimSpace(turn.turnID) != strings.TrimSpace(turnID) {
		return
	}
	delete(c.turns, key)
	c.sessions[key] = session
}

func (c *Controller) activeTurnTuttiModeSnapshot(roomID string, agentSessionID string) *TuttiModeTurnSnapshot {
	if c == nil {
		return nil
	}
	key := sessionKey(roomID, agentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	turn, ok := c.turns[key]
	if !ok {
		return nil
	}
	return cloneTuttiModeTurnSnapshot(turn.tuttiModeSnapshot)
}

func (c *Controller) runExecTurn(ctx context.Context, session Session, adapter Adapter, content []PromptContentBlock, displayPrompt string, turnID string) {
	if asyncAdapter, ok := adapter.(AsyncExecAdapter); ok {
		c.runAsyncExecTurn(ctx, session, asyncAdapter, content, displayPrompt, turnID)
		return
	}
	var emitted []activityshared.Event
	var emittedSummary agentSubmitRuntimeEventSummary
	metadata := execMetadataFromContext(ctx)
	logAgentSubmitTrace("runtime.turn_goroutine_started", session, turnID, metadata, nil)
	emit := func(events []activityshared.Event) {
		if len(events) == 0 {
			return
		}
		session = c.foldTurnSessionEvents(session, events, turnID)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		session = c.preserveCurrentSessionSettings(session)
		if !c.storeTurnSession(session, turnID) {
			return
		}
		emitted = append(emitted, events...)
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
		emittedSummary.observe(events, session)
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		c.applyTurnCommandSnapshot(session, turnID, snapshot)
	}
	events, err := adapter.Exec(ctx, session, content, displayPrompt, turnID, emit, emitCommands)
	rootProviderLifecycle := adapterUsesRootProviderTurnLifecycle(adapter)
	shouldEmitTerminalEvents := false
	if err != nil {
		if rootProviderLifecycle && errors.Is(err, context.Canceled) {
			// Provider interruption is a fact emitted by the adapter.
			// Do not fabricate a canonical root terminal here: tuttid owns that
			// transition after child-turn aggregation.
			events = retainTurnCallLifecycleEvents(events, turnID)
		} else if !rootProviderLifecycle && errors.Is(err, context.Canceled) {
			// Keep lifecycle close events Exec already produced (Claude
			// finishing open tools and in-flight thinking/assistant snapshots
			// on ctx cancel). Replacing the whole slice would drop those
			// CallFailed / failed-stream updates and leave tool cards or
			// thinking disclosures stuck in progress after Stop.
			events = append(retainTurnCallLifecycleEvents(events, turnID), newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			}))
		} else if !rootProviderLifecycle {
			events = []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
				"error": err.Error(),
			})}
		}
		shouldEmitTerminalEvents = true
	}
	if err == nil {
		emit(unemittedActivityEvents(events, emitted))
	}
	if shouldEmitTerminalEvents || len(emitted) == 0 {
		emit(events)
	}
	statusEvents := events
	if len(statusEvents) == 0 {
		statusEvents = emitted
	}
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(statusEvents) {
		session = c.foldTurnSessionEvents(session, statusEvents, "")
	} else {
		session = applySessionEvents(session, statusEvents)
		session = applyTurnLifecycleFromEvents(session, statusEvents)
		session.Status = deriveSessionStatusFromEvents(statusEvents, SessionStatusWorking)
	}
	if shouldAdvanceSessionUpdatedAtFromEvents(statusEvents) {
		session.UpdatedAtUnixMS = unixMS(now())
	}
	emittedSummary.log("runtime.events_emitted.summary", session, turnID, metadata)
	if rootProviderLifecycle {
		// Exec returning closes only the provider invocation. The controller's
		// active root turn remains addressable for guidance/cancel until the
		// daemon commits and reconciles canonical root settlement.
		c.storeTurnSession(session, turnID)
		return
	}
	c.finishTurn(session, turnID)
}

func adapterUsesRootProviderTurnLifecycle(adapter Adapter) bool {
	lifecycle, ok := adapter.(RootProviderTurnLifecycleAdapter)
	return ok && lifecycle.UsesRootProviderTurnLifecycle()
}

func (c *Controller) runAsyncExecTurn(ctx context.Context, session Session, adapter AsyncExecAdapter, content []PromptContentBlock, displayPrompt string, turnID string) {
	metadata := execMetadataFromContext(ctx)
	logAgentSubmitTrace("runtime.async_turn_started", session, turnID, metadata, nil)
	var mu sync.Mutex
	finished := false
	var emittedSummary agentSubmitRuntimeEventSummary
	finish := func(next Session) bool {
		if finished {
			return false
		}
		finished = true
		if !c.finishTurn(next, turnID) {
			return false
		}
		emittedSummary.log("runtime.async_events_emitted.summary", next, turnID, metadata)
		return true
	}
	emit := func(events []activityshared.Event) {
		if len(events) == 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		events = c.asyncTurnEventsReadyForFold(session, turnID, events)
		if len(events) == 0 {
			return
		}
		session = c.foldTurnSessionEvents(session, events, turnID)
		if shouldAdvanceSessionUpdatedAtFromEvents(events) {
			session.UpdatedAtUnixMS = unixMS(now())
		}
		session = c.preserveCurrentSessionSettings(session)
		terminal := turnHasTerminalEvent(events, turnID) ||
			turnLifecycleSnapshotSettledTurn(events, turnID) ||
			turnSteeredIntoActiveTurn(events, turnID)
		if terminal {
			// Remove the controller's active-turn record before publishing a
			// terminal/ready session. Consumers must never observe a ready session
			// while HasActiveTurn still reports the finished turn.
			emittedSummary.observe(events, session)
			if !finish(session) {
				return
			}
		} else {
			if !c.storeTurnSession(session, turnID) {
				return
			}
			emittedSummary.observe(events, session)
		}
		c.publish(session, events)
		c.enqueueSessionReport(ctx, session, events)
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		mu.Lock()
		defer mu.Unlock()
		c.applyTurnCommandSnapshot(session, turnID, snapshot)
	}
	if err := adapter.ExecAsync(ctx, session, content, displayPrompt, turnID, emit, emitCommands); err != nil {
		events := []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", map[string]any{
			"error": err.Error(),
		})}
		if errors.Is(err, context.Canceled) {
			events = []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			})}
		}
		emit(events)
	}
}

func (c *Controller) asyncTurnEventsReadyForFold(session Session, turnID string, events []activityshared.Event) []activityshared.Event {
	turnID = strings.TrimSpace(turnID)
	if c == nil || turnID == "" || len(events) == 0 {
		return events
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	turn, ok := c.turns[key]
	if !ok || strings.TrimSpace(turn.turnID) != turnID {
		return nil
	}
	if turn.openCallIDs == nil {
		turn.openCallIDs = make(map[string]struct{})
	}
	for _, event := range events {
		trackAsyncTurnCallEvent(turn.openCallIDs, event, turnID)
	}
	var ready []activityshared.Event
	var terminal []activityshared.Event
	for _, event := range events {
		if asyncEventCompletesTurnSuccessfully(event, turnID) {
			terminal = append(terminal, event)
			continue
		}
		ready = append(ready, event)
	}
	if len(terminal) > 0 && len(turn.openCallIDs) > 0 {
		turn.pendingTerminalEvents = append(turn.pendingTerminalEvents, terminal...)
	} else {
		ready = events
	}
	if len(turn.openCallIDs) == 0 && len(turn.pendingTerminalEvents) > 0 {
		ready = append(ready, turn.pendingTerminalEvents...)
		turn.pendingTerminalEvents = nil
	}
	c.turns[key] = turn
	return ready
}

func trackAsyncTurnCallEvent(openCallIDs map[string]struct{}, event activityshared.Event, turnID string) {
	if len(openCallIDs) == 0 && event.Type != activityshared.EventCallStarted {
		return
	}
	if strings.TrimSpace(event.Payload.TurnID) != turnID {
		return
	}
	callID := asyncTurnCallTrackingID(event)
	if callID == "" {
		return
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		openCallIDs[callID] = struct{}{}
	case activityshared.EventCallCompleted, activityshared.EventCallFailed:
		delete(openCallIDs, callID)
	}
}

func asyncTurnCallTrackingID(event activityshared.Event) string {
	if callID := strings.TrimSpace(event.Payload.CallID); callID != "" {
		return callID
	}
	return strings.TrimSpace(event.EventID)
}

func asyncEventCompletesTurnSuccessfully(event activityshared.Event, turnID string) bool {
	if strings.TrimSpace(event.Payload.TurnID) == turnID && event.Type == activityshared.EventTurnCompleted {
		outcome := strings.TrimSpace(event.Payload.TurnOutcome)
		return outcome == "" || outcome == string(activityshared.TurnOutcomeCompleted)
	}
	snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
	if !ok || strings.TrimSpace(snapshot.Phase) != string(activityshared.TurnPhaseSettled) {
		return false
	}
	outcome := strings.TrimSpace(snapshot.Outcome)
	if outcome != "" && outcome != string(activityshared.TurnOutcomeCompleted) {
		return false
	}
	return strings.TrimSpace(event.Payload.TurnID) == turnID ||
		strings.TrimSpace(snapshot.ActiveTurnID) == turnID
}

func turnHasTerminalEvent(events []activityshared.Event, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	for _, event := range events {
		if turnID != "" && strings.TrimSpace(event.Payload.TurnID) != turnID {
			continue
		}
		switch event.Type {
		case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
			return true
		default:
			if string(event.Type) == EventTurnCanceled {
				return true
			}
		}
	}
	return false
}

func turnLifecycleSnapshotSettledTurn(events []activityshared.Event, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return false
	}
	for _, event := range events {
		snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
		if !ok || strings.TrimSpace(snapshot.Phase) != string(activityshared.TurnPhaseSettled) {
			continue
		}
		if strings.TrimSpace(event.Payload.TurnID) == turnID ||
			strings.TrimSpace(snapshot.ActiveTurnID) == turnID {
			return true
		}
	}
	return false
}

// turnSteeredIntoActiveTurn reports that the adapter steered this submission's
// content into an already-running provider turn (codex turn/steer): the steer
// turn id owns no provider turn, so no terminal event will ever arrive for it
// and the controller record must settle now. The blocking exec path gets this
// for free by calling finishTurn unconditionally after Exec returns.
func turnSteeredIntoActiveTurn(events []activityshared.Event, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return false
	}
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended || strings.TrimSpace(event.Payload.TurnID) != turnID {
			continue
		}
		if steered, ok := event.Payload.Metadata["steered"].(bool); ok && steered {
			return true
		}
	}
	return false
}

func submittedTurnLifecycle(turnID string) *TurnLifecycle {
	activeTurnID := strings.TrimSpace(turnID)
	return &TurnLifecycle{
		ActiveTurnID: &activeTurnID,
		Phase:        "submitted",
	}
}

func execMetadataFromContext(ctx context.Context) map[string]any {
	if ctx == nil {
		return nil
	}
	metadata, _ := ctx.Value(execMetadataContextKey{}).(map[string]any)
	return cloneExecMetadata(metadata)
}

func cloneExecMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			cloned[trimmed] = value
		}
	}
	return cloned
}

func logAgentSubmitTrace(event string, session Session, turnID string, metadata map[string]any, fields map[string]any) {
	clientSubmitID := metadataString(metadata, "clientSubmitId")
	if clientSubmitID == "" {
		return
	}
	args := []any{
		"event", "agent.submit.trace",
		"trace_event", event,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider", session.Provider,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", strings.TrimSpace(turnID),
		"client_submit_id", clientSubmitID,
	}
	if submittedAt := metadataInt64(metadata, "clientSubmittedAtUnixMs"); submittedAt > 0 {
		args = append(args,
			"client_submitted_at_unix_ms", submittedAt,
			"elapsed_since_client_submit_ms", unixMS(now())-submittedAt,
		)
	}
	for key, value := range fields {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			args = append(args, trimmed, value)
		}
	}
	slog.Info("agent submit trace", args...)
}

func metadataString(metadata map[string]any, key string) string {
	if len(metadata) == 0 {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func metadataInt64(metadata map[string]any, key string) int64 {
	if len(metadata) == 0 {
		return 0
	}
	switch value := metadata[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	default:
		return 0
	}
}

func turnLifecyclePhaseFromEvents(events []activityshared.Event) string {
	for _, event := range events {
		if phase := turnLifecyclePhaseFromEvent(event); phase != "" {
			return phase
		}
	}
	return ""
}

func blockedSubmitAvailability(reason string) *SubmitAvailability {
	return &SubmitAvailability{
		State:  "blocked",
		Reason: strings.TrimSpace(reason),
	}
}

func availableSubmitAvailability() *SubmitAvailability {
	return &SubmitAvailability{State: "available"}
}
