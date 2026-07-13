package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) appServerNotificationRoute(
	session Session,
	method string,
	params map[string]any,
) appServerNotificationRoute {
	parentThreadID := strings.TrimSpace(session.ProviderSessionID)
	eventThreadID := strings.TrimSpace(asString(params["threadId"]))
	if parentThreadID == "" || eventThreadID == "" || eventThreadID == parentThreadID {
		if added := a.rememberAppServerChildThreads(session.AgentSessionID, parentThreadID, payloadObject(params["item"])); len(added) > 0 {
			a.scheduleChildNicknameFetches(session, added)
		}
		return appServerNotificationRoute{}
	}

	child, ok := a.appServerChildThread(session.AgentSessionID, eventThreadID)
	if !ok {
		a.recordForeignThreadDrop(session.AgentSessionID, eventThreadID)
		a.logAppServerForeignThreadDrop(session, method, params, eventThreadID)
		return appServerNotificationRoute{drop: true}
	}
	if event := appServerChildTerminalStatusEvent(session, eventThreadID, method, params); event.Type != "" {
		return appServerNotificationRoute{
			ownerThreadID: eventThreadID,
			ownerCallID:   child.parentItemID,
			turnID:        event.Payload.TurnID,
			events:        []activityshared.Event{event},
			drop:          true,
		}
	}
	if appServerSuppressChildNotification(method) {
		return appServerNotificationRoute{drop: true}
	}
	if child.normalizer == nil {
		child.normalizer = newACPTurnNormalizer()
		a.storeAppServerChildThread(session.AgentSessionID, eventThreadID, child)
	}
	return appServerNotificationRoute{
		ownerThreadID: eventThreadID,
		ownerCallID:   child.parentItemID,
		turnID:        firstNonEmpty(asString(params["turnId"]), asString(payloadObject(params["turn"])["id"])),
		normalizer:    child.normalizer,
	}
}

const appServerForeignDropTrackerCap = 64

// recordForeignThreadDrop remembers an unknown-thread drop so a later child
// registration can report events lost to the announce/stream ordering gap
// (ADR 0003 verification telemetry). Bounded; unrelated foreign threads age
// out by never being registered.
func (a *CodexAppServerAdapter) recordForeignThreadDrop(agentSessionID string, threadID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	if appSession.recentForeignDrops == nil {
		appSession.recentForeignDrops = make(map[string]int)
	}
	if len(appSession.recentForeignDrops) >= appServerForeignDropTrackerCap {
		if _, tracked := appSession.recentForeignDrops[threadID]; !tracked {
			return
		}
	}
	appSession.recentForeignDrops[threadID]++
}

func (a *CodexAppServerAdapter) rememberAppServerChildThreads(agentSessionID string, parentThreadID string, item map[string]any) []string {
	if asString(item["type"]) != "collabAgentToolCall" {
		return nil
	}
	childThreadIDs := appServerReceiverThreadIDs(item["receiverThreadIds"])
	if len(childThreadIDs) == 0 {
		return nil
	}
	parentThreadID = strings.TrimSpace(parentThreadID)
	parentItemID := strings.TrimSpace(asString(item["id"]))
	// Only the spawn card owns the children it declares. Wait/close control
	// cards also list receiverThreadIds and must register the thread for
	// routing, but must never claim lane ownership: parentItemID is
	// first-wins below, and it becomes each child row's ownerCallId
	// (ADR 0007).
	if appServerAgentControlToolName(asString(item["tool"])) != "" {
		parentItemID = ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return nil
	}
	if appSession.childThreads == nil {
		appSession.childThreads = make(map[string]*codexAppServerThreadContext)
	}
	added := make([]string, 0, len(childThreadIDs))
	for _, childThreadID := range childThreadIDs {
		if childThreadID == "" || childThreadID == parentThreadID {
			continue
		}
		if existing := appSession.childThreads[childThreadID]; existing != nil {
			if existing.parentItemID == "" {
				existing.parentItemID = parentItemID
			}
			if existing.parentThreadID == "" {
				existing.parentThreadID = parentThreadID
			}
			continue
		}
		context := &codexAppServerThreadContext{
			parentThreadID: parentThreadID,
			parentItemID:   parentItemID,
			normalizer:     newACPTurnNormalizer(),
		}
		if dropped := appSession.recentForeignDrops[childThreadID]; dropped > 0 {
			context.droppedBeforeRegistration = dropped
			delete(appSession.recentForeignDrops, childThreadID)
			slog.Warn(
				"agent session app-server child events arrived before registration",
				"agent_session_id", agentSessionID,
				"child_thread_id", childThreadID,
				"dropped_events", dropped,
			)
		}
		appSession.childThreads[childThreadID] = context
		added = append(added, childThreadID)
	}
	return added
}

