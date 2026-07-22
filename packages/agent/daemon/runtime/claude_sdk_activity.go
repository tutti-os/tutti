package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (s *claudeSDKAdapterSession) applySessionPayload(session *Session, payload map[string]any) {
	if s == nil {
		return
	}
	if providerSessionID := payloadString(payload, "providerSessionId"); providerSessionID != "" {
		s.providerSessionID = providerSessionID
		if session != nil {
			session.ProviderSessionID = providerSessionID
		}
	}
	if resumeCursor := payloadMap(payload, "resumeCursor"); len(resumeCursor) > 0 {
		s.resumeCursor = clonePayload(resumeCursor)
	}
	previousModel := s.currentUsageModel(nil)
	if descriptors := configOptionDescriptors(payload["configOptions"]); len(descriptors) > 0 {
		applyClaudeSDKConfigOptionDescriptors(&s.liveState, descriptors)
	}
	if model := payloadString(payload, "model"); model != "" {
		_ = s.applyConfigOption("model", model)
	}
	s.invalidateContextUsageForModelChange(previousModel, s.currentUsageModel(nil))
}

func (s *claudeSDKAdapterSession) assistantMessageID(turnID string) string {
	if s.assistantMessages == nil {
		s.assistantMessages = make(map[string]string)
	}
	if messageID := s.assistantMessages[turnID]; messageID != "" {
		return messageID
	}
	messageID := "claude-sdk:assistant:" + turnID
	s.assistantMessages[turnID] = messageID
	return messageID
}

func (s *claudeSDKAdapterSession) thinkingMessageID(turnID string) string {
	if s.thinkingMessages == nil {
		s.thinkingMessages = make(map[string]string)
	}
	if messageID := s.thinkingMessages[turnID]; messageID != "" {
		return messageID
	}
	messageID := "claude-sdk:thinking:" + turnID
	s.thinkingMessages[turnID] = messageID
	return messageID
}

func (s *claudeSDKAdapterSession) claudeSDKToolEvents(session Session, turnID string, payload map[string]any, eventType string, status string, sidecarType string) []activityshared.Event {
	turnID = strings.TrimSpace(turnID)
	if s == nil || turnID == "" {
		return nil
	}
	isDelegation := payloadString(payload, "callType") == "subagent"
	if isDelegation {
		toolEvent := claudeSDKToolActivityEvent(session, turnID, payload, eventType, status)
		// The Agent/Task call belongs to the session that launched the child,
		// not to the child it creates. Claude's completed event repeats the
		// spawned child's own tool call id, so resolving the owner from every
		// child alias would move the completion into the new child turn and
		// leave the parent's started call dangling. Only an explicit
		// parentToolUseId identifies a nested delegation owned by another child.
		if parent, ok := s.claudeSDKDelegationParentForPayload(payload); ok {
			toolEvent = claudeSDKToolActivityEvent(claudeSDKChildRuntimeSession(session, parent), parent.TurnID, payload, eventType, status)
			toolEvent = claudeSDKEventForChild(toolEvent, parent)
		}
		events := []activityshared.Event{toolEvent}
		return append(events, s.updateClaudeSDKChildFromTool(session, turnID, payload, eventType, sidecarType)...)
	}
	if child, ok := s.claudeSDKChildForPayload(payload); ok {
		childSession := claudeSDKChildRuntimeSession(session, child)
		event := claudeSDKToolActivityEvent(childSession, child.TurnID, payload, eventType, status)
		return []activityshared.Event{claudeSDKEventForChild(event, child)}
	}
	return []activityshared.Event{claudeSDKToolActivityEvent(session, turnID, payload, eventType, status)}
}

