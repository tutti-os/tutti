package agentruntime

import (
	"sort"
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
	if descriptors := configOptionDescriptors(payload["configOptions"]); len(descriptors) > 0 {
		applyClaudeSDKConfigOptionDescriptors(&s.liveState, descriptors)
	}
	if model := payloadString(payload, "model"); model != "" {
		_ = s.applyConfigOption("model", model)
	}
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
	if s == nil {
		if strings.TrimSpace(turnID) == "" {
			return nil
		}
		return []activityshared.Event{claudeSDKToolActivityEvent(session, turnID, payload, eventType, status)}
	}
	effectiveTurnID := s.backgroundAgentTurnID(payload, turnID)
	var events []activityshared.Event
	if strings.TrimSpace(effectiveTurnID) != "" {
		events = append(events, claudeSDKToolActivityEvent(session, effectiveTurnID, payload, eventType, status))
	}
	backgroundEvents := s.updateClaudeSDKBackgroundAgentFromTool(session, turnID, payload, eventType, sidecarType)
	return append(events, backgroundEvents...)
}

func (s *claudeSDKAdapterSession) claudeSDKTaskLifecycleEvents(session Session, turnID string, sidecarType string, payload map[string]any) []activityshared.Event {
	if s == nil {
		return nil
	}
	agent, runtimeContext, ok := s.updateClaudeSDKBackgroundAgent(claudeSDKBackgroundAgentUpdate{
		Key:             firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "agentId"), payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		ParentToolUseID: firstNonEmptyString(payloadString(payload, "parentToolUseId"), payloadString(payload, "toolCallId"), payloadString(payload, "callId")),
		TurnID:          turnID,
		TaskID:          firstNonEmptyString(payloadString(payload, "taskId"), payloadString(payload, "task_id")),
		AgentID:         payloadString(payload, "agentId"),
		Description:     payloadString(payload, "description"),
		Summary:         payloadString(payload, "summary"),
		LastToolName:    firstNonEmptyString(payloadString(payload, "lastToolName"), payloadString(payload, "last_tool_name")),
		Status:          claudeSDKTaskStatus(sidecarType, payloadString(payload, "status")),
		Started:         sidecarType == "task_started",
	})
	if !ok {
		return nil
	}
	return claudeSDKBackgroundAgentEvents(session, agent, runtimeContext, sidecarType)
}