func (a *CodexAppServerAdapter) appServerChildThread(agentSessionID string, childThreadID string) (*codexAppServerThreadContext, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.childThreads == nil {
		return nil, false
	}
	child := appSession.childThreads[strings.TrimSpace(childThreadID)]
	if child == nil {
		return nil, false
	}
	return &codexAppServerThreadContext{
		parentThreadID:            child.parentThreadID,
		parentItemID:              child.parentItemID,
		normalizer:                child.normalizer,
		droppedBeforeRegistration: child.droppedBeforeRegistration,
	}, true
}

func (a *CodexAppServerAdapter) storeAppServerChildThread(
	agentSessionID string,
	childThreadID string,
	child *codexAppServerThreadContext,
) {
	if child == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	if appSession.childThreads == nil {
		appSession.childThreads = make(map[string]*codexAppServerThreadContext)
	}
	appSession.childThreads[strings.TrimSpace(childThreadID)] = child
}

func appServerSuppressChildNotification(method string) bool {
	switch method {
	case appServerNotifyThreadStarted,
		appServerNotifyThreadSettingsUpdated,
		appServerNotifyThreadNameUpdated,
		appServerNotifyThreadCompacted,
		appServerNotifyThreadGoalUpdated,
		appServerNotifyThreadGoalCleared,
		appServerNotifyTurnStarted,
		appServerNotifyTurnCompleted,
		// A child's error must never reach failActiveTurnFromAppServerError on
		// the parent session: with an empty parent activeTurnID (wildcard
		// match) it would fail the parent's running turn. Child failures reach
		// the transcript through the parent's collabAgentToolCall item.
		appServerNotifyError,
		appServerNotifyServerRequestResolved,
		appServerNotifyPlanUpdated,
		appServerNotifyTokenUsage,
		appServerNotifyRateLimitsUpdated,
		appServerNotifyAccountUpdated:
		return true
	default:
		return false
	}
}

func appServerChildTerminalStatusEvent(
	session Session,
	ownerThreadID string,
	method string,
	params map[string]any,
) activityshared.Event {
	ownerThreadID = strings.TrimSpace(ownerThreadID)
	if ownerThreadID == "" {
		return activityshared.Event{}
	}
	switch method {
	case appServerNotifyTurnCompleted:
		turn := payloadObject(params["turn"])
		turnID := firstNonEmpty(asString(params["turnId"]), asString(turn["id"]))
		status := appServerChildLifecycleStatus(asString(turn["status"]))
		return appServerSubAgentLifecycleEvent(session, ownerThreadID, turnID, status, appServerChildFailureDetail(turn))
	case appServerNotifyError:
		if willRetry, _ := params["willRetry"].(bool); willRetry {
			return activityshared.Event{}
		}
		turnID := firstNonEmpty(asString(params["turnId"]), asString(payloadObject(params["turn"])["id"]))
		return appServerSubAgentLifecycleEvent(session, ownerThreadID, turnID, "failed", appServerChildFailureDetail(payloadObject(params["error"])))
	case appServerNotifyThreadNameUpdated:
		return appServerSubAgentNameEvent(session, ownerThreadID, asString(params["threadName"]))
	default:
		return activityshared.Event{}
	}
}

// appServerSubAgentNameEvent projects a child thread's name onto a hidden
// ownerThreadId-tagged marker so the GUI can title the sub-agent lane with
// the agent's real identity instead of the collab tool name.
func appServerSubAgentNameEvent(session Session, ownerThreadID string, name string) activityshared.Event {
	ownerThreadID = strings.TrimSpace(ownerThreadID)
	name = strings.TrimSpace(name)
	if ownerThreadID == "" || name == "" {
		return activityshared.Event{}
	}
	messageID := "subagent-name:" + ownerThreadID
	payload := map[string]any{
		"messageId":     messageID,
		"contentMode":   messageContentModeSnapshot,
		"messageKind":   "subAgentName",
		"subAgentName":  name,
		"ownerThreadId": ownerThreadID,
	}
	event := newTurnActivityEventWithID(
		session,
		messageID,
		EventMessage,
		"",
		"completed",
		RoleAssistant,
		"",
		payload,
	)
	event.OwnerThreadID = ownerThreadID
	return event
}

