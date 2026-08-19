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
	c.runBlockingExecTurn(ctx, session, adapter, turnID, func(
		emit EventSink,
		emitCommands CommandSnapshotSink,
	) ([]activityshared.Event, error) {
		return adapter.Exec(ctx, session, content, displayPrompt, turnID, emit, emitCommands)
	})
}

func (c *Controller) runProviderAcceptanceTurn(
	ctx context.Context,
	session Session,
	adapter ProviderAcceptanceExecAdapter,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	reportDispatch ProviderDispatchSink,
	acceptProviderTurn ProviderAcceptanceBarrier,
) {
	var reportedDispatch ProviderDispatchResult
	reported := false
	report := func(dispatch ProviderDispatchResult) {
		if !reported {
			reportedDispatch = dispatch
			reported = true
		}
		if reportDispatch != nil {
			reportDispatch(dispatch)
		}
	}
	c.runBlockingExecTurn(ctx, session, adapter, turnID, func(
		emit EventSink,
		emitCommands CommandSnapshotSink,
	) ([]activityshared.Event, error) {
		events, err := adapter.ExecWithProviderAcceptance(
			ctx,
			session,
			content,
			displayPrompt,
			turnID,
			emit,
			emitCommands,
			report,
			acceptProviderTurn,
		)
		if reportedDispatch.Disposition == DispatchDispositionRejected &&
			!eventsContainExplicitDispatchRejection(events) {
			metadata := map[string]any{
				"dispatchDisposition": string(DispatchDispositionRejected),
			}
			if reportedDispatch.Failure != nil {
				metadata["error"] = reportedDispatch.Failure.Error()
			}
			events = append(events, newTurnActivityEvent(
				session,
				EventTurnFailed,
				turnID,
				SessionStatusFailed,
				"",
				"",
				metadata,
			))
		}
		if !reported && reportDispatch != nil {
			// Durable submit already happened. Cancel may settle the adapter
			// (turn_canceled) before Controller cancels runCtx, so err/ctx may
			// not look canceled yet. Any exit without Applied/Rejected still
			// means provider Turn identity never bound — report
			// applied-without-provider-turn so Host does not poison delivery.
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionAppliedWithoutProviderTurn,
			})
		}
		return events, err
	})
}

func eventsContainExplicitDispatchRejection(events []activityshared.Event) bool {
	for _, event := range events {
		if event.Type != activityshared.EventTurnFailed {
			continue
		}
		if strings.EqualFold(
			strings.TrimSpace(payloadString(event.Payload.Metadata, "dispatchDisposition")),
			string(DispatchDispositionRejected),
		) {
			return true
		}
	}
	return false
}

func (c *Controller) runHistoryReplacementTurn(
	ctx context.Context,
	session Session,
	adapter EffectiveHistoryAdapter,
	input HistoryReplacementExecInput,
	reportDispatch ProviderDispatchSink,
) {
	c.runBlockingExecTurn(ctx, session, adapter, input.TurnID, func(
		emit EventSink,
		emitCommands CommandSnapshotSink,
	) ([]activityshared.Event, error) {
		events, err := adapter.ExecHistoryReplacement(
			ctx,
			session,
			input,
			emit,
			emitCommands,
			reportDispatch,
		)
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionOutcomeUnknown,
			})
		}
		return events, err
	})
}

