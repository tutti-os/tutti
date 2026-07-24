package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) steerActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	content []PromptContentBlock,
	providerContent []PromptContentBlock,
	explicitDisplayPrompt string,
	displayPrompt string,
	turnID string,
	activeTurnID string,
	emit EventSink,
) ([]activityshared.Event, error) {
	timeout := a.turnSteerTimeout
	if timeout <= 0 {
		timeout = defaultCodexAppServerTurnSteerTimeout
	}
	_, err := appSession.client.TurnSteerNoHandler(ctx, timeout, map[string]any{
		"threadId":       appSession.threadID,
		"expectedTurnId": activeTurnID,
		"input":          appServerUserInput(providerContent),
	})
	if err != nil {
		return nil, err
	}
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, displayPrompt, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"guidance": true,
			"steered":  true,
		}))),
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

// GoalControl performs a direct goal action from the GUI without going
// through the prompt pipeline: no user message, no turn, no transcript entry
// — only the goal RPC plus a goal-updated session event so the banner
// refreshes, matching the codex desktop goal bar's in-place controls.
func (*CodexAppServerAdapter) GoalCapabilities() GoalAdapterCapabilities {
	return GoalAdapterCapabilities{
		QuerySupported: true, ClearSupported: true, PauseSupported: true,
		QuiesceGoalTurns: true, ReplaySetAfterRestart: true,
	}
}

func (a *CodexAppServerAdapter) ApplyGoal(
	ctx context.Context,
	session Session,
	input GoalApplyInput,
) (GoalAdapterResult, error) {
	action := input.Action
	objective := input.Objective
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	appSession.goalMutationMu.Lock()
	defer appSession.goalMutationMu.Unlock()
	session.ProviderSessionID = appSession.threadID
	method := appServerMethodThreadGoalSet
	params := map[string]any{"threadId": appSession.threadID}
	switch action {
	case GoalControlPause:
		params["status"] = "paused"
	case GoalControlResume:
		params["status"] = "active"
	case GoalControlClear:
		method = appServerMethodThreadGoalClear
	case GoalControlSet:
		objective = strings.TrimSpace(objective)
		if objective == "" {
			return GoalAdapterResult{}, fmt.Errorf("goal objective is required")
		}
		params["objective"] = objective
		params["status"] = "active"
	default:
		return GoalAdapterResult{}, fmt.Errorf("unsupported goal control action %q", action)
	}
	previousOperationID, previousRevision, previousRepairEpoch := a.replaceGoalOperationIdentity(session.AgentSessionID, input.OperationID, input.Revision, input.RepairEpoch)
	expectedIdentity := goalOperationIdentity{
		operationID: strings.TrimSpace(input.OperationID),
		revision:    input.Revision,
		repairEpoch: input.RepairEpoch,
	}
	if action == GoalControlSet || action == GoalControlResume {
		a.prepareGoalContinuationClaim(session.AgentSessionID, expectedIdentity)
		defer a.clearPreparedGoalContinuationClaim(session.AgentSessionID, expectedIdentity)
	}
	slog.Info("agent session app-server goal control",
		"event", "agent_session.app_server.goal.control",
		"agent_session_id", session.AgentSessionID,
		"action", string(action),
	)
	result, err := appSession.callGoalNoHandler(ctx, method, params)
	if err != nil {
		a.restoreGoalOperationIdentity(session.AgentSessionID, input.OperationID, input.Revision, input.RepairEpoch, previousOperationID, previousRevision, previousRepairEpoch)
		return GoalAdapterResult{}, err
	}
	goalUpdateType := "thread_goal_update"
	var goal map[string]any
	if method == appServerMethodThreadGoalClear {
		a.applyGoalClear(session.AgentSessionID)
		goalUpdateType = "thread_goal_cleared"
	} else {
		goal = appServerGoalFromResult(result)
		if len(goal) > 0 {
			if bindErr := a.bindGoalGeneration(ctx, session, goal, expectedIdentity); bindErr != nil {
				return GoalAdapterResult{}, fmt.Errorf("persist goal provenance: %w", bindErr)
			}
			a.applyGoalUpdate(session.AgentSessionID, goal)
		} else if action == GoalControlSet && expectedIdentity.valid() {
			err := errors.New("provider returned no Goal generation for durable Goal set")
			a.failGoalProvenanceSession(session, err)
			return GoalAdapterResult{}, err
		} else if action == GoalControlPause || action == GoalControlResume {
			// Status-only set may return an empty goal payload; mirror the
			// change locally so the banner and the reducer's paused-goal
			// defense stay correct.
			if goal = a.sessionGoal(session.AgentSessionID); len(goal) > 0 {
				if action == GoalControlPause {
					goal["status"] = "paused"
				} else {
					goal["status"] = "active"
				}
				a.applyGoalUpdate(session.AgentSessionID, goal)
			}
		}
	}
	if (action == GoalControlSet || action == GoalControlResume) && len(goal) > 0 {
		a.armGoalContinuationClaim(session.AgentSessionID, expectedIdentity)
	}
	var events []activityshared.Event
	if event, ok := normalizedGoalUpdatedEvent(session, goalUpdateType); ok {
		events = append(events, event)
	}
	if action == GoalControlResume || action == GoalControlSet {
		// Codex normally starts the next goal turn itself after the goal
		// becomes active again; the nudge covers the case where it does not.
		a.scheduleGoalContinuationNudge(session)
	}
	observation := a.sessionGoal(session.AgentSessionID)
	return GoalAdapterResult{
		Events: events, Observation: observation,
		Evidence:      map[string]any{"source": "codex_goal_rpc", "confidence": "authoritative", "repairEpoch": input.RepairEpoch},
		ProviderPhase: "applied",
	}, nil
}

