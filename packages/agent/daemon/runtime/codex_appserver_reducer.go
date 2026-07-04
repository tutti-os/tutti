package agentruntime

import (
	"encoding/json"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
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
				if a.setSessionActiveTurnID(session.AgentSessionID, providerTurnID) {
					a.interruptActiveTurnAsync(&codexAppServerSession{
						client:   client,
						threadID: firstNonEmpty(asString(params["threadId"]), session.ProviderSessionID),
					}, session, activeTurn, providerTurnID, "queued cancel")
				}
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
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return emit([]activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyRateLimitsUpdated:
		a.applyRateLimits(session.AgentSessionID, payloadObject(params["rateLimits"]))
		if event, ok := acpUsageUpdatedEvent(session); ok {
			return emit([]activityshared.Event{event})
		}
		return codexAppServerReduction{}
	case appServerNotifyAccountUpdated:
		a.applyAccountUpdate(session.AgentSessionID, params)
		return codexAppServerReduction{}
	case appServerNotifyThreadNameUpdated:
		if event, ok := acpSessionTitleEvent(session, map[string]any{
			"title": asString(params["threadName"]),
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
		a.applyGoalUpdate(session.AgentSessionID, payloadObject(params["goal"]))
		return codexAppServerReduction{}
	case appServerNotifyThreadGoalCleared:
		a.applyGoalClear(session.AgentSessionID)
		return codexAppServerReduction{}
	case appServerNotifyThreadStarted:
		return codexAppServerReduction{}
	default:
		_ = emitCommands
		return codexAppServerReduction{}
	}
}