func (s *claudeSDKAdapterSession) updateClaudeSDKBackgroundAgentFromTool(session Session, turnID string, payload map[string]any, eventType string, sidecarType string) []activityshared.Event {
	metadata := payloadMap(payload, "metadata")
	if payloadString(payload, "callType") != "subagent" && metadata["subagentAsync"] != true {
		return nil
	}
	if metadata["subagentAsync"] != true {
		return nil
	}
	input := payloadMap(payload, "input")
	parentToolUseID := firstNonEmptyString(payloadString(payload, "toolCallId"), payloadString(payload, "callId"))
	status := firstNonEmptyString(payloadString(metadata, "subagentStatus"), payloadString(metadata, "taskStatus"))
	if status == "" {
		switch eventType {
		case EventCallFailed:
			status = string(activityshared.ActivityStatusFailed)
		default:
			status = string(activityshared.ActivityStatusRunning)
		}
	}
	agent, runtimeContext, ok := s.updateClaudeSDKBackgroundAgent(claudeSDKBackgroundAgentUpdate{
		Key:             firstNonEmptyString(parentToolUseID, payloadString(metadata, "taskId"), payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		ParentToolUseID: parentToolUseID,
		TurnID:          turnID,
		TaskID:          payloadString(metadata, "taskId"),
		AgentID:         firstNonEmptyString(payloadString(metadata, "agentId"), payloadString(metadata, "subagentAgentId")),
		Description:     firstNonEmptyString(payloadString(input, "description"), payloadString(input, "prompt"), payloadString(payload, "name")),
		Summary:         payloadString(payloadMap(payload, "output"), "text"),
		Status:          claudeSDKNormalizeTaskStatus(status),
		Started:         true,
	})
	if !ok {
		return nil
	}
	return claudeSDKBackgroundAgentEvents(session, agent, runtimeContext, sidecarType)
}

type claudeSDKBackgroundAgentUpdate struct {
	Key             string
	ParentToolUseID string
	TurnID          string
	TaskID          string
	AgentID         string
	Description     string
	Status          string
	Summary         string
	LastToolName    string
	Started         bool
}

func (s *claudeSDKAdapterSession) updateClaudeSDKBackgroundAgent(update claudeSDKBackgroundAgentUpdate) (claudeSDKBackgroundAgent, map[string]any, bool) {
	if s == nil {
		return claudeSDKBackgroundAgent{}, nil, false
	}
	key := strings.TrimSpace(update.Key)
	if key == "" {
		return claudeSDKBackgroundAgent{}, nil, false
	}
	if s.backgroundAgents == nil {
		s.backgroundAgents = make(map[string]claudeSDKBackgroundAgent)
	}
	key = s.resolveClaudeSDKBackgroundAgentKey(update, key)
	updatedAt := unixMS(now())
	agent := s.backgroundAgents[key]
	if agent.Key == "" {
		agent.Key = key
	}
	agent.UpdatedAtUnixMS = updatedAt
	if update.ParentToolUseID != "" && (agent.ParentToolUseID == "" || agent.ParentToolUseID == update.ParentToolUseID) {
		agent.ParentToolUseID = update.ParentToolUseID
	}
	if update.TurnID != "" {
		agent.TurnID = update.TurnID
	}
	if update.TaskID != "" && (agent.TaskID == "" || agent.TaskID == update.TaskID) && !s.backgroundAgentAliasBelongsToOtherKey(key, update.TaskID, func(agent claudeSDKBackgroundAgent) string {
		return agent.TaskID
	}) {
		agent.TaskID = update.TaskID
	}
	if update.AgentID != "" && (agent.AgentID == "" || agent.AgentID == update.AgentID) && !s.backgroundAgentAliasBelongsToOtherKey(key, update.AgentID, func(agent claudeSDKBackgroundAgent) string {
		return agent.AgentID
	}) {
		agent.AgentID = update.AgentID
	}
	if update.Description != "" {
		agent.Description = update.Description
	}
	if update.Summary != "" {
		agent.Summary = update.Summary
	}
	if update.LastToolName != "" {
		agent.LastToolName = update.LastToolName
	}
	agent.Status = firstNonEmptyString(claudeSDKNormalizeTaskStatus(update.Status), agent.Status, string(activityshared.ActivityStatusRunning))
	if update.Started && agent.StartedAtUnixMS == 0 {
		agent.StartedAtUnixMS = updatedAt
	}
	if backgroundAgentStatusIsTerminal(agent.Status) && agent.CompletedAtUnixMS == 0 {
		agent.CompletedAtUnixMS = updatedAt
	}
	s.backgroundAgents[key] = agent
	return agent, claudeSDKBackgroundAgentsRuntimeContext(s.backgroundAgents), true
}

func (s *claudeSDKAdapterSession) resolveClaudeSDKBackgroundAgentKey(update claudeSDKBackgroundAgentUpdate, fallback string) string {
	parentID := strings.TrimSpace(update.ParentToolUseID)
	if parentID != "" {
		if resolved := s.backgroundAgentKeyByAlias(parentID); resolved != "" {
			return resolved
		}
		// The Agent tool call id is the canonical background-agent key. An
		// update that carries one may merge through weaker task/agent aliases
		// only into an entry that does not already belong to a different
		// parent tool call; otherwise a poisoned alias would fold two
		// concurrent background agents into one entry.
		for _, alias := range []string{update.AgentID, update.TaskID, update.Key} {
			resolved := s.backgroundAgentKeyByAlias(alias)
			if resolved == "" {
				continue
			}
			existingParent := strings.TrimSpace(s.backgroundAgents[resolved].ParentToolUseID)
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
		if resolved := s.backgroundAgentKeyByAlias(key); resolved != "" {
			return resolved
		}
	}
	return fallback
}

func (s *claudeSDKAdapterSession) backgroundAgentKeyByAlias(alias string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return ""
	}
	if agent := s.backgroundAgents[alias]; agent.TurnID != "" || agent.Key != "" {
		return alias
	}
	for key, agent := range s.backgroundAgents {
		if alias == agent.ParentToolUseID || alias == agent.AgentID || alias == agent.TaskID {
			return key
		}
	}
	return ""
}

func (s *claudeSDKAdapterSession) backgroundAgentAliasBelongsToOtherKey(currentKey string, alias string, selectAlias func(claudeSDKBackgroundAgent) string) bool {
	alias = strings.TrimSpace(alias)
	if alias == "" || s == nil {
		return false
	}
	for key, agent := range s.backgroundAgents {
		if key == currentKey {
			continue
		}
		if alias == strings.TrimSpace(selectAlias(agent)) {
			return true
		}
	}
	return false
}

func (s *claudeSDKAdapterSession) backgroundAgentTurnID(payload map[string]any, turnID string) string {
	turnID = strings.TrimSpace(turnID)
	if turnID != "" || s == nil || len(s.backgroundAgents) == 0 {
		return turnID
	}
	metadata := payloadMap(payload, "metadata")
	keys := []string{
		payloadString(payload, "taskId"),
		payloadString(payload, "task_id"),
		payloadString(metadata, "taskId"),
		payloadString(payload, "agentId"),
		payloadString(metadata, "agentId"),
		payloadString(metadata, "subagentAgentId"),
		payloadString(payload, "parentToolUseId"),
		payloadString(payload, "toolCallId"),
		payloadString(payload, "callId"),
	}
	for _, key := range keys {
		if agent := s.backgroundAgentByKey(key); agent.TurnID != "" {
			return agent.TurnID
		}
	}
	return ""
}

func (s *claudeSDKAdapterSession) backgroundAgentByKey(key string) claudeSDKBackgroundAgent {
	key = strings.TrimSpace(key)
	if key == "" || s == nil {
		return claudeSDKBackgroundAgent{}
	}
	if resolved := s.backgroundAgentKeyByAlias(key); resolved != "" {
		return s.backgroundAgents[resolved]
	}
	return claudeSDKBackgroundAgent{}
}

func claudeSDKBackgroundAgentEvents(session Session, agent claudeSDKBackgroundAgent, runtimeContext map[string]any, sidecarType string) []activityshared.Event {
	turnID := strings.TrimSpace(agent.TurnID)
	ctx, ok := activityEventContext(session, newID(), turnID)
	if !ok {
		return []activityshared.Event{claudeSDKBackgroundAgentsSessionEvent(session, runtimeContext)}
	}
	metadata := claudeSDKBackgroundAgentMetadata(agent)
	activityKey := "claude-sdk-background-agent:" + agent.Key
	var event activityshared.Event
	switch {
	case strings.EqualFold(agent.Status, string(activityshared.ActivityStatusFailed)):
		event = activityshared.NewActivityFailed(ctx, activityKey, metadata)
	case backgroundAgentStatusIsTerminal(agent.Status):
		event = activityshared.NewActivityCompleted(ctx, activityKey, metadata)
	case sidecarType == "task_started" || sidecarType == "tool_completed":
		event = activityshared.NewActivityStarted(ctx, activityKey, metadata)
	default:
		event = activityshared.NewActivityUpdated(ctx, activityKey, metadata)
	}
	return []activityshared.Event{event, claudeSDKBackgroundAgentsSessionEvent(session, runtimeContext)}
}

func claudeSDKBackgroundAgentsSessionEvent(session Session, runtimeContext map[string]any) activityshared.Event {
	return newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
		"runtimeContext": map[string]any{
			"backgroundAgents": runtimeContext,
		},
	})
}

