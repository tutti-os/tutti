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
	a := r.adapter
	if a == nil {
		return codexAppServerReduction{}
	}
	params := map[string]any{}
	if len(message.Params) > 0 {
		_ = json.Unmarshal(message.Params, &params)
	}
	route := a.appServerNotificationRoute(session, message.Method, params)
	if route.drop {
		routed := appServerEventsWithOwner(route.events, route.ownerThreadID, route.ownerCallID)
		for index := range routed {
			// The activity store rejects turnless message updates; fall back to
			// the parent's turn so hidden child markers always reach the GUI.
			if routed[index].Payload.TurnID == "" {
				routed[index].Payload.TurnID = firstNonEmpty(turnID, r.adapter.sessionMarkerTurnID(session.AgentSessionID))
			}
		}
		return codexAppServerReduction{Events: routed}
	}
	if route.normalizer != nil {
		normalizer = route.normalizer
	}
	turnID = firstNonEmpty(route.turnID, turnID)
	ownerThreadID := route.ownerThreadID
	ownerCallID := route.ownerCallID
	emit := func(events []activityshared.Event) codexAppServerReduction {
		return codexAppServerReduction{Events: appServerEventsWithOwner(events, ownerThreadID, ownerCallID)}
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
		if activeTurn := a.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
			if turn := payloadObject(params["turn"]); turn != nil {
				providerTurnID := strings.TrimSpace(asString(turn["id"]))
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
			providerTurnID := strings.TrimSpace(asString(turn["id"]))
			goal := a.sessionGoal(session.AgentSessionID)
			goalStatus := strings.TrimSpace(asString(goal["status"]))
			switch {
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
				// a wrap-up turn while flipping the goal to complete): adopt the
				// turn so its output stays visible.
				a.adoptServerInitiatedTurn(session, providerTurnID)
			default:
				slog.Info("agent session app-server unowned turn ignored",
					"event", "agent_session.app_server.turn.unowned",
					"agent_session_id", session.AgentSessionID,
					"provider_turn_id", providerTurnID,
					"goal_status", goalStatus,
				)
			}
		}
		return codexAppServerReduction{}
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
		return emit([]activityshared.Event{appServerSystemNoticeEvent(session, turnID, "system_notice", "Context compacted.", "")})
	case appServerNotifyServerRequestResolved:
		a.resolvePendingRequestFromProvider(session.AgentSessionID, params)
		return codexAppServerReduction{}
	case appServerNotifyThreadGoalUpdated:
		// Goal updates are session-scoped metadata: emit through the session
		// sink so the GUI banner refreshes even while no turn context exists
		// (returned reduction events are dropped without an active turn).
		_, newStatus, statusChanged := a.applyGoalUpdate(session.AgentSessionID, payloadObject(params["goal"]))
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
		a.emitSessionEvents(session.AgentSessionID, appServerEventsWithOwner(goalEvents, ownerThreadID, ownerCallID))
		return codexAppServerReduction{}
	case appServerNotifyThreadGoalCleared:
		a.applyGoalClear(session.AgentSessionID)
		if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_cleared"); ok {
			a.emitSessionEvents(session.AgentSessionID, appServerEventsWithOwner([]activityshared.Event{event}, ownerThreadID, ownerCallID))
		}
		return codexAppServerReduction{}
	case appServerNotifyThreadStarted:
		return codexAppServerReduction{}
	default:
		_ = emitCommands
		return codexAppServerReduction{}
	}
}