func appServerChildLifecycleStatus(status string) string {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "failed", "error", "errored":
		return "failed"
	case "canceled", "cancelled", "interrupted":
		return "canceled"
	default:
		return "completed"
	}
}

func appServerChildFailureDetail(payload map[string]any) string {
	return firstNonEmpty(
		asStringRaw(payload["message"]),
		asStringRaw(payload["detail"]),
		asStringRaw(payload["error"]),
		asStringRaw(payload["reason"]),
	)
}

func appServerSubAgentLifecycleEvent(session Session, ownerThreadID string, turnID string, status string, detail string) activityshared.Event {
	ownerThreadID = strings.TrimSpace(ownerThreadID)
	status = strings.TrimSpace(status)
	if ownerThreadID == "" || status == "" {
		return activityshared.Event{}
	}
	messageID := "subagent-lifecycle:" + ownerThreadID + ":" + firstNonEmpty(strings.TrimSpace(turnID), newID())
	payload := map[string]any{
		"messageId":               messageID,
		"contentMode":             messageContentModeSnapshot,
		"streamState":             status,
		"messageKind":             "subAgentLifecycle",
		"subAgentLifecycleStatus": status,
		"ownerThreadId":           ownerThreadID,
	}
	if detail != "" {
		payload["detail"] = detail
	}
	event := newTurnActivityEventWithID(
		session,
		messageID,
		EventMessage,
		strings.TrimSpace(turnID),
		status,
		RoleAssistant,
		"",
		payload,
	)
	event.OwnerThreadID = ownerThreadID
	return event
}

func appServerReceiverThreadIDs(value any) []string {
	values, ok := value.([]any)
	if !ok {
		if typed, ok := value.([]string); ok {
			out := make([]string, 0, len(typed))
			for _, item := range typed {
				if trimmed := strings.TrimSpace(item); trimmed != "" {
					out = append(out, trimmed)
				}
			}
			return out
		}
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if threadID := strings.TrimSpace(asString(value)); threadID != "" {
			out = append(out, threadID)
		}
	}
	return out
}

func appServerEventsWithOwner(events []activityshared.Event, ownerThreadID string, ownerCallID string) []activityshared.Event {
	ownerThreadID = strings.TrimSpace(ownerThreadID)
	if ownerThreadID == "" || len(events) == 0 {
		return events
	}
	ownerCallID = strings.TrimSpace(ownerCallID)
	for index := range events {
		events[index].OwnerThreadID = ownerThreadID
		events[index].OwnerCallID = ownerCallID
	}
	return events
}

func (*CodexAppServerAdapter) logAppServerForeignThreadDrop(
	session Session,
	method string,
	params map[string]any,
	eventThreadID string,
) {
	expectedThreadID := strings.TrimSpace(session.ProviderSessionID)
	item := payloadObject(params["item"])
	slog.Debug(
		"agent session app-server notification ignored for foreign thread",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", expectedThreadID,
		"event_thread_id", eventThreadID,
		"event_turn_id", asString(params["turnId"]),
		"method", method,
		"item_id", asString(item["id"]),
		"item_type", asString(item["type"]),
		"item_status", asString(item["status"]),
	)
}

func appServerItemStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "inProgress", "in_progress", "":
		return "in_progress"
	case "declined":
		return "failed"
	default:
		return status
	}
}

func appServerPlanUpdate(turnID string, params map[string]any) map[string]any {
	steps, _ := params["plan"].([]any)
	if len(steps) == 0 {
		return nil
	}
	todos := make([]any, 0, len(steps))
	for _, step := range steps {
		entry := payloadObject(step)
		text := asStringRaw(entry["step"])
		if text == "" {
			continue
		}
		todos = append(todos, map[string]any{
			"content": text,
			"status":  appServerPlanStepStatus(asString(entry["status"])),
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "plan:" + strings.TrimSpace(turnID),
		"title":         "update_todo",
		"kind":          "think",
		"status":        "completed",
		"rawInput":      map[string]any{"todos": todos},
	}
}

func appServerPlanStepStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "inProgress", "in_progress":
		return "in_progress"
	case "completed":
		return "completed"
	default:
		return "pending"
	}
}