// GoalControl is retained as an adapter-level compatibility shim for focused
// provider tests; controller consumers use the semantic ApplyGoal contract.
func (a *CodexAppServerAdapter) GoalControl(ctx context.Context, session Session, action GoalControlAction, objective string) ([]activityshared.Event, map[string]any, error) {
	result, err := a.ApplyGoal(ctx, session, GoalApplyInput{Action: action, Objective: objective})
	return result.Events, result.Observation, err
}

func (a *CodexAppServerAdapter) ReconcileGoal(ctx context.Context, session Session) (GoalAdapterResult, error) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	appSession.goalMutationMu.Lock()
	defer appSession.goalMutationMu.Unlock()
	result, err := appSession.callGoalNoHandler(ctx, appServerMethodThreadGoalGet, map[string]any{"threadId": appSession.threadID})
	if err != nil {
		return GoalAdapterResult{}, err
	}
	goal := appServerGoalFromResult(result)
	updateType := "thread_goal_update"
	if len(goal) == 0 {
		a.applyGoalClear(session.AgentSessionID)
		updateType = "thread_goal_cleared"
	} else {
		a.applyGoalUpdate(session.AgentSessionID, goal)
	}
	events := []activityshared.Event{}
	if event, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
		events = append(events, event)
	}
	return GoalAdapterResult{Events: events, Observation: goal, Evidence: map[string]any{
		"source": "codex_goal_get", "confidence": "authoritative",
	}}, nil
}

func (*CodexAppServerAdapter) NormalizeGoalObservation(raw map[string]any) map[string]any {
	return normalizedCodexGoal(raw)
}

