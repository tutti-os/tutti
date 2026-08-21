package agentruntime

import (
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) appServerNotificationRoute(
	session Session,
	rootTurnID string,
	method string,
	params map[string]any,
) appServerNotificationRoute {
	parentThreadID := strings.TrimSpace(session.ProviderSessionID)
	eventThreadID := strings.TrimSpace(asString(params["threadId"]))
	if parentThreadID == "" || eventThreadID == "" || eventThreadID == parentThreadID {
		rootTurnID = firstNonEmpty(strings.TrimSpace(rootTurnID), a.sessionMarkerTurnID(session.AgentSessionID))
		added, events := a.rememberAppServerChildThreads(
			session,
			parentThreadID,
			session.AgentSessionID,
			rootTurnID,
			session.AgentSessionID,
			rootTurnID,
			payloadObject(params["item"]),
		)
		if len(added) > 0 {
			a.scheduleChildNicknameFetches(session, added)
		}
		return appServerNotificationRoute{
			events:               events,
			registeredChildCount: len(added),
		}
	}

	child, ok := a.appServerChildThread(session.AgentSessionID, eventThreadID)
	if !ok {
		if a.canceledProviderThread(session.AgentSessionID, eventThreadID) {
			if method == appServerNotifyTurnStarted {
				providerTurnID := strings.TrimSpace(asString(payloadObject(params["turn"])["id"]))
				if appSession := a.getSession(session.AgentSessionID); appSession != nil && appSession.client != nil {
					go a.sendThreadInterrupt(appSession.client, session, eventThreadID, providerTurnID, "root turn canceled")
				}
			}
			return appServerNotificationRoute{drop: true}
		}
		a.recordForeignThreadDrop(session.AgentSessionID, eventThreadID)
		a.bufferForeignThreadTerminal(session.AgentSessionID, eventThreadID, method, params)
		a.logAppServerForeignThreadDrop(session, method, params, eventThreadID)
		return appServerNotificationRoute{drop: true}
	}
	eventSession := appServerChildSession(session, eventThreadID, child)
	added, prefixEvents := a.rememberAppServerChildThreads(
		eventSession,
		eventThreadID,
		child.rootAgentSessionID,
		child.rootTurnID,
		child.agentSessionID,
		child.turnID,
		payloadObject(params["item"]),
	)
	if len(added) > 0 {
		a.scheduleChildNicknameFetches(session, added)
	}
	if terminalEvents := appServerChildTerminalEvents(eventSession, child, method, params); len(terminalEvents) > 0 {
		terminalEvents = appServerEventsForChild(terminalEvents, child)
		return appServerNotificationRoute{events: append(prefixEvents, terminalEvents...), drop: true}
	}
	if appServerSuppressChildNotification(method) {
		return appServerNotificationRoute{events: prefixEvents, drop: true}
	}
	if child.normalizer == nil {
		child.normalizer = newACPTurnNormalizer()
		a.storeAppServerChildThread(session.AgentSessionID, eventThreadID, child)
	}
	return appServerNotificationRoute{
		session:              eventSession,
		child:                child,
		turnID:               child.turnID,
		normalizer:           child.normalizer,
		events:               prefixEvents,
		registeredChildCount: len(added),
	}
}

func appServerEventsForChild(events []activityshared.Event, child *codexAppServerThreadContext) []activityshared.Event {
	if child == nil {
		return events
	}
	for index := range events {
		events[index].SessionKind = "child"
		events[index].RootAgentSessionID = child.rootAgentSessionID
		events[index].RootTurnID = child.rootTurnID
		events[index].ParentAgentSessionID = child.parentAgentSessionID
		events[index].ParentTurnID = child.parentTurnID
		events[index].ParentToolCallID = child.parentItemID
	}
	return events
}

const appServerForeignDropTrackerCap = 64

const appServerForeignTerminalBufferCap = 64

// recordForeignThreadDrop remembers an unknown-thread arrival so a later child
// registration can report the announce/stream ordering gap (ADR 0003
// verification telemetry). Ordinary progress remains dropped; terminal
// notifications are buffered separately. Bounded; unrelated foreign threads
// age out by never being registered.
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