func (s *claudeSDKAdapterSession) claudeSDKTaskLifecycleEvents(session Session, turnID string, sidecarType string, payload map[string]any) []activityshared.Event {
	if s == nil {
		return nil
	}
	child, created, titleChanged, ok := s.updateClaudeSDKChild(session, claudeSDKChildUpdate{
		Key:             firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "agentId"), payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		ParentToolUseID: firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "callId")),
		RootTurnID:      turnID,
		TaskID:          firstNonEmptyString(payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		AgentID:         payloadString(payload, "agentId"),
		Description:     payloadString(payload, "description"),
		Summary:         payloadString(payload, "summary"),
		LastToolName:    firstNonEmptyString(payloadString(payload, "lastToolName"), payloadString(payload, "last_tool_name")),
		Status:          claudeSDKTaskStatus(sidecarType, payloadString(payload, "status")),
		Async:           true,
		Started:         sidecarType == "task_started",
	})
	if !ok {
		return nil
	}
	return claudeSDKChildEvents(session, child, created, titleChanged, sidecarType)
}

func (s *claudeSDKAdapterSession) updateClaudeSDKChildFromTool(session Session, turnID string, payload map[string]any, _ string, sidecarType string) []activityshared.Event {
	metadata := payloadMap(payload, "metadata")
	if payloadString(payload, "callType") != "subagent" {
		return nil
	}
	input := payloadMap(payload, "input")
	parentToolUseID := firstNonEmptyString(payloadString(payload, "toolCallId"), payloadString(payload, "callId"))
	async := metadata["subagentAsync"] == true || payloadBoolValue(input, "run_in_background")
	status := string(activityshared.ActivityStatusRunning)
	if sidecarType == "tool_failed" {
		status = string(activityshared.ActivityStatusFailed)
	} else if sidecarType == "tool_completed" && !async {
		status = string(activityshared.ActivityStatusCompleted)
	}
	child, created, titleChanged, ok := s.updateClaudeSDKChild(session, claudeSDKChildUpdate{
		Key:             firstNonEmptyString(parentToolUseID, payloadString(metadata, "taskId"), payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		ParentToolUseID: parentToolUseID,
		ParentChildKey:  firstNonEmptyString(payloadString(metadata, "parentToolUseId"), payloadString(payload, "parentToolUseId")),
		RootTurnID:      turnID,
		TaskID:          payloadString(metadata, "taskId"),
		AgentID:         firstNonEmptyString(payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		Description:     firstNonEmptyString(payloadString(input, "description"), payloadString(input, "prompt"), payloadString(payload, "name")),
		Summary:         payloadString(payloadMap(payload, "output"), "text"),
		Status:          status,
		Async:           async,
		Started:         true,
	})
	if !ok {
		return nil
	}
	return claudeSDKChildEvents(session, child, created, titleChanged, sidecarType)
}

type claudeSDKChildUpdate struct {
	Key             string
	ParentToolUseID string
	ParentChildKey  string
	RootTurnID      string
	TaskID          string
	AgentID         string
	Description     string
	Status          string
	Summary         string
	LastToolName    string
	Async           bool
	Started         bool
}

func (s *claudeSDKAdapterSession) updateClaudeSDKChild(session Session, update claudeSDKChildUpdate) (claudeSDKChildSession, bool, bool, bool) {
	if s == nil {
		return claudeSDKChildSession{}, false, false, false
	}
	key := strings.TrimSpace(update.Key)
	if key == "" {
		return claudeSDKChildSession{}, false, false, false
	}
	if s.childSessions == nil {
		s.childSessions = make(map[string]claudeSDKChildSession)
	}
	key = s.resolveClaudeSDKChildKey(update, key)
	updatedAt := unixMS(now())
	child := s.childSessions[key]
	created := child.Key == ""
	if created {
		child.Key = key
		child.AgentSessionID = newID()
		child.TurnID = newID()
		if parent := s.claudeSDKChildByKey(update.ParentChildKey); parent.AgentSessionID != "" {
			child.RootAgentSessionID = parent.RootAgentSessionID
			child.RootTurnID = parent.RootTurnID
			child.ParentAgentSessionID = parent.AgentSessionID
			child.ParentTurnID = parent.TurnID
		} else {
			child.RootAgentSessionID = strings.TrimSpace(session.AgentSessionID)
			child.RootTurnID = strings.TrimSpace(update.RootTurnID)
			child.ParentAgentSessionID = strings.TrimSpace(session.AgentSessionID)
			child.ParentTurnID = strings.TrimSpace(update.RootTurnID)
		}
	}
	child.UpdatedAtUnixMS = updatedAt
	if update.ParentToolUseID != "" && (child.ParentToolUseID == "" || child.ParentToolUseID == update.ParentToolUseID) {
		child.ParentToolUseID = update.ParentToolUseID
	}
	if update.TaskID != "" && (child.TaskID == "" || child.TaskID == update.TaskID) && !s.claudeSDKChildAliasBelongsToOtherKey(key, update.TaskID, func(child claudeSDKChildSession) string {
		return child.TaskID
	}) {
		child.TaskID = update.TaskID
	}
	if update.AgentID != "" && (child.AgentID == "" || child.AgentID == update.AgentID) && !s.claudeSDKChildAliasBelongsToOtherKey(key, update.AgentID, func(child claudeSDKChildSession) string {
		return child.AgentID
	}) {
		child.AgentID = update.AgentID
	}
	previousDescription := strings.TrimSpace(child.Description)
	nextDescription := strings.TrimSpace(update.Description)
	titleChanged := nextDescription != "" && nextDescription != previousDescription
	if nextDescription != "" {
		child.Description = nextDescription
	}
	if update.Summary != "" {
		child.Summary = update.Summary
	}
	if update.LastToolName != "" {
		child.LastToolName = update.LastToolName
	}
	child.Async = child.Async || update.Async
	child.Status = firstNonEmptyString(claudeSDKNormalizeTaskStatus(update.Status), child.Status, string(activityshared.ActivityStatusRunning))
	if update.Started && child.StartedAtUnixMS == 0 {
		child.StartedAtUnixMS = updatedAt
	}
	if claudeSDKChildStatusIsTerminal(child.Status) && child.CompletedAtUnixMS == 0 {
		child.CompletedAtUnixMS = updatedAt
	}
	s.childSessions[key] = child
	return child, created, titleChanged && !created, true
}

func (s *claudeSDKAdapterSession) resolveClaudeSDKChildKey(update claudeSDKChildUpdate, fallback string) string {
	parentID := strings.TrimSpace(update.ParentToolUseID)
	if parentID != "" {
		if resolved := s.claudeSDKChildKeyByAlias(parentID); resolved != "" {
			return resolved
		}
		// The Task tool call id is the canonical child-session key. An
		// update that carries one may merge through weaker task/agent aliases
		// only into an entry that does not already belong to a different
		// parent tool call; otherwise a poisoned alias would fold two
		// concurrent child sessions into one entry.
		for _, alias := range []string{update.AgentID, update.TaskID, update.Key} {
			resolved := s.claudeSDKChildKeyByAlias(alias)
			if resolved == "" {
				continue
			}
			existingParent := strings.TrimSpace(s.childSessions[resolved].ParentToolUseID)
			if existingParent == "" || existingParent == parentID {
				return resolved
			}
		}
		return parentID
	}
	keys := []string{
		update.AgentID,
		update.TaskID,
		update.Key,
	}
	for _, key := range keys {
		if resolved := s.claudeSDKChildKeyByAlias(key); resolved != "" {
			return resolved
		}
	}
	return fallback
}

func (s *claudeSDKAdapterSession) claudeSDKChildKeyByAlias(alias string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return ""
	}
	if child := s.childSessions[alias]; child.TurnID != "" || child.Key != "" {
		return alias
	}
	for key, child := range s.childSessions {
		if alias == child.ParentToolUseID || alias == child.AgentID || alias == child.TaskID {
			return key
		}
	}
	return ""
}

func (s *claudeSDKAdapterSession) claudeSDKChildAliasBelongsToOtherKey(currentKey string, alias string, selectAlias func(claudeSDKChildSession) string) bool {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return false
	}
	for key, child := range s.childSessions {
		if key == currentKey {
			continue
		}
		if alias == strings.TrimSpace(selectAlias(child)) {
			return true
		}
	}
	return false
}