// normalizedCodexGoal translates provider-specific app-server fields into the
// canonical Tutti SessionGoal contract. Provider payloads use seconds and
// tokensUsed; the durable/public model uses milliseconds and tokens.
func normalizedCodexGoal(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	goal := map[string]any{}
	if objective := strings.TrimSpace(asStringRaw(raw["objective"])); objective != "" {
		goal["objective"] = objective
	}
	status := appServerGoalStatus(asString(raw["status"]))
	if status == "" {
		status = strings.TrimSpace(asString(raw["status"]))
	}
	if status != "" {
		goal["status"] = status
	}
	if reason := strings.TrimSpace(asStringRaw(raw["reason"])); reason != "" {
		goal["reason"] = reason
	}
	if iterations, ok := int64Value(raw["iterations"]); ok && iterations >= 0 {
		goal["iterations"] = iterations
	}
	if durationMS, ok := int64Value(raw["durationMs"]); ok && durationMS >= 0 {
		goal["durationMs"] = durationMS
	} else if timeUsedSeconds, ok := int64Value(raw["timeUsedSeconds"]); ok && timeUsedSeconds >= 0 {
		goal["durationMs"] = timeUsedSeconds * int64(time.Second/time.Millisecond)
	}
	if tokens, ok := int64Value(raw["tokens"]); ok && tokens >= 0 {
		goal["tokens"] = tokens
	} else if tokensUsed, ok := int64Value(raw["tokensUsed"]); ok && tokensUsed >= 0 {
		goal["tokens"] = tokensUsed
	}
	return goal
}

// ExecGoalControl executes a /goal control command as a thread-level
// operation without opening a turn. The controller routes here when another
// turn already holds the session's turn slot, so the goal banner's
// pause/resume/delete act immediately instead of being rejected by the
// single-turn gate. handled is false when the prompt is not a /goal command.
func (a *CodexAppServerAdapter) ExecGoalControl(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
) ([]activityshared.Event, bool, error) {
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	command, args := splitSlashCommand(visibleText)
	if command != appServerSlashGoal {
		return nil, false, nil
	}
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, true, ErrSessionDisconnected
	}
	session.ProviderSessionID = appSession.threadID
	events, err := a.execGoalControlCommand(ctx, appSession, session, args, "", content, explicitDisplayPrompt, visibleText, nil)
	return events, true, err
}