func (a *CodexAppServerAdapter) bufferForeignThreadTerminal(
	agentSessionID string,
	threadID string,
	method string,
	params map[string]any,
) {
	if a == nil || !appServerIsForeignTerminalNotification(method, params) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	if appSession.pendingForeignTerminalNotifications == nil {
		appSession.pendingForeignTerminalNotifications = make(map[string]appServerBufferedNotification)
	}
	if len(appSession.pendingForeignTerminalNotifications) >= appServerForeignTerminalBufferCap {
		if _, tracked := appSession.pendingForeignTerminalNotifications[threadID]; !tracked {
			return
		}
	}
	if existing, tracked := appSession.pendingForeignTerminalNotifications[threadID]; tracked {
		if existing.method == appServerNotifyTurnCompleted || method != appServerNotifyTurnCompleted {
			return
		}
	}
	appSession.pendingForeignTerminalNotifications[threadID] = appServerBufferedNotification{
		method: method,
		params: clonePayload(params),
	}
}

func appServerIsForeignTerminalNotification(method string, params map[string]any) bool {
	switch method {
	case appServerNotifyTurnCompleted:
		return true
	case appServerNotifyError:
		willRetry, _ := params["willRetry"].(bool)
		return !willRetry
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) rememberAppServerChildThreads(
	session Session,
	parentThreadID string,
	rootAgentSessionID string,
	rootTurnID string,
	parentAgentSessionID string,
	parentTurnID string,
	item map[string]any,
) ([]string, []activityshared.Event) {
	spawn, ok := appServerChildSpawnEvidenceFromItem(item)
	if !ok {
		return nil, nil
	}
	childThreadIDs := spawn.childThreadIDs
	parentThreadID = strings.TrimSpace(parentThreadID)
	parentItemID := spawn.parentItemID
	rootAgentSessionID = strings.TrimSpace(rootAgentSessionID)
	rootTurnID = strings.TrimSpace(rootTurnID)
	parentAgentSessionID = strings.TrimSpace(parentAgentSessionID)
	parentTurnID = strings.TrimSpace(parentTurnID)
	if parentItemID == "" || rootAgentSessionID == "" || rootTurnID == "" || parentAgentSessionID == "" || parentTurnID == "" {
		return nil, nil
	}
	a.mu.Lock()
	appSession := a.sessions[rootAgentSessionID]
	if appSession == nil {
		a.mu.Unlock()
		return nil, nil
	}
	if strings.TrimSpace(appSession.canceledRootTurnID) != "" {
		if appSession.canceledProviderThreads == nil {
			appSession.canceledProviderThreads = make(map[string]struct{})
		}
		lateChildThreadIDs := make([]string, 0, len(childThreadIDs))
		for _, childThreadID := range childThreadIDs {
			if childThreadID == "" || childThreadID == parentThreadID {
				continue
			}
			appSession.canceledProviderThreads[childThreadID] = struct{}{}
			lateChildThreadIDs = append(lateChildThreadIDs, childThreadID)
		}
		client := appSession.client
		canceledRootTurnID := appSession.canceledRootTurnID
		a.mu.Unlock()
		cancelSession := session
		cancelSession.AgentSessionID = rootAgentSessionID
		for _, childThreadID := range lateChildThreadIDs {
			if client != nil {
				go a.sendThreadInterrupt(client, cancelSession, childThreadID, "", "root turn canceled")
			}
		}
		if len(lateChildThreadIDs) > 0 {
			slog.Warn(
				"agent session app-server interrupting child threads discovered after root cancellation",
				"event", "agent_session.app_server.child.late_after_cancel",
				"agent_session_id", rootAgentSessionID,
				"root_turn_id", canceledRootTurnID,
				"child_thread_count", len(lateChildThreadIDs),
			)
		}
		return nil, nil
	}
	if appSession.childThreads == nil {
		appSession.childThreads = make(map[string]*codexAppServerThreadContext)
	}
	added := make([]string, 0, len(childThreadIDs))
	addedContexts := make([]*codexAppServerThreadContext, 0, len(childThreadIDs))
	bufferedTerminals := make(map[string]appServerBufferedNotification)
	for _, childThreadID := range childThreadIDs {
		if childThreadID == "" || childThreadID == parentThreadID {
			continue
		}
		if existing := appSession.childThreads[childThreadID]; existing != nil {
			continue
		}
		context := &codexAppServerThreadContext{
			agentSessionID:       newID(),
			turnID:               newID(),
			rootAgentSessionID:   rootAgentSessionID,
			rootTurnID:           rootTurnID,
			parentAgentSessionID: parentAgentSessionID,
			parentTurnID:         parentTurnID,
			parentThreadID:       parentThreadID,
			parentItemID:         parentItemID,
			normalizer:           newACPTurnNormalizer(),
		}
		if dropped := appSession.recentForeignDrops[childThreadID]; dropped > 0 {
			context.droppedBeforeRegistration = dropped
			delete(appSession.recentForeignDrops, childThreadID)
			slog.Warn(
				"agent session app-server child events arrived before registration",
				"agent_session_id", rootAgentSessionID,
				"child_thread_id", childThreadID,
				"dropped_events", dropped,
			)
		}
		appSession.childThreads[childThreadID] = context
		if buffered, ok := appSession.pendingForeignTerminalNotifications[childThreadID]; ok {
			bufferedTerminals[childThreadID] = buffered
			delete(appSession.pendingForeignTerminalNotifications, childThreadID)
		}
		added = append(added, childThreadID)
		addedContexts = append(addedContexts, context)
	}
	a.mu.Unlock()
	events := make([]activityshared.Event, 0, len(addedContexts))
	for index, child := range addedContexts {
		childSession := appServerChildSession(session, added[index], child)
		if event := appServerChildStartedEvent(childSession, child); event.Type != "" {
			events = append(events, event)
		}
		if buffered, ok := bufferedTerminals[added[index]]; ok {
			terminalEvents := appServerChildTerminalEvents(childSession, child, buffered.method, buffered.params)
			events = append(events, appServerEventsForChild(terminalEvents, child)...)
		}
	}
	return added, events
}

type appServerChildSpawnEvidence struct {
	parentItemID   string
	childThreadIDs []string
}

func appServerChildSpawnEvidenceFromItem(item map[string]any) (appServerChildSpawnEvidence, bool) {
	parentItemID := strings.TrimSpace(asString(item["id"]))
	if parentItemID == "" {
		return appServerChildSpawnEvidence{}, false
	}
	switch asString(item["type"]) {
	case "collabAgentToolCall":
		// Wait/close cards reference existing children but are not delegation
		// edges. A durable child is created only from a spawn-shaped card that
		// supplies its immutable parent tool-call id.
		if appServerAgentControlToolName(asString(item["tool"])) != "" {
			return appServerChildSpawnEvidence{}, false
		}
		childThreadIDs := appServerReceiverThreadIDs(item["receiverThreadIds"])
		if len(childThreadIDs) == 0 {
			return appServerChildSpawnEvidence{}, false
		}
		return appServerChildSpawnEvidence{
			parentItemID:   parentItemID,
			childThreadIDs: childThreadIDs,
		}, true
	case "subAgentActivity":
		if asString(item["kind"]) != "started" {
			return appServerChildSpawnEvidence{}, false
		}
		childThreadID := strings.TrimSpace(asString(item["agentThreadId"]))
		if childThreadID == "" {
			return appServerChildSpawnEvidence{}, false
		}
		return appServerChildSpawnEvidence{
			parentItemID:   parentItemID,
			childThreadIDs: []string{childThreadID},
		}, true
	default:
		return appServerChildSpawnEvidence{}, false
	}
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
		agentSessionID:            child.agentSessionID,
		turnID:                    child.turnID,
		rootAgentSessionID:        child.rootAgentSessionID,
		rootTurnID:                child.rootTurnID,
		parentAgentSessionID:      child.parentAgentSessionID,
		parentTurnID:              child.parentTurnID,
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
		appServerNotifyPlanUpdated,
		appServerNotifyTokenUsage,
		appServerNotifyRateLimitsUpdated,
		appServerNotifyAccountUpdated:
		return true
	default:
		return false
	}
}