func (s *claudeSDKAdapterSession) claudeSDKChildForPayload(payload map[string]any) (claudeSDKChildSession, bool) {
	if s == nil || len(s.childSessions) == 0 {
		return claudeSDKChildSession{}, false
	}
	metadata := payloadMap(payload, "metadata")
	keys := []string{
		payloadString(payload, "taskId"),
		payloadString(payload, "task_id"),
		payloadString(metadata, "taskId"),
		payloadString(payload, "agentId"),
		payloadString(metadata, "agentId"),
		payloadString(metadata, "subagentAgentId"),
		payloadString(metadata, "parentToolUseId"),
		payloadString(payload, "parentToolUseId"),
		payloadString(payload, "toolCallId"),
		payloadString(payload, "callId"),
	}
	for _, key := range keys {
		if child := s.claudeSDKChildByKey(key); child.TurnID != "" {
			return child, true
		}
	}
	return claudeSDKChildSession{}, false
}

func (s *claudeSDKAdapterSession) claudeSDKDelegationParentForPayload(payload map[string]any) (claudeSDKChildSession, bool) {
	if s == nil || len(s.childSessions) == 0 {
		return claudeSDKChildSession{}, false
	}
	metadata := payloadMap(payload, "metadata")
	parentToolUseID := firstNonEmptyString(
		payloadString(metadata, "parentToolUseId"),
		payloadString(payload, "parentToolUseId"),
	)
	if parentToolUseID == "" {
		return claudeSDKChildSession{}, false
	}
	parent := s.claudeSDKChildByKey(parentToolUseID)
	return parent, parent.TurnID != ""
}