// execGoalControlCommand executes /goal while another turn is running. The
// goal RPC runs against the thread (not a turn); the submission is recorded
// as a session-level audit message. A /goal with a new objective can update
// the goal while another turn is active; continuation turns are adopted only
// when the provider actually starts them.
func (a *CodexAppServerAdapter) execGoalControlCommand(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	args string,
	turnID string,
	content []PromptContentBlock,
	explicitDisplayPrompt string,
	displayPrompt string,
	emit EventSink,
) ([]activityshared.Event, error) {
	method, params := appServerGoalSlashRequest(args, appSession.threadID)
	// NoHandler: the active turn keeps streaming while this control RPC runs;
	// claiming the handler slot would swallow its notifications.
	result, err := appSession.callGoalNoHandler(ctx, method, params)
	events := []activityshared.Event{
		newSessionAuditEventWithID(session, newID(), RoleUser, displayPrompt, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"goalControl": true,
		}))),
	}
	if err != nil {
		if strings.TrimSpace(turnID) != "" {
			events = append(events, appServerSystemNoticeEvent(session, turnID, "warning", "Goal command failed.", err.Error()))
		}
		if emit != nil {
			emit(events)
		}
		return events, nil
	}
	goalUpdateType := "thread_goal_update"
	if method == appServerMethodThreadGoalClear {
		a.applyGoalClear(session.AgentSessionID)
		goalUpdateType = "thread_goal_cleared"
	} else if goal := appServerGoalFromResult(result); len(goal) > 0 {
		a.applyGoalUpdate(session.AgentSessionID, goal)
	}
	if event, ok := normalizedGoalUpdatedEvent(session, goalUpdateType); ok {
		events = append(events, event)
	}
	if notice := appServerGoalNoticeEvent(session, turnID, method, result); notice != nil && strings.TrimSpace(turnID) != "" {
		events = append(events, *notice)
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (a *CodexAppServerAdapter) execSlashCommand(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	displayPrompt string,
	turnID string,
	appTurn *codexAppServerActiveTurn,
	normalizer *acpTurnNormalizer,
	emitEvents func([]activityshared.Event),
	emitTerminal func([]activityshared.Event),
	emitCommands CommandSnapshotSink,
) (bool, error) {
	command, args := splitSlashCommand(displayPrompt)
	switch command {
	case appServerSlashCompact:
		a.transitionActiveTurnPhase(session.AgentSessionID, appTurn, codexAppServerTurnPhaseCompacting)
		// Emit the "Compacting context." banner up front instead of waiting for
		// the server's contextCompaction item/started notification: Codex
		// app-server frequently finishes thread/compact/start without ever
		// streaming that notification, which used to leave the whole operation
		// invisible until (if ever) an item/completed notice arrived. Tracking
		// the messageId now means a later item/started reuses this same row
		// (see appServerItemEvents) instead of appending a duplicate, and an
		// immediate RPC failure or an interrupted/failed turn always has a
		// pending banner to settle in place.
		startMessageID := "compaction:" + turnID
		startMessageID, _ = normalizer.StartCompactionNotice(startMessageID)
		emitEvents([]activityshared.Event{appServerCompactionNoticeEvent(session, turnID, startMessageID, "running")})
		_, err := appSession.client.ThreadCompactStart(ctx, map[string]any{
			"threadId": appSession.threadID,
		}, a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal(append(
				normalizer.settlePendingCompactionEvents(session, turnID, "failed"),
				newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)),
			))
			return true, nil
		}
		// Block until the App Server signals turn/completed. The session-level
		// handler keeps activeTurn alive during this wait, so the
		// contextCompaction item/completed notification fires appServerItemEvents
		// and emits the "Context compacted." banner through emitEvents before we
		// close the turn.
		_, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, nil)
		if finishErr != nil {
			if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
				emitTerminal(append(
					normalizer.FinishInterrupted(session, turnID, "interrupted"),
					newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
						"error": finishErr.Error(),
					}),
				))
			} else {
				emitTerminal(append(
					normalizer.FinishFailed(session, turnID),
					newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)),
				))
			}
			return true, nil
		}
		emitTerminal(append(
			normalizer.FinishCompleted(session, turnID),
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason":             "end_turn",
				"completedCommandKind":   "compact",
				"completedCommandStatus": "completed",
			}),
		))
		return true, nil
	case appServerSlashGoal:
		method, params := appServerGoalSlashRequest(args, appSession.threadID)
		goalObjective := strings.TrimSpace(asString(params["objective"]))
		goalDrivesTurn := method == appServerMethodThreadGoalSet && goalObjective != ""
		expectedGoalIdentity := goalOperationIdentity{}
		var previousGoal map[string]any
		if goalDrivesTurn {
			expectedGoalIdentity = a.goalOperationIdentity(session.AgentSessionID)
			// Mark before the RPC: the server may start (and even settle) the
			// goal's first turn while thread/goal/set is still in flight, and
			// the settle path only emits terminal events for marked turns. The
			// same ordering requires the local goal to be active before the RPC:
			// finalizeSettledTurn schedules continuation from that state.
			previousGoal = a.sessionGoal(session.AgentSessionID)
			pendingGoal := clonePayload(previousGoal)
			if pendingGoal == nil {
				pendingGoal = map[string]any{}
			}
			pendingGoal["objective"] = goalObjective
			pendingGoal["status"] = "active"
			a.applyGoalUpdate(session.AgentSessionID, pendingGoal)
			a.markTurnSettleEmits(appTurn)
			go a.watchTurnExternalTermination(appSession, appTurn)
		}
		result, err := appSession.callGoal(ctx, method, params,
			a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			if goalDrivesTurn {
				if len(previousGoal) > 0 {
					a.applyGoalUpdate(session.AgentSessionID, previousGoal)
				} else {
					a.applyGoalClear(session.AgentSessionID)
				}
			}
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		if method == appServerMethodThreadGoalClear {
			a.applyGoalClear(session.AgentSessionID)
			if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_cleared"); ok {
				emitEvents([]activityshared.Event{event})
			}
		} else if goal := appServerGoalFromResult(result); len(goal) > 0 {
			if current := a.goalOperationIdentity(session.AgentSessionID); current == expectedGoalIdentity {
				if bindErr := a.bindGoalGeneration(ctx, session, goal, expectedGoalIdentity); bindErr != nil {
					emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(bindErr))})
					return true, nil
				}
			}
			a.applyGoalUpdate(session.AgentSessionID, goal)
			if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_update"); ok {
				emitEvents([]activityshared.Event{event})
			}
		}
		if goalDrivesTurn {
			// The settle path (notification loop) owns terminal production for
			// the goal's first turn, exactly like a normal turn. Continuation
			// turns that codex starts on its own afterwards are adopted by the
			// reducer (adoptServerInitiatedTurn) and render as their own turns,
			// so goal progress never depends on this Exec staying alive.
			initialTurn := appServerTurnFromResult(result)
			if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
				if a.setSessionActiveTurnID(session.AgentSessionID, appTurn, providerTurnID) {
					a.interruptActiveTurnAsync(appSession, session, appTurn, providerTurnID, "queued cancel")
				}
			}
			finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
			select {
			case <-appTurn.terminated:
			case <-time.After(2 * time.Second):
			}
			a.endActiveTurn(session.AgentSessionID, appTurn)
			if appTurn.settleFinalized.Load() {
				return true, nil
			}
			slog.Warn(
				"agent session app-server goal turn terminal produced by blocking shell (settle shadow miss)",
				"agent_session_id", session.AgentSessionID,
				"turn_id", turnID,
			)
			if finishErr != nil {
				if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
					terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
					terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
					terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
						"error": finishErr.Error(),
					}))
					emitTerminal(terminalEvents)
				} else {
					terminalEvents := normalizer.FinishFailed(session, turnID)
					terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(finishErr)))
					emitTerminal(terminalEvents)
				}
				a.scheduleGoalContinuationNudge(session)
				return true, nil
			}
			normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
			emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
			a.scheduleGoalContinuationNudge(session)
			return true, nil
		}
		terminalEvents := []activityshared.Event{}
		if notice := appServerGoalNoticeEvent(session, turnID, method, result); notice != nil {
			terminalEvents = append(terminalEvents, *notice)
		}
		terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
			"stopReason": "end_turn",
		}))
		emitTerminal(terminalEvents)
		return true, nil
	case appServerSlashReview:
		return a.execReviewSlashCommand(ctx, appSession, session, args, turnID, appTurn, normalizer, emitEvents, emitTerminal, emitCommands)
	case appServerSlashUndo:
		_, err := appSession.client.ThreadRollback(ctx, map[string]any{
			"threadId": appSession.threadID,
			"numTurns": 1,
		}, a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal([]activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err))})
			return true, nil
		}
		emitTerminal([]activityshared.Event{
			appServerSystemNoticeEvent(session, turnID, "system_notice", "Removed the last turn from the conversation. Local file changes are not reverted.", ""),
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", map[string]any{
				"stopReason": "end_turn",
			}),
		})
		return true, nil
	default:
		return false, nil
	}
}

