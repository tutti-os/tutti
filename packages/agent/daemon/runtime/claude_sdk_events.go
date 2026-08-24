package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) sidecarTurnEvents(adapterSession *claudeSDKAdapterSession, session Session, turnID string, event claudeSDKSidecarEvent) ([]activityshared.Event, bool, error) {
	adapterSession.applySessionPayload(&session, event.Payload)
	eventTurnID := firstNonEmptyString(payloadString(event.Payload, "turnId"), payloadString(event.Payload, "turnID"))
	if eventTurnID != "" && strings.TrimSpace(turnID) != "" && eventTurnID != strings.TrimSpace(turnID) {
		return nil, false, nil
	}
	explicitProviderTurnID := payloadString(event.Payload, "providerTurnId")
	activeProviderTurnID := a.activeClaudeSDKRootProviderTurnID(adapterSession)
	boundProviderTurnID := firstNonEmptyString(
		explicitProviderTurnID,
		activeProviderTurnID,
	)
	// dispatchClaudeSDKEvent may have already consume()'d the only known
	// provider turn id before projection. Synthetic continuations often omit
	// providerTurnId in the payload; fall back to the synthetic turn id so
	// turn_completed can still mint root_provider_turn.completed.
	if boundProviderTurnID == "" &&
		strings.HasPrefix(eventTurnID, "synthetic-") {
		boundProviderTurnID = eventTurnID
	}
	providerTurnID := firstNonEmptyString(
		boundProviderTurnID,
		strings.TrimSpace(turnID),
		eventTurnID,
	)
	a.mu.Lock()
	fenceState := adapterSession.fencedGoalTurns[providerTurnID]
	if turnFenceState := adapterSession.fencedGoalTurns[eventTurnID]; turnFenceState > fenceState {
		fenceState = turnFenceState
	}
	if fenceState != 0 && event.Type == "provider_turn_identity_resolved" && explicitProviderTurnID != "" {
		binding, bound := adapterSession.goalTurnBindings[eventTurnID]
		if bound && (binding.providerTurnID == "" || binding.providerTurnID == explicitProviderTurnID) {
			binding.providerTurnID = explicitProviderTurnID
			adapterSession.goalTurnBindings[eventTurnID] = binding
			adapterSession.fencedGoalTurns[explicitProviderTurnID] = fenceState
			if adapterSession.rootProviderTurns == nil {
				adapterSession.rootProviderTurns = make(map[string]struct{})
			}
			adapterSession.rootProviderTurns[explicitProviderTurnID] = struct{}{}
		}
	}
	terminalEvent := isClaudeSDKTerminalEvent(event.Type)
	fencedPendingGoalUpdateType := ""
	if fenceState != 0 && terminalEvent {
		fencedPendingGoalUpdateType = finishClaudeSDKPendingGoalCommandLocked(
			adapterSession,
			firstNonEmptyString(eventTurnID, strings.TrimSpace(turnID)),
			nil,
			event.Type != "turn_completed",
			true,
		)
		delete(adapterSession.fencedGoalTurns, providerTurnID)
		delete(adapterSession.fencedGoalTurns, eventTurnID)
		delete(adapterSession.goalTurnBindings, eventTurnID)
		delete(adapterSession.rootProviderTurns, providerTurnID)
		delete(adapterSession.rootProviderTurns, eventTurnID)
	}
	a.mu.Unlock()
	if fenceState != 0 && (!terminalEvent || fenceState == claudeSDKGoalTurnFenceSuppress) {
		if fencedPendingGoalUpdateType == "" {
			return nil, terminalEvent, nil
		}
		return a.goalMirrorEvents(session, fencedPendingGoalUpdateType), terminalEvent, nil
	}
	if explicitProviderTurnID != "" &&
		activeProviderTurnID != "" &&
		explicitProviderTurnID != activeProviderTurnID &&
		claudeSDKEventRequiresBoundProviderIdentity(event.Type) {
		return nil, false, errors.New("claude SDK provider turn identity changed after binding")
	}
	goalClearControlTurn := a.isGoalClearControlTurn(adapterSession, providerTurnID) ||
		a.isGoalClearControlTurn(adapterSession, eventTurnID)
	if goalClearControlTurn && isClaudeSDKGoalClearHiddenEvent(event.Type) {
		return nil, false, nil
	}
	if goalClearControlTurn &&
		isClaudeSDKTerminalEvent(event.Type) &&
		event.Type != "goal_command_canceled" {
		events := a.finishClaudeSDKPendingGoalTurn(
			adapterSession,
			session,
			eventTurnID,
			event.Type != "turn_completed",
			true,
		)
		a.forgetGoalClearControlTurn(adapterSession, providerTurnID)
		a.forgetGoalClearControlTurn(adapterSession, eventTurnID)
		return events, true, nil
	}
	rootTurnID := ""
	if event.Type != "provider_turn_identity_resolved" &&
		event.Type != "turn_started" &&
		event.Type != "goal_command_canceled" {
		rootTurnID = a.claudeSDKRootTurnID(adapterSession, providerTurnID)
	}
	if events, handled := claudeSDKSidecarBackgroundTaskEvents(adapterSession, session, event); handled {
		return events, false, nil
	}
	switch event.Type {
	case "ok":
		return nil, false, nil
	case "sdk_lifecycle_observed":
		state, changed := adapterSession.applyRuntimeActivity(event.Payload)
		if !changed {
			return nil, false, nil
		}
		event := newSessionActivityEvent(
			session,
			EventSessionUpdated,
			firstNonEmpty(session.Status, SessionStatusReady),
			claudeSDKRuntimeContext(session, adapterSession),
		)
		event.Payload.RuntimeActivity = activityshared.RuntimeActivityState(state)
		return []activityshared.Event{event}, false, nil
	case "session_state":
		return []activityshared.Event{newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession))}, false, nil
	case "provider_turn_identity_resolved":
		if eventTurnID == "" || explicitProviderTurnID == "" {
			return nil, false, errors.New("claude SDK provider turn identity resolution omitted identity")
		}
		admission, err := a.admitClaudeSDKGoalTurn(adapterSession, eventTurnID, explicitProviderTurnID, event.Payload)
		if err != nil {
			return nil, false, err
		}
		if admission.denied() {
			a.rejectClaudeSDKGoalTurn(adapterSession, session, eventTurnID, explicitProviderTurnID, admission)
			return nil, false, nil
		}
		if admission.goalTurn && !a.publishClaudeSDKGoalTurn(adapterSession, eventTurnID) {
			return nil, false, nil
		}
		a.beginClaudeSDKRootTurn(adapterSession, eventTurnID, explicitProviderTurnID)
		metadata := map[string]any{"adapter": claudeSDKSidecarAdapterName}
		for key, value := range admission.metadata {
			metadata[key] = value
		}
		return []activityshared.Event{a.claudeSDKRootProviderTurnStartedEvent(
			session,
			eventTurnID,
			explicitProviderTurnID,
			metadata,
		)}, false, nil
	case "provider_turn_checkpoint":
		checkpointMessageID := payloadString(
			event.Payload,
			"providerCheckpointMessageId",
		)
		if eventTurnID == "" || boundProviderTurnID == "" || checkpointMessageID == "" {
			return nil, false, errors.New(
				"claude SDK provider turn checkpoint omitted identity",
			)
		}
		return []activityshared.Event{a.claudeSDKRootProviderTurnCheckpointEvent(
			session,
			eventTurnID,
			boundProviderTurnID,
			checkpointMessageID,
		)}, false, nil
	case "turn_started":
		metadata := map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}
		admission, err := a.admitClaudeSDKGoalTurn(adapterSession, eventTurnID, explicitProviderTurnID, event.Payload)
		if err != nil {
			return nil, false, err
		}
		if admission.denied() {
			a.rejectClaudeSDKGoalTurn(adapterSession, session, eventTurnID, providerTurnID, admission)
			return nil, false, nil
		}
		if admission.goalTurn && explicitProviderTurnID == "" {
			return nil, false, nil
		}
		if admission.goalTurn && !a.publishClaudeSDKGoalTurn(adapterSession, eventTurnID) {
			return nil, false, nil
		}
		if !admission.goalTurn {
			providerTurnID = firstNonEmptyString(explicitProviderTurnID, strings.TrimSpace(turnID), eventTurnID)
		}
		for key, value := range admission.metadata {
			metadata[key] = value
		}
		if admission.goalTurn {
			// Goal control does not pre-allocate a canonical Turn. The provider's
			// first identity/start fact starts a fresh root mapping instead of
			// inheriting the preceding user Turn from this long-lived SDK session.
			rootTurnID = firstNonEmptyString(eventTurnID, strings.TrimSpace(turnID), providerTurnID)
			a.beginClaudeSDKRootTurn(adapterSession, rootTurnID, providerTurnID)
		} else {
			rootTurnID = a.claudeSDKRootTurnID(adapterSession, providerTurnID)
			a.rememberClaudeSDKRootProviderTurn(adapterSession, providerTurnID)
		}
		if payloadBoolValue(event.Payload, "synthetic") {
			metadata["synthetic"] = true
		}
		return []activityshared.Event{a.claudeSDKRootProviderTurnStartedEvent(
			session,
			rootTurnID,
			providerTurnID,
			metadata,
		)}, false, nil
	case "goal_command_started":
		a.markClaudeSDKPendingGoalCommandStarted(adapterSession, event)
		metadata := map[string]any{
			"operationId":      payloadString(event.Payload, "operationId"),
			"revision":         payloadInt64(event.Payload, "revision"),
			"repairEpoch":      payloadInt64(event.Payload, "repairEpoch"),
			"action":           payloadString(event.Payload, "action"),
			"providerTurnId":   firstNonEmptyString(payloadString(event.Payload, "providerTurnId"), turnID),
			"goal":             a.localGoal(adapterSession),
			"executionPending": payloadString(event.Payload, "action") == string(GoalControlSet),
		}
		events := make([]activityshared.Event, 0, 2)
		if ctx, ok := activityEventContext(session, newID(), ""); ok {
			events = append(events, activityshared.NewGoalControlApplied(ctx, metadata))
		}
		events = append(events, newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession)))
		return events, false, nil
	case "goal_command_superseded":
		return a.finishClaudeSDKPendingGoalTurn(
			adapterSession,
			session,
			eventTurnID,
			true,
			true,
		), true, nil
	case "goal_command_canceled":
		events := a.finishClaudeSDKPendingGoalCommand(adapterSession, session, event)
		a.forgetGoalClearControlTurn(adapterSession, eventTurnID)
		a.forgetClaudeSDKGoalTurnBinding(adapterSession, eventTurnID)
		return events, true, nil
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
		if boundProviderTurnID == "" {
			return nil, false, errors.New(
				"claude SDK interaction omitted bound provider turn identity",
			)
		}
		events, err := a.claudeSDKInteractiveRequested(
			adapterSession,
			session,
			rootTurnID,
			boundProviderTurnID,
			event.Payload,
		)
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
		markClaudeSDKContextHandoffRequired(&compact, event.Payload)
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
	case "guidance_interrupted":
		return a.finishClaudeSDKGuidanceResponse(adapterSession, session, rootTurnID, eventTurnID, strings.TrimSpace(turnID))
	case "tool_started":
		if a.claudeSDKToolEventTargetsClosedTurn(adapterSession, rootTurnID, event.Payload) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, rootTurnID, event.Payload, EventCallStarted, messageStreamStateStreaming, event.Type)
		events = a.projectClaudeSDKTurnCallEvents(adapterSession, events)
		return events, false, nil
	case "tool_updated":
		if a.claudeSDKToolEventTargetsClosedTurn(adapterSession, rootTurnID, event.Payload) {
			return nil, false, nil
		}
		events := adapterSession.claudeSDKToolEvents(session, rootTurnID, event.Payload, EventCallStarted, messageStreamStateStreaming, event.Type)
		events = a.projectClaudeSDKTurnCallEvents(adapterSession, events)
		for index := range events {
			if events[index].Type != activityshared.EventCallStarted {
				continue
			}
			markClaudeSDKToolProgressUpdate(&events[index])
		}
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
	case "task_result_updated":
		return adapterSession.claudeSDKTaskResultUpdatedEvents(session, event.Payload), false, nil
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
			if event, ok := normalizedUsageUpdatedEvent(
				session,
				claudeSDKRuntimeContext(session, adapterSession),
			); ok {
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
	case "goal_observed":
		updateType := a.applyClaudeSDKGoalObservation(adapterSession, event.Payload)
		if updateType == "" {
			return nil, false, nil
		}
		a.finishClaudeSDKPendingGoalTurn(
			adapterSession,
			session,
			eventTurnID,
			false,
			false,
		)
		events := make([]activityshared.Event, 0, 2)
		if goalEvent, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
			events = append(events, goalEvent)
		}
		events = append(events, newSessionActivityEvent(session, EventSessionUpdated, firstNonEmpty(session.Status, SessionStatusReady), claudeSDKRuntimeContext(session, adapterSession)))
		return events, false, nil
	case "turn_completed":
		if boundProviderTurnID == "" {
			return nil, false, errors.New("claude SDK provider turn completion omitted identity")
		}
		a.finishClaudeSDKPendingGoalTurn(adapterSession, session, eventTurnID, false, true)
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishCompleted, "")
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, boundProviderTurnID, activityshared.TurnOutcomeCompleted, map[string]any{
			"adapter":    claudeSDKSidecarAdapterName,
			"stopReason": firstNonEmpty(payloadString(event.Payload, "stopReason"), "end_turn"),
		}))
		a.forgetClaudeSDKGoalTurnBinding(adapterSession, eventTurnID)
		return events, true, nil
	case "turn_canceled":
		goalEvents := a.finishClaudeSDKPendingGoalTurn(adapterSession, session, eventTurnID, true, true)
		if boundProviderTurnID == "" {
			events := a.finishClaudeSDKTurnLifecycle(
				adapterSession,
				session,
				rootTurnID,
				claudeSDKTurnFinishInterrupted,
				"interrupted_before_provider_acceptance",
			)
			return append(events, goalEvents...), true, nil
		}
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishInterrupted, "interrupted")
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, boundProviderTurnID, activityshared.TurnOutcomeCanceled, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))
		if len(goalEvents) > 0 {
			events = append(events, goalEvents...)
		} else {
			events = append(events, a.goalEventsOnArmTurnFailed(adapterSession, session, firstNonEmptyString(eventTurnID, strings.TrimSpace(turnID), providerTurnID))...)
		}
		a.forgetClaudeSDKGoalTurnBinding(adapterSession, eventTurnID)
		return events, true, nil
	case "turn_failed":
		goalEvents := a.finishClaudeSDKPendingGoalTurn(adapterSession, session, eventTurnID, true, true)
		if boundProviderTurnID == "" {
			events := a.finishClaudeSDKTurnLifecycle(
				adapterSession,
				session,
				rootTurnID,
				claudeSDKTurnFinishFailed,
				"failed_before_provider_acceptance",
			)
			rejected := strings.EqualFold(
				strings.TrimSpace(payloadString(event.Payload, "dispatchDisposition")),
				string(DispatchDispositionRejected),
			)
			events = ensureClaudeSDKPreAcceptanceFailureEvent(
				events, session, rootTurnID, event.Payload, rejected,
			)
			events = append(events, goalEvents...)
			if rejected {
				return events, true, newClaudeSDKProviderRejectedError(session, event.Payload)
			}
			return events, true, nil
		}
		events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, rootTurnID, claudeSDKTurnFinishFailed, "turn_failed")
		failureMetadata := claudeProviderFailure(event.Payload).metadata()
		failureMetadata["adapter"] = claudeSDKSidecarAdapterName
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(session, rootTurnID, boundProviderTurnID, activityshared.TurnOutcomeFailed, failureMetadata))
		if len(goalEvents) > 0 {
			events = append(events, goalEvents...)
		} else {
			events = append(events, a.goalEventsOnArmTurnFailed(adapterSession, session, firstNonEmptyString(eventTurnID, strings.TrimSpace(turnID), providerTurnID))...)
		}
		a.forgetClaudeSDKGoalTurnBinding(adapterSession, eventTurnID)
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
		if err := a.dispatchClaudeSDKEvent(
			agentSessionID,
			adapterSession,
			event,
		); err != nil {
			a.failClaudeSDKReader(agentSessionID, adapterSession, err)
			return
		}
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
	args = append(args, claudeSDKLifecycleLogArgs(payload)...)
	slog.Log(
		context.Background(),
		claudeSDKLifecycleEventLogLevel(event.Type),
		"agent session Claude SDK lifecycle event",
		args...,
	)
}