func (s *claudeSDKAdapterSession) claudeSDKChildByKey(key string) claudeSDKChildSession {
	key = strings.TrimSpace(key)
	if key == "" || s == nil {
		return claudeSDKChildSession{}
	}
	if resolved := s.claudeSDKChildKeyByAlias(key); resolved != "" {
		return s.childSessions[resolved]
	}
	return claudeSDKChildSession{}
}

func (s *claudeSDKAdapterSession) claudeSDKChildByAgentSessionID(agentSessionID string) (claudeSDKChildSession, bool) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s == nil || agentSessionID == "" {
		return claudeSDKChildSession{}, false
	}
	for _, child := range s.childSessions {
		if child.AgentSessionID == agentSessionID {
			return child, true
		}
	}
	return claudeSDKChildSession{}, false
}

func claudeSDKChildRuntimeSession(root Session, child claudeSDKChildSession) Session {
	root.AgentSessionID = child.AgentSessionID
	root.ProviderSessionID = firstNonEmptyString(child.TaskID, child.AgentID, child.Key)
	root.Title = child.Description
	root.Status = SessionStatusWorking
	root.TurnLifecycle = nil
	root.SubmitAvailability = blockedSubmitAvailability("active_turn")
	return root
}

func claudeSDKChildEventContext(session Session, child claudeSDKChildSession, eventID string) (activityshared.EventContext, bool) {
	ctx, ok := activityEventContext(claudeSDKChildRuntimeSession(session, child), eventID, child.TurnID)
	if !ok {
		return activityshared.EventContext{}, false
	}
	ctx.SessionKind = "child"
	ctx.RootAgentSessionID = child.RootAgentSessionID
	ctx.RootTurnID = child.RootTurnID
	ctx.ParentAgentSessionID = child.ParentAgentSessionID
	ctx.ParentTurnID = child.ParentTurnID
	ctx.ParentToolCallID = child.ParentToolUseID
	return ctx, true
}

func claudeSDKEventForChild(event activityshared.Event, child claudeSDKChildSession) activityshared.Event {
	event.AgentSessionID = child.AgentSessionID
	event.ProviderSessionID = firstNonEmptyString(child.TaskID, child.AgentID, child.Key)
	event.SessionKind = "child"
	event.RootAgentSessionID = child.RootAgentSessionID
	event.RootTurnID = child.RootTurnID
	event.ParentAgentSessionID = child.ParentAgentSessionID
	event.ParentTurnID = child.ParentTurnID
	event.ParentToolCallID = child.ParentToolUseID
	return event
}