func (c *Controller) runBlockingExecTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	turnID string,
	exec func(EventSink, CommandSnapshotSink) ([]activityshared.Event, error),
) {
	var emitted []activityshared.Event
	var emittedSummary agentSubmitRuntimeEventSummary
	directCanonicalTerminalCommitted := false
	var pendingTerminalCommit *pendingCanonicalTerminalCommit
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
		accepted, ok := c.storeTurnSession(session, turnID)
		if !ok {
			return
		}
		// Publish and report the accepted snapshot, never the stale exec copy:
		// the controller's current session is the only accepted state. Terminal
		// facts cross a stronger commit-before-publish barrier because consumers
		// validate them against the canonical Store immediately on receipt.
		session = accepted
		emitted = append(emitted, events...)
		if eventsRequireDurablePublish(events) {
			durableEvents := events
			if pendingTerminalCommit != nil {
				pendingTerminalCommit.merge(session, events)
				durableEvents = pendingTerminalCommit.events
			}
			if err := c.reportSessionBeforePublish(ctx, session, durableEvents); err != nil {
				if pendingTerminalCommit == nil {
					pendingTerminalCommit = &pendingCanonicalTerminalCommit{}
					pendingTerminalCommit.merge(session, events)
				}
				slog.Error(
					"agent session terminal activity report failed before publish",
					"event", "agent_session.activity_report.terminal_barrier_failed",
					"room_id", session.RoomID,
					"agent_session_id", session.AgentSessionID,
					"turn_id", strings.TrimSpace(turnID),
					"error", err,
				)
				return
			}
			pendingTerminalCommit = nil
			if classifyRootTurnCompletion(turnID, durableEvents) == rootTurnCompletionDirectCanonical {
				directCanonicalTerminalCommitted = true
			}
			if !c.isProvisionalSession(session) {
				c.publish(session, durableEvents)
			}
			emittedSummary.observe(durableEvents, session)
			return
		}
		if !c.isProvisionalSession(session) {
			c.publish(session, events)
		}
		c.enqueueSessionReport(ctx, session, events)
		emittedSummary.observe(events, session)
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		c.applyTurnCommandSnapshot(session, turnID, snapshot)
	}
	events, err := exec(emit, emitCommands)
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
	if err == nil || shouldEmitTerminalEvents || len(emitted) == 0 {
		// Adapters may both invoke emit and return the same terminal batch.
		// Re-entering the durable barrier for already-observed events can make
		// one failed attempt look like an immediate retry and publish twice.
		emit(unemittedActivityEvents(events, emitted))
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
	if pendingTerminalCommit != nil {
		directCanonicalTerminalCommitted = c.convergeCanonicalTerminalCommit(
			ctx,
			turnID,
			pendingTerminalCommit,
		) || directCanonicalTerminalCommitted
	}
	emittedSummary.log("runtime.events_emitted.summary", session, turnID, metadata)
	c.finalizeBlockingExecTurn(
		session,
		turnID,
		rootProviderLifecycle,
		directCanonicalTerminalCommitted,
	)
}

func (c *Controller) isProvisionalSession(session Session) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.provisionalSessions[sessionKey(session.RoomID, session.AgentSessionID)]
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
	finish := func(next Session) (Session, bool) {
		if finished {
			return Session{}, false
		}
		finished = true
		accepted, ok := c.finishTurn(next, turnID)
		if !ok {
			return Session{}, false
		}
		emittedSummary.log("runtime.async_events_emitted.summary", accepted, turnID, metadata)
		return accepted, true
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
			turnSteeredIntoActiveTurn(events, turnID) ||
			sideConversationProviderTurnSettled(session, events, turnID)
		var accepted Session
		var ok bool
		if terminal {
			// Remove the controller's active-turn record before publishing a
			// terminal/ready session. Consumers must never observe a ready session
			// while HasActiveTurn still reports the finished turn.
			emittedSummary.observe(events, session)
			accepted, ok = finish(session)
		} else {
			accepted, ok = c.storeTurnSession(session, turnID)
		}
		if !ok {
			return
		}
		// Publish and report the accepted snapshot, never the stale exec copy:
		// the controller's current session is the only accepted state. Terminal
		// facts must be committed before their stream projection is visible.
		session = accepted
		if !terminal {
			emittedSummary.observe(events, session)
		}
		if eventsRequireDurablePublish(events) {
			if err := c.reportSessionBeforePublish(ctx, session, events); err != nil {
				slog.Error(
					"agent session terminal activity report failed before publish",
					"event", "agent_session.activity_report.terminal_barrier_failed",
					"room_id", session.RoomID,
					"agent_session_id", session.AgentSessionID,
					"turn_id", strings.TrimSpace(turnID),
					"error", err,
				)
				return
			}
		}
		c.publish(session, events)
		if !eventsRequireDurablePublish(events) {
			c.enqueueSessionReport(ctx, session, events)
		}
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

func sideConversationProviderTurnSettled(
	session Session,
	events []activityshared.Event,
	turnID string,
) bool {
	if !session.IsSideConversation() {
		return false
	}
	turnID = strings.TrimSpace(turnID)
	for _, event := range events {
		if event.Type == activityshared.EventRootProviderTurnCompleted &&
			strings.TrimSpace(event.Payload.TurnID) == turnID {
			return true
		}
	}
	return false
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

func eventsRequireDurablePublish(events []activityshared.Event) bool {
	for _, event := range events {
		switch event.Type {
		case activityshared.EventSessionCompleted,
			activityshared.EventSessionFailed,
			activityshared.EventTurnCompleted,
			activityshared.EventTurnFailed,
			activityshared.EventTurnCanceled,
			activityshared.EventRootProviderTurnCompleted:
			return true
		}
		if snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event); ok &&
			strings.TrimSpace(snapshot.Phase) == string(activityshared.TurnPhaseSettled) {
			return true
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