func claudeSDKLifecycleEventDiagnostic(event claudeSDKSidecarEvent) bool {
	switch strings.TrimSpace(event.Type) {
	case "sdk_lifecycle_observed",
		"provider_turn_identity_resolved", "provider_turn_checkpoint",
		"goal_observed", "goal_command_canceled",
		"approval_requested", "user_input_requested",
		"turn_started", "turn_completed", "turn_canceled", "turn_failed",
		"continuation_delayed",
		"background_tasks_changed", "background_tasks_quiesced",
		"task_started", "task_progress", "task_completed":
		return true
	case "tool_started", "tool_completed", "tool_failed":
		return strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Agent") ||
			strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Task")
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
	a.failClaudeSDKReaderWithOwnership(agentSessionID, adapterSession, err, false)
}

func (a *ClaudeCodeSDKAdapter) failClaudeSDKReaderWithOwnership(
	agentSessionID string,
	adapterSession *claudeSDKAdapterSession,
	err error,
	retainSession bool,
) {
	if a == nil || adapterSession == nil {
		return
	}
	// Reader failure and replacement share the exact-session commit axis.
	// Whichever owns dispatchMu first fully commits; the other observes that
	// generation boundary instead of publishing a mixed old/new timeline.
	adapterSession.dispatchMu.Lock()
	defer adapterSession.dispatchMu.Unlock()
	a.mu.Lock()
	ownsCurrentSession := a.sessions[agentSessionID] == adapterSession
	adapterSession.invalid = true
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
	// Converge every provider-owned lifecycle through the session sink before
	// releasing Exec/round-trip waiters. Those waiters can return stale local
	// lifecycle snapshots; if they win this race, the controller can reject
	// their whole batch and lose the only provider terminal event.
	//
	// Any interactive/permission request still awaiting a human decision must
	// also be resolved explicitly. Otherwise the pending approval bookkeeping
	// is discarded silently with the session and the GUI is left without a
	// terminal explanation.
	var pendingFailureEvents []activityshared.Event
	if ownsCurrentSession {
		session := a.claudeSDKSessionSnapshot(adapterSession)
		if strings.TrimSpace(session.AgentSessionID) == "" {
			session.AgentSessionID = agentSessionID
		}
		pendingFailureEvents = a.claudeSDKPendingRequestFailureEvents(adapterSession, session, "", err)
		pendingFailureEvents = append(pendingFailureEvents, a.finishAllClaudeSDKTurnLifecycles(
			adapterSession,
			session,
			claudeSDKTurnFinishFailed,
			err.Error(),
		)...)
		pendingFailureEvents = append(
			pendingFailureEvents,
			a.failAllClaudeSDKRootProviderTurns(adapterSession, session, err)...,
		)
	}
	if !retainSession {
		a.mu.Lock()
		if a.sessions[agentSessionID] == adapterSession {
			delete(a.sessions, agentSessionID)
		}
		a.mu.Unlock()
	}
	if ownsCurrentSession {
		a.emitClaudeSDKSessionEvents(agentSessionID, pendingFailureEvents)
	}
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
}