func (a *CodexAppServerAdapter) sessionGoal(agentSessionID string) map[string]any {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return nil
	}
	return clonePayload(appSession.goal)
}

// beginGoalTurnHandoff atomically commits pending ownership, active
// registration and provider id. Notifications remain buffered while the Turn
// start event is emitted; drainGoalTurnHandoff then replays them in order.
func (a *CodexAppServerAdapter) beginGoalTurnHandoff(agentSessionID, providerTurnID string, turn *codexAppServerActiveTurn, identity goalOperationIdentity) bool {
	if a == nil || turn == nil || !identity.valid() {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return false
	}
	pending := appSession.pendingGoalTurns[strings.TrimSpace(providerTurnID)]
	if appSession.activeTurn != nil || pending == nil || pending.state != codexGoalTurnPending || appSession.provenanceDegraded {
		return false
	}
	pending.state = codexGoalTurnAdopting
	appSession.activeTurn = turn
	appSession.activeTurnID = strings.TrimSpace(providerTurnID)
	turn.goalIdentity = identity
	turn.goalProvenance = strings.TrimSpace(pending.provenanceMode)
	if turn.goalProvenance == "" {
		turn.goalProvenance = "turn_scoped_goal_update"
	}
	// Main's provider-turn lifecycle is emitted from appTurn, while Goal
	// provenance settlement matches through the session slot. Bind both sides
	// atomically so an adopted turn never falls back to its local Turn ID when
	// emitting root_provider_turn.completed.
	turn.providerTurnID = appSession.activeTurnID
	appSession.activeTurnStartConfirmed = true
	return true
}