func appServerChildSession(root Session, providerThreadID string, child *codexAppServerThreadContext) Session {
	if child == nil {
		return Session{}
	}
	root.AgentSessionID = child.agentSessionID
	root.ProviderSessionID = strings.TrimSpace(providerThreadID)
	root.Title = ""
	root.Status = SessionStatusWorking
	root.TurnLifecycle = nil
	root.SubmitAvailability = blockedSubmitAvailability("active_turn")
	return root
}

func appServerChildEventContext(
	session Session,
	child *codexAppServerThreadContext,
	eventID string,
) (activityshared.EventContext, bool) {
	if child == nil {
		return activityshared.EventContext{}, false
	}
	ctx, ok := activityEventContext(session, eventID, child.turnID)
	if !ok {
		return activityshared.EventContext{}, false
	}
	ctx.SessionKind = "child"
	ctx.RootAgentSessionID = child.rootAgentSessionID
	ctx.RootTurnID = child.rootTurnID
	ctx.ParentAgentSessionID = child.parentAgentSessionID
	ctx.ParentTurnID = child.parentTurnID
	ctx.ParentToolCallID = child.parentItemID
	return ctx, true
}

func appServerChildStartedEvent(session Session, child *codexAppServerThreadContext) activityshared.Event {
	ctx, ok := appServerChildEventContext(session, child, "child-session-started:"+child.agentSessionID)
	if !ok {
		return activityshared.Event{}
	}
	return activityshared.NewChildSessionStarted(ctx, child.turnID)
}

