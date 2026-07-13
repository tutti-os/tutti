package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (*CodexAppServerAdapter) steerActiveTurn(
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
	_, err := appSession.client.TurnSteerNoHandler(ctx, map[string]any{
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
func (a *CodexAppServerAdapter) GoalControl(
	ctx context.Context,
	session Session,
	action GoalControlAction,
	objective string,
) ([]activityshared.Event, map[string]any, error) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, nil, ErrSessionDisconnected
	}
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
			return nil, nil, fmt.Errorf("goal objective is required")
		}
		params["objective"] = objective
		params["status"] = "active"
	default:
		return nil, nil, fmt.Errorf("unsupported goal control action %q", action)
	}
	slog.Info("agent session app-server goal control",
		"event", "agent_session.app_server.goal.control",
		"agent_session_id", session.AgentSessionID,
		"action", string(action),
	)
	result, err := appSession.callGoalNoHandler(ctx, method, params)
	if err != nil {
		return nil, nil, err
	}
	goalUpdateType := "thread_goal_update"
	var goal map[string]any
	if method == appServerMethodThreadGoalClear {
		a.applyGoalClear(session.AgentSessionID)
		goalUpdateType = "thread_goal_cleared"
	} else {
		goal = appServerGoalFromResult(result)
		if len(goal) > 0 {
			a.applyGoalUpdate(session.AgentSessionID, goal)
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
	events := []activityshared.Event{}
	if event, ok := normalizedGoalUpdatedEvent(session, goalUpdateType); ok {
		events = append(events, event)
	}
	if action == GoalControlResume || action == GoalControlSet {
		// Codex normally starts the next goal turn itself after the goal
		// becomes active again; the nudge covers the case where it does not.
		a.scheduleGoalContinuationNudge(session)
	}
	return events, a.sessionGoal(session.AgentSessionID), nil
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
	turnID string,
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
	events, err := a.execGoalControlCommand(ctx, appSession, session, args, turnID, content, explicitDisplayPrompt, visibleText, nil)
	return events, true, err
}

// execGoalControlCommand executes /goal while another turn is running. The
// goal RPC runs against the thread (not the turn); the submission is recorded
// like a steered message so the controller closes this Exec's turn record
// while the running turn keeps owning the session lifecycle. A /goal with a
// new objective mid-turn updates the objective; continuation turns are then
// adopted after the running turn settles.
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
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, displayPrompt, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"steered":     true,
			"goalControl": true,
		}))),
	}
	if err != nil {
		events = append(events, appServerSystemNoticeEvent(session, turnID, "warning", "Goal command failed.", err.Error()))
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
	if notice := appServerGoalNoticeEvent(session, turnID, method, result); notice != nil {
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
		normalizer.TrackCompactionNotice(startMessageID, false)
		emitEvents([]activityshared.Event{appServerCompactionNoticeEvent(session, turnID, startMessageID, false)})
		_, err := appSession.client.ThreadCompactStart(ctx, map[string]any{
			"threadId": appSession.threadID,
		}, a.appServerMessageHandler(appSession, session, turnID, normalizer, emitEvents, emitCommands))
		if err != nil {
			emitTerminal(append(
				normalizer.settlePendingCompactionEvents(session, turnID, appServerCompactionInterruptedTitle),
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
		var previousGoal map[string]any
		if goalDrivesTurn {
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

// adoptServerInitiatedTurn registers a turn that codex started on its own
// (goal auto-continuation) as a first-class tracked turn: it gets a fresh
// turn id, a normalizer, and a session-sink emitter, so its output persists
// and renders exactly like an Exec-driven turn. Settlement is owned by the
// notification path (settleEmits); no goroutine blocks on it. Runs on the
// client read loop, so registration completes before the turn's first item
// notification is processed.
func (a *CodexAppServerAdapter) adoptServerInitiatedTurn(session Session, providerTurnID string) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	turnID := newID()
	normalizer := newACPTurnNormalizer()
	var eventsMu sync.Mutex
	turnClosed := false
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		a.emitSessionEvents(session.AgentSessionID, a.stampTurnLifecycleSnapshots(session.AgentSessionID, next))
	}
	emitTerminal := func(next []activityshared.Event) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		turnClosed = true
		a.emitSessionEvents(session.AgentSessionID, a.stampTurnLifecycleSnapshots(session.AgentSessionID, next))
	}
	appTurn := &codexAppServerActiveTurn{
		turnID:      turnID,
		session:     session,
		ctx:         context.Background(),
		normalizer:  normalizer,
		emit:        emitEvents,
		kind:        codexAppServerTurnKindGoalAdopted,
		phase:       codexAppServerTurnPhaseRunning,
		terminal:    make(chan codexAppServerTurnTerminal, 1),
		terminated:  make(chan struct{}),
		settleEmits: true,
	}
	appTurn.emitTerminal = emitTerminal
	if !a.beginActiveTurn(session.AgentSessionID, appTurn) {
		// A registered turn won the race; leave tracking to it.
		return
	}
	a.setSessionActiveTurnID(session.AgentSessionID, appTurn, providerTurnID)
	// The adopted id comes from the turn/started notification itself.
	a.confirmSessionActiveTurnStarted(session.AgentSessionID, providerTurnID)
	slog.Info("agent session app-server goal turn adopted",
		"event", "agent_session.app_server.goal.turn_adopted",
		"agent_session_id", session.AgentSessionID,
		"provider_turn_id", providerTurnID,
		"turn_id", turnID,
	)
	emitEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"goalContinuation": true,
		}),
	})
	go a.watchTurnExternalTermination(appSession, appTurn)
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
		if a.sessionActiveTurn(agentSessionID) != nil || a.sessionActiveTurnID(agentSessionID) != "" {
			// Codex already continued (adopted turn) or a user turn is running.
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
			a.applyGoalUpdate(agentSessionID, nextGoal)
		}
	}()
}