func claudeSDKChildEvents(session Session, child claudeSDKChildSession, created bool, titleChanged bool, sidecarType string) []activityshared.Event {
	baseEventID := "claude-child:" + child.Key + ":" + sidecarType + ":" + newID()
	ctx, ok := claudeSDKChildEventContext(session, child, baseEventID)
	if !ok {
		return nil
	}
	eventContext := func(suffix string) activityshared.EventContext {
		next := ctx
		next.EventID = baseEventID + ":" + suffix
		return next
	}
	events := make([]activityshared.Event, 0, 4)
	if created {
		sessionContext := eventContext("session-started")
		sessionContext.Title = child.Description
		events = append(events, activityshared.NewChildSessionStarted(sessionContext, child.TurnID))
	} else if titleChanged {
		titleContext := eventContext("session-title-updated")
		titleContext.Title = child.Description
		events = append(events, activityshared.NewSessionTitleUpdated(titleContext))
	}
	metadata := claudeSDKChildMetadata(child)
	activityKey := "claude-sdk-child:" + child.Key
	switch sidecarType {
	case "task_started":
		if created {
			events = append(events, activityshared.NewTurnStarted(eventContext("turn-started"), child.TurnID))
		}
		events = append(events, activityshared.NewActivityStarted(eventContext("activity-started"), activityKey, metadata))
	case "task_progress":
		events = append(events, activityshared.NewTurnUpdated(eventContext("turn-updated"), child.TurnID, activityshared.TurnPhaseWorking))
		events = append(events, activityshared.NewActivityUpdated(eventContext("activity-updated"), activityKey, metadata))
	case "task_completed":
		switch claudeSDKNormalizeTaskStatus(child.Status) {
		case string(activityshared.ActivityStatusFailed):
			events = append(events, activityshared.NewActivityFailed(eventContext("activity-failed"), activityKey, metadata))
			events = append(events, activityshared.NewTurnFailed(eventContext("turn-failed"), child.TurnID))
		case "stopped":
			events = append(events, activityshared.NewActivityCompleted(eventContext("activity-completed"), activityKey, metadata))
			events = append(events, activityshared.NewTurnCanceled(eventContext("turn-canceled"), child.TurnID))
		default:
			events = append(events, activityshared.NewActivityCompleted(eventContext("activity-completed"), activityKey, metadata))
			events = append(events, activityshared.NewTurnCompleted(eventContext("turn-completed"), child.TurnID, activityshared.TurnOutcomeCompleted))
		}
	case "tool_started", "tool_updated":
		if created {
			events = append(events, activityshared.NewTurnStarted(eventContext("turn-started"), child.TurnID))
		}
	case "tool_completed":
		if created {
			events = append(events, activityshared.NewTurnStarted(eventContext("turn-started"), child.TurnID))
		}
		if !child.Async {
			events = append(events, activityshared.NewTurnCompleted(eventContext("turn-completed"), child.TurnID, activityshared.TurnOutcomeCompleted))
		}
	case "tool_failed":
		if created {
			events = append(events, activityshared.NewTurnStarted(eventContext("turn-started"), child.TurnID))
		}
		events = append(events, activityshared.NewTurnFailed(eventContext("turn-failed"), child.TurnID))
	}
	for index := range events {
		events[index] = claudeSDKEventForChild(events[index], child)
	}
	return events
}

func claudeSDKChildStatusIsTerminal(status string) bool {
	switch claudeSDKNormalizeTaskStatus(status) {
	case string(activityshared.ActivityStatusCompleted), string(activityshared.ActivityStatusFailed), "stopped":
		return true
	default:
		return false
	}
}

func claudeSDKChildMetadata(child claudeSDKChildSession) map[string]any {
	metadata := map[string]any{
		"kind":        "child_agent",
		"taskId":      firstNonEmptyString(child.TaskID, child.Key),
		"description": child.Description,
		"status":      firstNonEmptyString(child.Status, string(activityshared.ActivityStatusRunning)),
		"title":       child.Description,
	}
	if child.ParentToolUseID != "" {
		metadata["parentToolUseId"] = child.ParentToolUseID
	}
	if child.AgentID != "" {
		metadata["agentId"] = child.AgentID
	}
	if child.Summary != "" {
		metadata["summary"] = child.Summary
	}
	if child.LastToolName != "" {
		metadata["lastToolName"] = child.LastToolName
	}
	if child.StartedAtUnixMS > 0 {
		metadata["startedAtUnixMs"] = child.StartedAtUnixMS
	}
	if child.UpdatedAtUnixMS > 0 {
		metadata["updatedAtUnixMs"] = child.UpdatedAtUnixMS
	}
	if child.CompletedAtUnixMS > 0 {
		metadata["completedAtUnixMs"] = child.CompletedAtUnixMS
	}
	return metadata
}