func claudeSDKBackgroundAgentsRuntimeContext(value map[string]claudeSDKBackgroundAgent) map[string]any {
	if len(value) == 0 {
		return nil
	}
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	items := make([]any, 0, len(keys))
	runningCount := 0
	for _, key := range keys {
		agent := value[key]
		status := firstNonEmptyString(strings.TrimSpace(agent.Status), string(activityshared.ActivityStatusRunning))
		if !backgroundAgentStatusIsTerminal(status) {
			runningCount++
		}
		item := map[string]any{
			"taskId":      firstNonEmptyString(agent.TaskID, agent.Key),
			"description": agent.Description,
			"status":      status,
		}
		if agent.ParentToolUseID != "" {
			item["parentToolUseId"] = agent.ParentToolUseID
		}
		if agent.AgentID != "" {
			item["agentId"] = agent.AgentID
		}
		if agent.Summary != "" {
			item["summary"] = agent.Summary
		}
		if agent.LastToolName != "" {
			item["lastToolName"] = agent.LastToolName
		}
		if agent.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = agent.StartedAtUnixMS
		}
		if agent.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
		}
		if agent.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = agent.CompletedAtUnixMS
		}
		items = append(items, item)
	}
	return map[string]any{
		"count": runningCount,
		"items": items,
	}
}

func claudeSDKBackgroundAgentMetadata(agent claudeSDKBackgroundAgent) map[string]any {
	metadata := map[string]any{
		"kind":        "background_agent",
		"taskId":      firstNonEmptyString(agent.TaskID, agent.Key),
		"description": agent.Description,
		"status":      firstNonEmptyString(agent.Status, string(activityshared.ActivityStatusRunning)),
		"title":       firstNonEmptyString(agent.Description, "Background agent"),
	}
	if agent.ParentToolUseID != "" {
		metadata["parentToolUseId"] = agent.ParentToolUseID
	}
	if agent.AgentID != "" {
		metadata["agentId"] = agent.AgentID
	}
	if agent.Summary != "" {
		metadata["summary"] = agent.Summary
	}
	if agent.LastToolName != "" {
		metadata["lastToolName"] = agent.LastToolName
	}
	if agent.StartedAtUnixMS > 0 {
		metadata["startedAtUnixMs"] = agent.StartedAtUnixMS
	}
	if agent.UpdatedAtUnixMS > 0 {
		metadata["updatedAtUnixMs"] = agent.UpdatedAtUnixMS
	}
	if agent.CompletedAtUnixMS > 0 {
		metadata["completedAtUnixMs"] = agent.CompletedAtUnixMS
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

func (s *claudeSDKAdapterSession) compactMessageEvent(session Session, turnID string, streamState string, content string) activityshared.Event {
	if s.compactMessages == nil {
		s.compactMessages = make(map[string]string)
	}
	messageID := s.compactMessages[turnID]
	if messageID == "" {
		messageID = "claude-sdk:compact:" + turnID
		s.compactMessages[turnID] = messageID
	}
	return newTurnActivityEventWithID(session, messageID, EventMessage, turnID, streamState, RoleAssistant, content, map[string]any{
		"adapter":     claudeSDKSidecarAdapterName,
		"messageId":   messageID,
		"contentMode": messageContentModeSnapshot,
		"source":      "compact",
	})
}