func (a *CodexAppServerAdapter) drainGoalTurnHandoff(agentSessionID, providerTurnID string, appTurn *codexAppServerActiveTurn) {
	for {
		a.mu.Lock()
		appSession := a.sessions[strings.TrimSpace(agentSessionID)]
		if appSession == nil {
			a.mu.Unlock()
			return
		}
		pending := appSession.pendingGoalTurns[strings.TrimSpace(providerTurnID)]
		if pending == nil || pending.state != codexGoalTurnAdopting {
			a.mu.Unlock()
			return
		}
		if len(pending.notifications) == 0 {
			delete(appSession.pendingGoalTurns, strings.TrimSpace(providerTurnID))
			// The immutable identity has already been copied onto appTurn. The
			// durable ledger remains the exact historical source, so release this
			// per-Turn working evidence immediately instead of accumulating it for
			// the lifetime of a long-running Goal.
			delete(appSession.goalTurnEvidence, strings.TrimSpace(providerTurnID))
			a.pruneGoalProvenanceLocked(appSession)
			a.mu.Unlock()
			return
		}
		notifications := append([]acpMessage(nil), pending.notifications...)
		pending.notifications = nil
		client, session := appSession.client, pending.session
		a.mu.Unlock()
		reducer := newCodexAppServerReducer(a)
		for _, notification := range notifications {
			usesNormalizer := appServerNotificationUsesNormalizer(notification.Method)
			if usesNormalizer {
				appTurn.processMu.Lock()
				a.mu.Lock()
				currentSession := a.sessions[strings.TrimSpace(agentSessionID)]
				currentPending := (*codexPendingGoalTurn)(nil)
				if currentSession != nil {
					currentPending = currentSession.pendingGoalTurns[strings.TrimSpace(providerTurnID)]
				}
				stillAdopting := currentPending != nil && currentPending.state == codexGoalTurnAdopting
				a.mu.Unlock()
				if !stillAdopting {
					appTurn.processMu.Unlock()
					return
				}
			}
			reduction := reducer.reduceNotification(client, session, appTurn.turnID, notification, appTurn.normalizer, appTurn.emitCommands, true)
			if len(reduction.Events) > 0 {
				appTurn.emit(reduction.Events)
			}
			if usesNormalizer {
				if a.goalHandoffDrainHook != nil {
					a.goalHandoffDrainHook()
				}
				appTurn.processMu.Unlock()
			}
		}
	}
}