func claudeSDKTaskStatus(sidecarType string, status string) string {
	if normalized := claudeSDKNormalizeTaskStatus(status); normalized != "" {
		return normalized
	}
	switch sidecarType {
	case "task_completed":
		return string(activityshared.ActivityStatusCompleted)
	default:
		return string(activityshared.ActivityStatusRunning)
	}
}

func claudeSDKNormalizeTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "error", "errored":
		return string(activityshared.ActivityStatusFailed)
	case "completed", "done", "success", "succeeded":
		return string(activityshared.ActivityStatusCompleted)
	case "stopped", "cancelled", "canceled":
		return "stopped"
	case "running", "in_progress", "pending":
		return string(activityshared.ActivityStatusRunning)
	default:
		return strings.TrimSpace(status)
	}
}

// claudeSDKPlanEvents maps the sidecar's plan_updated entries (SDK task list)
// onto the same synthesized update_todo tool call codex publishes for plan
// updates, so the GUI plan rendering works identically across providers.
func claudeSDKPlanEvents(session Session, turnID string, payload map[string]any) []activityshared.Event {
	entries, _ := payload["entries"].([]any)
	if len(entries) == 0 || strings.TrimSpace(turnID) == "" {
		return nil
	}
	todos := make([]any, 0, len(entries))
	for _, entry := range entries {
		item := payloadObject(entry)
		text := asStringRaw(item["content"])
		if text == "" {
			continue
		}
		todos = append(todos, map[string]any{
			"content": text,
			"status":  appServerItemStatus(asString(item["status"])),
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return []activityshared.Event{claudeSDKToolActivityEvent(session, turnID, map[string]any{
		"toolCallId": "plan:" + strings.TrimSpace(turnID),
		"name":       "update_todo",
		"input":      map[string]any{"todos": todos},
		"metadata":   map[string]any{"kind": "think"},
	}, EventCallCompleted, messageStreamStateCompleted)}
}

func claudeSDKToolActivityEvent(session Session, turnID string, payload map[string]any, eventType string, status string) activityshared.Event {
	payload = normalizeClaudeSDKToolPayload(payload)
	callID := firstNonEmpty(
		payloadString(payload, "toolCallId"),
		payloadString(payload, "callId"),
		payloadString(payload, "id"),
		newID(),
	)
	name := firstNonEmpty(payloadString(payload, "name"), payloadString(payload, "toolName"), callID)
	metadata := map[string]any{
		"adapter":  claudeSDKSidecarAdapterName,
		"callId":   callID,
		"callType": firstNonEmpty(payloadString(payload, "callType"), "tool"),
		"name":     name,
		"status":   status,
	}
	if toolName := payloadString(payload, "toolName"); toolName != "" {
		metadata["toolName"] = toolName
	}
	if input := payloadMap(payload, "input"); len(input) > 0 {
		metadata["input"] = input
	}
	if output := payloadMap(payload, "output"); len(output) > 0 {
		metadata["output"] = output
	}
	if errorPayload := payloadMap(payload, "error"); len(errorPayload) > 0 {
		metadata["error"] = errorPayload
	}
	if locations, ok := payload["locations"].([]any); ok && len(locations) > 0 {
		metadata["locations"] = locations
	}
	if content, ok := payload["content"].([]any); ok && len(content) > 0 {
		metadata["content"] = content
	}
	if sidecarMetadata := payloadMap(payload, "metadata"); len(sidecarMetadata) > 0 {
		metadata["metadata"] = sidecarMetadata
		if parentToolUseID := payloadString(sidecarMetadata, "parentToolUseId"); parentToolUseID != "" {
			metadata["parentToolUseId"] = parentToolUseID
		}
		if toolResponse := payloadMap(sidecarMetadata, "claudeToolResponse"); len(toolResponse) > 0 {
			metadata["claudeToolResponse"] = toolResponse
		}
	}
	body := map[string]any(nil)
	switch eventType {
	case EventCallCompleted:
		body = payloadMap(payload, "output")
	case EventCallFailed:
		body = payloadMap(payload, "error")
	default:
		body = payloadMap(payload, "input")
	}
	return newTurnActivityEventWithID(session, "claude-sdk:tool:"+callID, eventType, turnID, status, "", name, payloadWithCallBody(claudeSDKCallBodyKey(eventType), body, metadata))
}

func normalizeClaudeSDKToolPayload(payload map[string]any) map[string]any {
	normalized, _ := normalizeClaudeSDKToolPayloadValue(payload, "").(map[string]any)
	return normalized
}

func normalizeClaudeSDKToolPayloadValue(value any, field string) any {
	switch typed := value.(type) {
	case map[string]any:
		normalized := make(map[string]any, len(typed))
		for key, entry := range typed {
			normalized[key] = normalizeClaudeSDKToolPayloadValue(entry, key)
		}
		return normalized
	case []any:
		normalized := make([]any, len(typed))
		for index, entry := range typed {
			normalized[index] = normalizeClaudeSDKToolPayloadValue(entry, field)
		}
		return normalized
	case string:
		if !claudeSDKDiffField(field) {
			return typed
		}
		return normalizeClaudeSDKUnifiedDiff(typed)
	default:
		return value
	}
}

func claudeSDKDiffField(field string) bool {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "diff", "patch", "unifieddiff", "unified_diff":
		return true
	default:
		return false
	}
}

func normalizeClaudeSDKUnifiedDiff(diff string) string {
	const noNewlineMarker = `\ No newline at end of file`
	lines := strings.Split(strings.ReplaceAll(diff, "\r\n", "\n"), "\n")
	for index, line := range lines {
		if strings.TrimLeft(line, " \t") == noNewlineMarker {
			lines[index] = noNewlineMarker
		}
	}
	return strings.Join(lines, "\n")
}

func claudeSDKCallBodyKey(eventType string) string {
	switch eventType {
	case EventCallCompleted:
		return "output"
	case EventCallFailed:
		return "error"
	default:
		return "input"
	}
}

func (a *ClaudeCodeSDKAdapter) compactMessageEvent(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	streamState string,
	noticeStatus string,
	detail string,
) (activityshared.Event, bool) {
	a.mu.Lock()
	compact := adapterSession.compactMessages[turnID]
	if compact.messageID == "" {
		compact.messageID = "claude-sdk:compact:" + turnID
	}
	if compact.terminalStatus != "" {
		a.mu.Unlock()
		return activityshared.Event{}, false
	}
	if noticeStatus == "running" {
		compact.active = true
	} else {
		compact.active = false
		compact.terminalStatus = noticeStatus
	}
	if adapterSession.compactMessages == nil {
		adapterSession.compactMessages = make(map[string]claudeSDKCompactMessage)
	}
	adapterSession.compactMessages[turnID] = compact
	a.mu.Unlock()
	return claudeSDKCompactMessageEvent(session, turnID, compact.messageID, streamState, noticeStatus, detail), true
}

func claudeSDKCompactMessageEvent(
	session Session,
	turnID string,
	messageID string,
	streamState string,
	noticeStatus string,
	detail string,
) activityshared.Event {
	title := appServerCompactingContextTitle
	if noticeStatus == "completed" {
		title = appServerContextCompactedTitle
	}
	if noticeStatus == "failed" || noticeStatus == "canceled" {
		title = appServerCompactionInterruptedTitle
	}
	metadata := map[string]any{
		"adapter":             claudeSDKSidecarAdapterName,
		"messageId":           messageID,
		"contentMode":         messageContentModeSnapshot,
		"source":              "compact",
		"kind":                "agent_system_notice",
		"noticeKind":          "system_notice",
		"noticeCommand":       "compact",
		"noticeCommandStatus": noticeStatus,
		"title":               title,
	}
	if strings.TrimSpace(detail) != "" {
		metadata["detail"] = strings.TrimSpace(detail)
	}
	return newTurnActivityEventWithID(session, messageID, EventMessage, turnID, streamState, RoleAssistant, title, metadata)
}
