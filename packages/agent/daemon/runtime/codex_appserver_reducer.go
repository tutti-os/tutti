package agentruntime

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type codexAppServerReducer struct {
	adapter *CodexAppServerAdapter
}

type codexAppServerReduction struct {
	Events []activityshared.Event
}

func newCodexAppServerReducer(adapter *CodexAppServerAdapter) codexAppServerReducer {
	return codexAppServerReducer{adapter: adapter}
}

func (r codexAppServerReducer) ReduceNotification(
	client *codexAppServerClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emitCommands CommandSnapshotSink,
) codexAppServerReduction {
	return r.reduceNotification(client, session, turnID, message, normalizer, emitCommands, false)
}

func (r codexAppServerReducer) reduceNotification(
	client *codexAppServerClient, session Session, turnID string, message acpMessage,
	normalizer *acpTurnNormalizer, emitCommands CommandSnapshotSink, replayingBuffered bool,
) codexAppServerReduction {
	a := r.adapter
	if a == nil {
		return codexAppServerReduction{}
	}
	rootAgentSessionID := session.AgentSessionID
	params := map[string]any{}
	if len(message.Params) > 0 {
		_ = json.Unmarshal(message.Params, &params)
	}
	providerTurnID := appServerNotificationProviderTurnID(params)
	if !replayingBuffered && message.Method != appServerNotifyTurnStarted &&
		message.Method != appServerNotifyThreadGoalUpdated &&
		a.bufferPendingGoalTurnNotification(session.AgentSessionID, providerTurnID, message) {
		return codexAppServerReduction{}
	}
	diagnosticTurn := a.activeTurnForNormalizer(rootAgentSessionID, normalizer)
	route := a.appServerNotificationRoute(session, turnID, message.Method, params)
	if route.drop {
		return codexAppServerReduction{Events: route.events}
	}
	if route.session.AgentSessionID != "" {
		session = route.session
	}
	if route.normalizer != nil {
		normalizer = route.normalizer
	}
	turnID = firstNonEmpty(route.turnID, turnID)
	prefixEvents := route.events
	if _, canceled := a.rootTurnCanceled(rootAgentSessionID); canceled && route.child == nil &&
		message.Method != appServerNotifyTurnStarted && message.Method != appServerNotifyTurnCompleted {
		// The route still runs first so a late spawn edge can interrupt its native
		// child threads. No transcript/progress from the canceled execution is
		// projected after the durable cancel boundary.
		return codexAppServerReduction{}
	}
	if diagnosticTurn != nil {
		diagnosticTurn.diagnostics.ObserveNotification(message.Method, params)
	}
	emit := func(events []activityshared.Event) codexAppServerReduction {
		events = appServerEventsForChild(events, route.child)
		combined := make([]activityshared.Event, 0, len(prefixEvents)+len(events))
		combined = append(combined, prefixEvents...)
		combined = append(combined, events...)
		prefixEvents = nil
		return codexAppServerReduction{Events: combined}
	}
	switch message.Method {
	case appServerNotifyTurnStarted:
		// Record the provider turn id (needed for turn/interrupt and
		// turn/steer) only while a turn context is registered, so stray
		// turns (for example compaction) cannot block future prompts.
		// First-wins: once the live turn's id is recorded, a stray
		// server-initiated turn/started on the same thread must not overwrite
		// it — the strict completion match would then drop the real
		// turn/completed and awaitTurnCompletion would never settle. After
		// completion clears the id, the next turn/started (for example a goal
		// continuation) records normally.
		providerTurnID = strings.TrimSpace(asString(payloadObject(params["turn"])["id"]))
		if activeTurn := a.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
			if turn := payloadObject(params["turn"]); turn != nil {
				providerTurnID = strings.TrimSpace(asString(turn["id"]))
				if recorded := a.sessionActiveTurnID(session.AgentSessionID); recorded != "" && recorded != providerTurnID {
					return codexAppServerReduction{}
				}
				if a.setSessionActiveTurnID(session.AgentSessionID, activeTurn, providerTurnID) {
					a.interruptActiveTurnAsync(&codexAppServerSession{
						client:   client,
						threadID: firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					}, session, activeTurn, providerTurnID, "queued cancel")
				}
				a.confirmSessionActiveTurnStarted(session.AgentSessionID, providerTurnID)
			}
		} else if turn := payloadObject(params["turn"]); turn != nil {
			// Server-initiated turn with no registered turn context: codex
			// drives goal continuation on its own, so adopt the turn while the
			// goal is active — otherwise its output would be dropped and the
			// GUI would freeze while codex keeps working invisibly.
			providerTurnID = strings.TrimSpace(asString(turn["id"]))
			goal := a.sessionGoal(session.AgentSessionID)
			goalStatus := strings.TrimSpace(asString(goal["status"]))
			canceledRootTurnID, rootTurnCanceled := a.rootTurnCanceled(session.AgentSessionID)
			switch {
			case rootTurnCanceled:
				slog.Warn("agent session app-server interrupting unowned turn after root cancellation",
					"event", "agent_session.app_server.turn.unowned_after_cancel",
					"agent_session_id", session.AgentSessionID,
					"root_turn_id", canceledRootTurnID,
					"provider_turn_id", providerTurnID,
				)
				// Async: a synchronous RPC on the read loop would block its own
				// response from being dispatched.
				go a.sendThreadInterrupt(client, session,
					firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					providerTurnID, "root turn canceled")
				return emit(nil)
			case goalStatus == "paused":
				// The user explicitly stopped the goal (Stop pauses it); codex
				// must not keep running turns for it.
				slog.Warn("agent session app-server interrupting unowned turn for paused goal",
					"event", "agent_session.app_server.turn.unowned_interrupted",
					"agent_session_id", session.AgentSessionID,
					"provider_turn_id", providerTurnID,
					"goal_status", goalStatus,
				)
				// Async: a synchronous RPC on the read loop would block its own
				// response from being dispatched.
				go a.sendThreadInterrupt(client, session,
					firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					providerTurnID, "goal paused")
			case len(goal) > 0:
				// A goal exists (in whatever state — codex may legitimately run
				// a wrap-up turn while flipping the goal to complete). Presence of
				// that mutable snapshot is not provenance: wait for the provider's
				// turn-scoped goal generation evidence before adopting.
				a.queueGoalTurnForProvenance(session, providerTurnID)
			default:
				slog.Info("agent session app-server unowned turn ignored",
					"event", "agent_session.app_server.turn.unowned",
					"agent_session_id", session.AgentSessionID,
					"provider_turn_id", providerTurnID,
					"goal_status", goalStatus,
				)
			}
		}
		if providerTurnID == "" {
			return emit(nil)
		}
		if ctx, ok := activityEventContext(session, "root-provider-turn-started:"+providerTurnID, turnID); ok {
			return emit([]activityshared.Event{activityshared.NewRootProviderTurnStarted(ctx, turnID, providerTurnID)})
		}
		return emit(nil)
	case appServerNotifyTurnCompleted:
		// Deliver the final turn payload to the goroutine waiting in Exec.
		a.completeActiveTurn(session.AgentSessionID, payloadObject(params["turn"]))
		return codexAppServerReduction{}
	case appServerNotifyAgentMessageDelta:
		if normalizer == nil {
			return codexAppServerReduction{}
		}
		return emit(normalizer.AppendAssistantChunk(session, turnID, asStringRaw(params["delta"])))
	case appServerNotifyReasoningSummaryPart, appServerNotifyThreadSettingsUpdated:
		return codexAppServerReduction{}
	case appServerNotifyReasoningDelta, appServerNotifyReasoningSummary:
		if normalizer == nil {
			return codexAppServerReduction{}
		}
		return emit(normalizer.AppendThinkingChunk(session, turnID, appServerReasoningDeltaText(params)))
	case appServerNotifyItemStarted:
		return emit(a.appServerItemEvents(session, turnID, payloadObject(params["item"]), false, normalizer))
	case appServerNotifyItemCompleted:
		return emit(a.appServerItemEvents(session, turnID, payloadObject(params["item"]), true, normalizer))
	case appServerNotifyPlanUpdated:
		if normalizer == nil {
			return codexAppServerReduction{}
		}
		update := appServerPlanUpdate(turnID, params)
		if update == nil {
			return codexAppServerReduction{}
		}
		events, _ := normalizer.ToolCallEvents(session, turnID, update)
		return emit(events)
	case appServerNotifyTokenUsage:
		a.applyTokenUsage(session.AgentSessionID, params)
		if event, ok := normalizedUsageUpdatedEvent(session); ok {
			return emit([]activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyRateLimitsUpdated:
		a.applyRateLimits(session.AgentSessionID, payloadObject(params["rateLimits"]))
		if event, ok := normalizedUsageUpdatedEvent(session); ok {
			return emit([]activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyAccountUpdated:
		a.applyAccountUpdate(session.AgentSessionID, params)
		return codexAppServerReduction{}
	case appServerNotifyThreadNameUpdated:
		threadName := asString(params["threadName"])
		if isInternalMentionRoutingTitle(threadName) {
			return codexAppServerReduction{}
		}
		if event, ok := normalizedSessionTitleEvent(session, map[string]any{
			"title": threadName,
		}); ok {
			return emit([]activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyError:
		if willRetry, _ := params["willRetry"].(bool); willRetry {
			turnError := payloadObject(params["error"])
			detail := asString(turnError["message"])
			return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "transport_retry", "", detail)})
		}
		a.failActiveTurnFromAppServerError(session.AgentSessionID, params)
		return codexAppServerReduction{}
	case appServerNotifyWarning:
		return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "warning", "", asString(params["message"]))})
	case appServerNotifyDeprecation:
		return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "warning",
			asString(params["summary"]), asString(params["details"]))})
	case appServerNotifyModelRerouted:
		title := fmt.Sprintf("Codex rerouted the model from %s to %s.",
			asString(params["fromModel"]), asString(params["toModel"]))
		return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", title, asString(params["reason"]))})
	case appServerNotifyThreadCompacted:
		if normalizer == nil {
			return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", appServerContextCompactedTitle, "")})
		}
		messageID, shouldEmit := normalizer.CompleteCompactionNotice("compaction:" + turnID)
		if !shouldEmit {
			return codexAppServerReduction{}
		}
		return emit([]activityshared.Event{appServerCompactionNoticeEvent(session, turnID, messageID, "completed")})
	case appServerNotifyServerRequestResolved:
		a.resolvePendingRequestFromProvider(session.AgentSessionID, params)
		return codexAppServerReduction{}
	case appServerNotifyThreadGoalUpdated:
		// Goal updates are session-scoped metadata: emit through the session
		// sink so the GUI banner refreshes even while no turn context exists
		// (returned reduction events are dropped without an active turn).
		goal := payloadObject(params["goal"])
		a.observeGoalTurnGeneration(session, strings.TrimSpace(asString(params["turnId"])), goal)
		_, newStatus, statusChanged := a.applyGoalUpdate(session.AgentSessionID, goal)
		goalEvents := []activityshared.Event{}
		if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_update"); ok {
			goalEvents = append(goalEvents, event)
		}
		if statusChanged {
			if noticeTurnID := firstNonEmpty(turnID, a.sessionMarkerTurnID(session.AgentSessionID)); noticeTurnID != "" {
				if notice := appServerGoalStatusNoticeEvent(session, noticeTurnID, newStatus); notice != nil {
					goalEvents = append(goalEvents, *notice)
				}
			}
		}
		a.emitSessionEvents(session.AgentSessionID, goalEvents)
		return codexAppServerReduction{}
	case appServerNotifyThreadGoalCleared:
		a.applyGoalClear(session.AgentSessionID)
		if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_cleared"); ok {
			a.emitSessionEvents(session.AgentSessionID, []activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyThreadStarted:
		return codexAppServerReduction{}
	default:
		_ = emitCommands
		return codexAppServerReduction{}
	}
}