// scheduleGoalContinuationNudge re-sends thread/goal/set {status: active}
// when a goal turn settled but codex did not auto-start the next turn within
// the grace window. It is a safety net: the primary continuation driver is
// codex itself (whose turns are adopted on turn/started).
func (a *CodexAppServerAdapter) scheduleGoalContinuationNudge(session Session) {
	agentSessionID := session.AgentSessionID
	appSession := a.getSession(agentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	client := appSession.client
	threadID := appSession.threadID
	expectedIdentity := a.goalOperationIdentity(agentSessionID)
	if strings.TrimSpace(asString(a.sessionGoal(agentSessionID)["status"])) != "active" {
		return
	}
	grace := a.goalContinuationGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerGoalContinuationGraceWindow
	}
	go func() {
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-client.Done():
			return
		case <-timer.C:
		}
		appSession.goalMutationMu.Lock()
		defer appSession.goalMutationMu.Unlock()
		if a.sessionActiveTurn(agentSessionID) != nil || a.sessionActiveTurnID(agentSessionID) != "" {
			// Codex already continued (adopted turn) or a user turn is running.
			return
		}
		if current := a.goalOperationIdentity(agentSessionID); current != expectedIdentity {
			// A newer set/clear superseded this timer.
			return
		}
		goal := a.sessionGoal(agentSessionID)
		if strings.TrimSpace(asString(goal["status"])) != "active" {
			return
		}
		params := map[string]any{
			"threadId": threadID,
			"status":   "active",
		}
		if objective := strings.TrimSpace(asStringRaw(goal["objective"])); objective != "" {
			params["objective"] = objective
		}
		slog.Info("agent session app-server goal continuation nudge",
			"event", "agent_session.app_server.goal.continuation_nudge",
			"agent_session_id", agentSessionID,
		)
		nudgeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		a.prepareGoalContinuationClaim(agentSessionID, expectedIdentity)
		defer a.clearPreparedGoalContinuationClaim(agentSessionID, expectedIdentity)
		// NoHandler: the continuation turn's notifications must keep flowing
		// to the session-level handler while this RPC is in flight.
		result, err := client.ThreadGoalSetNoHandler(nudgeCtx, params)
		if err != nil {
			slog.Warn("agent session app-server goal continuation nudge failed",
				"event", "agent_session.app_server.goal.continuation_nudge_failed",
				"agent_session_id", agentSessionID,
				"error", err.Error(),
			)
			return
		}
		if nextGoal := appServerGoalFromResult(result); len(nextGoal) > 0 {
			if bindErr := a.bindGoalGeneration(nudgeCtx, session, nextGoal, expectedIdentity); bindErr != nil {
				slog.Error("agent session app-server goal continuation provenance persistence failed",
					"event", "agent_session.app_server.goal.continuation_provenance_failed",
					"agent_session_id", agentSessionID,
					"error", bindErr.Error(),
				)
				return
			}
			// The RPC may be slow; a newer durable command cannot acquire this
			// provider lock until it returns, but retain the result fence for
			// session teardown/replacement and future lock implementations.
			if current := a.goalOperationIdentity(agentSessionID); current == expectedIdentity {
				a.applyGoalUpdate(agentSessionID, nextGoal)
				a.armGoalContinuationClaim(agentSessionID, expectedIdentity)
			}
		}
	}()
}

type goalOperationIdentity struct {
	operationID string
	revision    int64
	repairEpoch int64
}

func (a *CodexAppServerAdapter) goalOperationIdentity(agentSessionID string) goalOperationIdentity {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		return goalOperationIdentity{}
	}
	return goalOperationIdentity{operationID: appSession.goalOperationID, revision: appSession.goalRevision, repairEpoch: appSession.goalRepairEpoch}
}

func (a *CodexAppServerAdapter) replaceGoalOperationIdentity(agentSessionID, operationID string, revision int64, repairEpoch int64) (string, int64, int64) {
	if revision <= 0 && strings.TrimSpace(operationID) == "" {
		current := a.goalOperationIdentity(agentSessionID)
		return current.operationID, current.revision, current.repairEpoch
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		return "", 0, 0
	}
	previousOperationID, previousRevision, previousRepairEpoch := appSession.goalOperationID, appSession.goalRevision, appSession.goalRepairEpoch
	appSession.goalOperationID, appSession.goalRevision, appSession.goalRepairEpoch = strings.TrimSpace(operationID), revision, repairEpoch
	return previousOperationID, previousRevision, previousRepairEpoch
}

func (a *CodexAppServerAdapter) restoreGoalOperationIdentity(agentSessionID, operationID string, revision int64, repairEpoch int64, previousOperationID string, previousRevision int64, previousRepairEpoch int64) {
	if revision <= 0 && strings.TrimSpace(operationID) == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil || appSession.goalOperationID != strings.TrimSpace(operationID) || appSession.goalRevision != revision || appSession.goalRepairEpoch != repairEpoch {
		return
	}
	appSession.goalOperationID, appSession.goalRevision, appSession.goalRepairEpoch = previousOperationID, previousRevision, previousRepairEpoch
}