func appServerChildTerminalEvents(
	session Session,
	child *codexAppServerThreadContext,
	method string,
	params map[string]any,
) []activityshared.Event {
	ctx, ok := appServerChildEventContext(session, child, strings.TrimSpace(method)+":"+newID())
	if !ok {
		return nil
	}
	switch method {
	case appServerNotifyTurnStarted:
		return []activityshared.Event{activityshared.NewTurnStarted(ctx, child.turnID)}
	case appServerNotifyThreadNameUpdated:
		name := strings.TrimSpace(asString(params["threadName"]))
		if name == "" {
			return nil
		}
		ctx.Title = name
		return []activityshared.Event{activityshared.NewSessionTitleUpdated(ctx)}
	case appServerNotifyTurnCompleted:
		turn := payloadObject(params["turn"])
		status := appServerChildLifecycleStatus(asString(turn["status"]))
		detail := appServerChildFailureDetail(turn)
		return appServerChildSettledEvents(session, child, ctx, status, detail)
	case appServerNotifyError:
		if willRetry, _ := params["willRetry"].(bool); willRetry {
			return nil
		}
		return appServerChildSettledEvents(
			session,
			child,
			ctx,
			"failed",
			appServerChildFailureDetail(payloadObject(params["error"])),
		)
	default:
		return nil
	}
}

func appServerChildSettledEvents(
	session Session,
	child *codexAppServerThreadContext,
	ctx activityshared.EventContext,
	status string,
	detail string,
) []activityshared.Event {
	var events []activityshared.Event
	if child.normalizer == nil {
		child.normalizer = newACPTurnNormalizer()
	}
	switch status {
	case "failed":
		events = child.normalizer.FinishFailed(session, child.turnID)
		terminal := activityshared.NewTurnFailed(ctx, child.turnID)
		if detail != "" {
			terminal.Payload.Metadata = map[string]any{"error": detail}
		}
		return append(events, terminal)
	case "canceled":
		events = child.normalizer.FinishInterrupted(session, child.turnID, "interrupted")
		terminal := activityshared.NewTurnCanceled(ctx, child.turnID)
		if detail != "" {
			terminal.Payload.Metadata = map[string]any{"error": detail}
		}
		return append(events, terminal)
	default:
		events = child.normalizer.FinishCompleted(session, child.turnID)
		return append(events, activityshared.NewTurnCompleted(ctx, child.turnID, activityshared.TurnOutcomeCompleted))
	}
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
