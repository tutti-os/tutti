//revive:disable:file-length-limit
//nolint:unused // Retain migrated helpers until the next agent-daemon decomposition pass.
package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

const WorkspaceAgentSessionOriginRuntime = "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"

var defaultReportRetryBackoff = []time.Duration{200 * time.Millisecond, 500 * time.Millisecond, time.Second}

type ActivityReporter interface {
	Report(context.Context, agentsessionstore.ReportActivityInput) error
}

type ActivityClient interface {
	ReportSessionState(context.Context, agentsessionstore.ReportSessionStateInput) (agentsessionstore.ReportSessionStateReply, error)
	ReportSessionMessages(context.Context, agentsessionstore.ReportSessionMessagesInput) (agentsessionstore.ReportSessionMessagesReply, error)
}

type Reporter struct {
	ClientProvider func() ActivityClient
	Logger         *slog.Logger
	MaxAttempts    int
	Backoff        []time.Duration
}

func (r Reporter) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if len(input.TimelineItems) == 0 && len(input.StatePatches) == 0 && len(input.MessageUpdates) == 0 {
		return nil
	}
	input.Source.SessionOrigin = agentsessionstore.WorkspaceAgentSessionOriginRuntime
	if input.Connector == nil && strings.TrimSpace(input.Source.Provider) != "" {
		input.Connector = &agentsessionstore.ConnectorInfo{
			ID:      strings.TrimSpace(input.Source.Provider),
			Version: "agent-gui-runtime",
		}
	}
	if r.ClientProvider == nil {
		err := errors.New("agent session activity client provider is nil")
		r.logReportFailure(input, 1, 1, agentsessionstore.ReportActivityReply{}, err)
		return err
	}
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(input)
	r.logger().Debug(
		"agent session activity report prepared",
		"event", "agent_session.activity_report.prepared",
		"room_id", input.WorkspaceID,
		"agent_session_id", input.Source.AgentID,
		"provider", input.Source.Provider,
		"provider_session_id", input.Source.ProviderSessionID,
		"timeline_item_count", len(input.TimelineItems),
		"state_patch_count", len(input.StatePatches),
		"message_update_count", len(input.MessageUpdates),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
	)

	maxAttempts := r.maxAttempts()
	var lastErr error
	var lastReply agentsessionstore.ReportActivityReply
	lastAttempt := 0
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		lastAttempt = attempt
		client := r.ClientProvider()
		if client == nil {
			lastErr = errors.New("agent session activity client is nil")
		} else {
			lastReply, lastErr = reportSessionActivity(ctx, client, input)
			if lastErr == nil {
				lastErr = validateReportActivityAccepted(input, lastReply)
			}
		}
		if lastErr == nil {
			if attempt > 1 {
				r.logger().Info(
					"agent session activity report succeeded after retry",
					"event", "agent_session.activity_report.succeeded_after_retry",
					"room_id", input.WorkspaceID,
					"agent_session_id", input.Source.AgentID,
					"provider", input.Source.Provider,
					"provider_session_id", input.Source.ProviderSessionID,
					"timeline_item_count", len(input.TimelineItems),
					"state_patch_count", len(input.StatePatches),
					"message_update_count", len(input.MessageUpdates),
					"timeline_items", timelineItemsForLog,
					"state_patches", statePatchesForLog,
					"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
					"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
					"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
					"attempt", attempt,
					"max_attempts", maxAttempts,
				)
			}
			r.logger().Debug(
				"agent session activity report succeeded",
				"event", "agent_session.activity_report.succeeded",
				"room_id", input.WorkspaceID,
				"agent_session_id", input.Source.AgentID,
				"provider", input.Source.Provider,
				"provider_session_id", input.Source.ProviderSessionID,
				"timeline_item_count", len(input.TimelineItems),
				"state_patch_count", len(input.StatePatches),
				"message_update_count", len(input.MessageUpdates),
				"timeline_items", timelineItemsForLog,
				"state_patches", statePatchesForLog,
				"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
				"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
				"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
				"attempt", attempt,
				"max_attempts", maxAttempts,
			)
			return nil
		}

		if attempt >= maxAttempts {
			break
		}
		r.logger().Warn(
			"agent session activity report failed; retrying",
			"event", "agent_session.activity_report.retry",
			"room_id", input.WorkspaceID,
			"agent_session_id", input.Source.AgentID,
			"provider", input.Source.Provider,
			"provider_session_id", input.Source.ProviderSessionID,
			"timeline_item_count", len(input.TimelineItems),
			"state_patch_count", len(input.StatePatches),
			"message_update_count", len(input.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
			"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
			"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
			"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
			"attempt", attempt,
			"max_attempts", maxAttempts,
			"error", lastErr,
		)
		if err := sleepWithContext(ctx, r.backoffForAttempt(attempt)); err != nil {
			lastErr = fmt.Errorf("agent session activity report retry canceled after attempt %d: %w", attempt, err)
			break
		}
	}

	r.logReportFailure(input, lastAttempt, maxAttempts, lastReply, lastErr)
	return lastErr
}

func reportSessionActivity(
	ctx context.Context,
	client ActivityClient,
	input agentsessionstore.ReportActivityInput,
) (agentsessionstore.ReportActivityReply, error) {
	return agentsessionstore.ReportActivityAsSessionUpdates(ctx, client, input)
}

type sessionMessageUpdateGroup struct {
	agentSessionID string
	updates        []agentsessionstore.WorkspaceAgentSessionMessageUpdate
}

func groupMessageUpdatesBySession(source agentsessionstore.EventSource, updates []agentsessionstore.WorkspaceAgentMessageUpdate) []sessionMessageUpdateGroup {
	if len(updates) == 0 {
		return nil
	}
	indexBySession := make(map[string]int)
	groups := make([]sessionMessageUpdateGroup, 0)
	for _, update := range updates {
		agentSessionID := firstNonEmptyString(update.AgentSessionID, source.AgentID, source.ProviderSessionID)
		if agentSessionID == "" {
			continue
		}
		converted := sessionMessageUpdateFromActivityMessageUpdate(update)
		if strings.TrimSpace(converted.MessageID) == "" {
			continue
		}
		index, ok := indexBySession[agentSessionID]
		if !ok {
			index = len(groups)
			indexBySession[agentSessionID] = index
			groups = append(groups, sessionMessageUpdateGroup{agentSessionID: agentSessionID})
		}
		groups[index].updates = append(groups[index].updates, converted)
	}
	return groups
}

func sessionMessageUpdateFromActivityMessageUpdate(update agentsessionstore.WorkspaceAgentMessageUpdate) agentsessionstore.WorkspaceAgentSessionMessageUpdate {
	payload := clonePayload(update.Payload)
	if payload == nil {
		payload = map[string]any{}
	}
	if update.Seq > 0 {
		payload["seq"] = update.Seq
	}
	if update.CallID != "" {
		payload["callId"] = strings.TrimSpace(update.CallID)
	}
	if update.ParentCallID != "" {
		payload["parentCallId"] = strings.TrimSpace(update.ParentCallID)
	}
	if update.RootCallID != "" {
		payload["rootCallId"] = strings.TrimSpace(update.RootCallID)
	}
	if update.Title != "" {
		payload["title"] = strings.TrimSpace(update.Title)
	}
	if len(payload) == 0 {
		payload = nil
	}
	return agentsessionstore.WorkspaceAgentSessionMessageUpdate{
		MessageID:         strings.TrimSpace(update.MessageID),
		TurnID:            strings.TrimSpace(update.TurnID),
		Role:              strings.TrimSpace(update.Role),
		Kind:              strings.TrimSpace(update.Kind),
		Status:            strings.TrimSpace(update.Status),
		Semantics:         cloneMessageSemantics(update.Semantics),
		Payload:           payload,
		OccurredAtUnixMS:  update.OccurredAtUnixMS,
		StartedAtUnixMS:   update.StartedAtUnixMS,
		CompletedAtUnixMS: update.CompletedAtUnixMS,
	}
}

func sessionStateUpdateFromStatePatch(patch agentsessionstore.WorkspaceAgentStatePatch) agentsessionstore.WorkspaceAgentSessionStateUpdate {
	out := agentsessionstore.WorkspaceAgentSessionStateUpdate{
		Provider:           strings.TrimSpace(patch.Provider),
		ProviderSessionID:  strings.TrimSpace(patch.ProviderSessionID),
		Model:              strings.TrimSpace(patch.Model),
		Settings:           clonePayload(patch.Settings),
		RuntimeContext:     clonePayload(patch.RuntimeContext),
		TurnLifecycle:      cloneTurnLifecycle(patch.TurnLifecycle),
		SubmitAvailability: cloneSubmitAvailability(patch.SubmitAvailability),
		PendingInteractive: cloneInteractivePrompt(patch.PendingInteractive),
		CWD:                strings.TrimSpace(patch.CWD),
		Title:              strings.TrimSpace(patch.Title),
		LifecycleStatus:    strings.TrimSpace(patch.LifecycleStatus),
		CurrentPhase:       strings.TrimSpace(patch.CurrentPhase),
		LastError:          strings.TrimSpace(patch.LastError),
		OccurredAtUnixMS:   patch.OccurredAtUnixMS,
	}
	if patch.Turn != nil {
		out.Turn = &agentsessionstore.WorkspaceAgentTurnStateUpdate{
			TurnID:             strings.TrimSpace(patch.Turn.TurnID),
			ActiveTurnID:       cloneStringPointer(patch.Turn.ActiveTurnID),
			Phase:              strings.TrimSpace(patch.Turn.Phase),
			Outcome:            strings.TrimSpace(patch.Turn.Outcome),
			Settling:           patch.Turn.Settling,
			CompletedCommand:   cloneCompletedCommand(patch.Turn.CompletedCommand),
			SubmitAvailability: cloneSubmitAvailability(patch.Turn.SubmitAvailability),
			FileChanges:        clonePayload(patch.Turn.FileChanges),
			StartedAtUnixMS:    patch.Turn.StartedAtUnixMS,
			CompletedAtUnixMS:  patch.Turn.CompletedAtUnixMS,
		}
	}
	return out
}

func validateReportActivityAccepted(input agentsessionstore.ReportActivityInput, reply agentsessionstore.ReportActivityReply) error {
	if reply.AcceptedStatePatchCount < len(input.StatePatches) {
		return fmt.Errorf("agent session activity report accepted %d/%d state patches", reply.AcceptedStatePatchCount, len(input.StatePatches))
	}
	if reply.AcceptedMessageUpdateCount < len(input.MessageUpdates) {
		return fmt.Errorf("agent session activity report accepted %d/%d message updates", reply.AcceptedMessageUpdateCount, len(input.MessageUpdates))
	}
	return nil
}

func reportActivityInput(session Session, events []activityshared.Event) agentsessionstore.ReportActivityInput {
	activityEvents := ReportableActivityEvents(events)
	source := eventSourceFromSession(session)
	input := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source: source,
	}
	now := time.Now().UnixMilli()
	for _, event := range events {
		sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		if sessionID == "" {
			continue
		}
		timestamp := event.OccurredAtUnixMS
		if timestamp <= 0 {
			timestamp = now
		}
		if update, ok := messageUpdateFromSessionEvent(source, event, sessionID, timestamp); ok {
			input.MessageUpdates = append(input.MessageUpdates, update)
		}
		if shouldAppendVisibleFailure(events, event) {
			if update, ok := visibleFailureMessageUpdate(source, event, sessionID, timestamp); ok {
				input.MessageUpdates = append(input.MessageUpdates, update)
			}
		}
	}
	for _, event := range activityEvents {
		sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		if sessionID == "" {
			continue
		}
		timestamp := event.OccurredAtUnixMS
		if timestamp <= 0 {
			timestamp = now
		}
		if patch, ok := statePatchFromSessionEvent(source, event, sessionID, timestamp); ok {
			input.StatePatches = append(input.StatePatches, patch)
		}
	}
	return input
}

func messageUpdateFromSessionEvent(
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		return textMessageUpdateFromSessionEvent(event, sessionID, timestamp)
	case activityshared.EventCallStarted, activityshared.EventCallCompleted, activityshared.EventCallFailed:
		return callMessageUpdateFromSessionEvent(source, event, sessionID, timestamp)
	default:
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
}

func textMessageUpdateFromSessionEvent(
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	messageID := firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "messageId"), event.EventID)
	if strings.TrimSpace(sessionID) == "" || messageID == "" || timestamp <= 0 {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	role := strings.TrimSpace(string(event.Payload.Role))
	if role == "" {
		role = string(activityshared.MessageRoleAssistant)
	}
	kind := "text"
	if role == string(activityshared.MessageRoleAssistantThinking) {
		role = string(activityshared.MessageRoleAssistant)
		kind = "reasoning"
	}
	payload := map[string]any{
		"source": "runtime",
	}
	payload = withOwnerThreadID(payload, event)
	if event.Payload.Content != "" {
		payload["content"] = event.Payload.Content
		payload["text"] = event.Payload.Content
	}
	if content, ok := event.Payload.Metadata["content"]; ok {
		payload["content"] = acpSanitizeImagePayload(content)
	}
	if displayPrompt := stringFromPayload(event.Payload.Metadata, "displayPrompt"); displayPrompt != "" {
		payload["displayPrompt"] = displayPrompt
	}
	if clientSubmitID := stringFromPayload(event.Payload.Metadata, "clientSubmitId"); clientSubmitID != "" {
		payload["clientSubmitId"] = clientSubmitID
	}
	update := agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        messageID,
		Seq:              uint64(timestamp),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             role,
		Kind:             kind,
		Status:           firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "streamState"), event.Payload.Status),
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}
	if contentMode := stringFromPayload(event.Payload.Metadata, "contentMode"); contentMode != "" {
		update.Payload["contentMode"] = contentMode
	}
	// Carry the adapter's message kind tag (e.g. codex plan proposals) so the
	// GUI can render dedicated treatments instead of a plain assistant bubble.
	if messageKind := stringFromPayload(event.Payload.Metadata, "messageKind"); messageKind != "" {
		update.Payload["messageKind"] = messageKind
		// Sub-agent lane markers ride hidden ownerThreadId rows; the GUI
		// settles lane status/identity from these fields.
		if messageKind == "subAgentLifecycle" || messageKind == "subAgentName" {
			for _, key := range []string{"subAgentLifecycleStatus", "subAgentName", "detail"} {
				if value := stringFromPayload(event.Payload.Metadata, key); value != "" {
					update.Payload[key] = value
				}
			}
		}
	}
	update.Semantics = messageSemanticsFromMetadata(event.Payload.Metadata)
	forwardSystemNoticeMessageMetadata(update.Payload, event.Payload.Metadata)
	return update, true
}

func messageSemanticsFromMetadata(metadata map[string]any) *agentsessionstore.WorkspaceAgentMessageSemantics {
	if len(metadata) == 0 {
		return nil
	}
	semantics := agentsessionstore.WorkspaceAgentMessageSemantics{}
	if value, ok := metadata["userVisibleAssistantResponse"].(bool); ok {
		semantics.UserVisibleAssistantResponse = value
	}
	if value, ok := metadata["turnSettling"].(bool); ok {
		semantics.TurnSettling = value
	}
	semantics.NoticeCommand = stringFromPayload(metadata, "noticeCommand")
	semantics.NoticeCommandStatus = stringFromPayload(metadata, "noticeCommandStatus")
	if !semantics.UserVisibleAssistantResponse &&
		!semantics.TurnSettling &&
		semantics.NoticeCommand == "" &&
		semantics.NoticeCommandStatus == "" {
		return nil
	}
	return &semantics
}

func forwardSystemNoticeMessageMetadata(payload map[string]any, metadata map[string]any) {
	if stringFromPayload(metadata, "kind") != "agent_system_notice" {
		return
	}
	for _, key := range []string{
		"kind",
		"noticeKind",
		"severity",
		"title",
		"detail",
		"additionalDetails",
		"code",
		"noticeCommand",
		"noticeCommandStatus",
	} {
		if value := stringFromPayload(metadata, key); value != "" {
			payload[key] = value
		}
	}
	if retryable, ok := metadata["retryable"].(bool); ok {
		payload["retryable"] = retryable
	}
	for _, key := range []string{"acp", "codexErrorInfo", "extra"} {
		if value, ok := metadata[key]; ok && !payloadValueIsEmpty(value) {
			payload[key] = clonePayloadValue(value)
		}
	}
}

func callMessageUpdateFromSessionEvent(
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	if strings.TrimSpace(sessionID) == "" || timestamp <= 0 {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	callID := strings.TrimSpace(event.Payload.CallID)
	messageID := toolCallMessageUpdateID(event, sessionID, timestamp)
	if messageID == "" {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	status := callMessageUpdateStatus(event)
	payload := map[string]any{
		"source": "runtime",
	}
	payload = withOwnerThreadID(payload, event)
	rawName := callMessageUpdateDisplayName(event, callID)
	toolName := callMessageUpdateToolName(event, callID, rawName)
	name := firstNonEmptyString(toolName, rawName)
	if name != "" {
		payload["name"] = name
	}
	if callType := firstNonEmptyString(event.Payload.CallType, stringFromPayload(event.Payload.Metadata, "callType")); callType != "" {
		payload["callType"] = callType
	}
	for _, key := range []string{"toolName", "activityKind", "command", "status", "exitCode", "exit_code", "sessionID", "paths", "requestId"} {
		if value, ok := event.Payload.Metadata[key]; ok && !payloadValueIsEmpty(value) {
			if key == "toolName" {
				continue
			}
			payload[key] = clonePayloadValue(value)
		}
	}
	if toolName != "" {
		payload["toolName"] = toolName
	}
	if metadata, ok := event.Payload.Metadata["metadata"].(map[string]any); ok && len(metadata) > 0 {
		payload["metadata"] = clonePayloadValue(metadata)
	}
	for _, key := range []string{"input", "output", "error", "content", "locations"} {
		if value, ok := event.Payload.Metadata[key]; ok && !payloadValueIsEmpty(value) {
			switch key {
			case "output", "error":
				payload[key] = canonicalToolBodyPayload(value)
			default:
				payload[key] = clonePayloadValue(value)
			}
		}
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		if len(event.Payload.Input) > 0 {
			payload["input"] = clonePayload(event.Payload.Input)
		}
	case activityshared.EventCallCompleted:
		if len(event.Payload.Output) > 0 {
			payload["output"] = canonicalToolBodyPayload(event.Payload.Output)
		}
	case activityshared.EventCallFailed:
		if len(event.Payload.Output) > 0 {
			payload["output"] = canonicalToolBodyPayload(event.Payload.Output)
		}
		if len(event.Payload.Error) > 0 {
			payload["error"] = canonicalToolBodyPayload(event.Payload.Error)
		}
	}
	update := agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        messageID,
		Seq:              uint64(timestamp),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             string(activityshared.MessageRoleAssistant),
		Kind:             "tool_call",
		Status:           status,
		CallID:           callID,
		Title:            name,
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}
	if provider := firstNonEmptyString(string(event.Provider), source.Provider); provider != "" {
		update.Payload["provider"] = provider
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		update.StartedAtUnixMS = timestamp
	case activityshared.EventCallCompleted, activityshared.EventCallFailed:
		update.CompletedAtUnixMS = timestamp
	}
	return update, true
}

func canonicalToolBodyPayload(value any) any {
	body, ok := clonePayloadValue(value).(map[string]any)
	if !ok || len(body) == 0 {
		return clonePayloadValue(value)
	}
	if strings.TrimSpace(asString(body["text"])) == "" {
		if text := canonicalToolBodyText(body); text != "" {
			body["text"] = text
		}
	}
	return body
}

func canonicalToolBodyText(body map[string]any) string {
	for _, key := range []string{"text", "output", "stdout", "aggregated_output", "formatted_output", "stderr", "message"} {
		if text := strings.TrimSpace(asString(body[key])); text != "" {
			return text
		}
	}
	return strings.TrimSpace(acpContentText(body["content"]))
}

func callMessageUpdateDisplayName(event activityshared.Event, callID string) string {
	for _, candidate := range []string{
		event.Payload.Name,
		stringFromPayload(event.Payload.Metadata, "name"),
	} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" && !isOpaqueCallIdentifierString(trimmed, callID) {
			return trimmed
		}
	}
	return ""
}

func callMessageUpdateToolName(event activityshared.Event, callID string, displayName string) string {
	for _, candidate := range []string{
		stringFromPayload(event.Payload.Metadata, "toolName"),
		stringFromPayload(event.Payload.Metadata, "tool"),
		displayName,
		event.Payload.Name,
		stringFromPayload(event.Payload.Metadata, "name"),
		stringFromPayload(event.Payload.Metadata, "activityKind"),
		stringFromPayload(event.Payload.Metadata, "activity_kind"),
		stringFromPayload(event.Payload.Metadata, "kind"),
	} {
		if toolName := canonicalAgentToolName(candidate, callID); toolName != "" {
			return toolName
		}
	}
	if commandFromPayload(event.Payload.Input) != "" {
		return "Bash"
	}
	return ""
}

func canonicalAgentToolName(value string, callID string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || isOpaqueCallIdentifierString(trimmed, callID) {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "mcp__") {
		return trimmed
	}
	normalized := normalizeAgentToolToken(trimmed)
	switch normalized {
	case "approval":
		return "Approval"
	case "askuserquestion":
		return "AskUserQuestion"
	case "enterplanmode":
		return "EnterPlanMode"
	case "exitplanmode":
		return "ExitPlanMode"
	case "toolsearch":
		return "ToolSearch"
	case "skill":
		return "Skill"
	case "think":
		return "Think"
	case "bash", "shell", "exec", "execcommand", "runshellcommand", "terminal", "command", "runcommand":
		return "Bash"
	case "read", "readfile", "openfile", "listdir", "listdirectory", "listfiles", "ls":
		return "Read"
	case "write", "writefile", "createfile", "createnewfile", "writetofile":
		return "Write"
	case "edit", "editfile", "multiedit", "replaceinfile", "inserttext", "applypatch", "move":
		return "Edit"
	case "grep", "rg", "ripgrep", "search", "searchfiles", "searchfilecontent", "codebasesearch":
		return "Grep"
	case "glob", "find", "fd", "file_search", "filesearch", "findfiles":
		return "Glob"
	case "websearch", "googlesearch", "googlewebsearch", "websearchpreview":
		return "WebSearch"
	case "webfetch", "fetch", "fetchurl", "openpage":
		return "WebFetch"
	case "todowrite", "todo", "todowritefile", "updatetodo", "updatetodos", "writetodos":
		return "TodoWrite"
	case "task", "agent", "subagent", "runsubagent", "delegatetask", "delegateagent", "executeagent":
		return "Agent"
	case "run_command":
		return "Bash"
	case "read_file", "read_notebook", "list_files":
		return "Read"
	case "write_file":
		return "Write"
	case "edit_file", "edit_notebook", "apply_patch":
		return "Edit"
	case "find_files":
		return "Glob"
	case "search_files":
		return "Grep"
	case "web_search":
		return "WebSearch"
	case "web_fetch":
		return "WebFetch"
	case "update_todos":
		return "TodoWrite"
	case "delegate_agent":
		return "Agent"
	default:
		return trimmed
	}
}

func normalizeAgentToolToken(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.TrimPrefix(normalized, "tool.")
	normalized = strings.ReplaceAll(normalized, "-", "")
	normalized = strings.ReplaceAll(normalized, "_", "")
	normalized = strings.ReplaceAll(normalized, " ", "")
	return normalized
}

func commandFromPayload(payload map[string]any) string {
	return firstNonEmptyString(asString(payload["command"]), asString(payload["cmd"]), asString(payload["shell_command"]))
}

func isOpaqueCallIdentifierString(value string, callID string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if normalizedCallID := strings.TrimSpace(callID); normalizedCallID != "" && trimmed == normalizedCallID {
		return true
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "call_"):
		return isOpaqueIdentifierTail(trimmed[len("call_"):])
	case strings.HasPrefix(lower, "ws_"):
		return isOpaqueIdentifierTail(trimmed[len("ws_"):])
	default:
		return false
	}
}

func isOpaqueIdentifierTail(value string) bool {
	if len(value) < 12 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func toolCallMessageUpdateID(event activityshared.Event, sessionID string, timestamp int64) string {
	if callID := strings.TrimSpace(event.Payload.CallID); callID != "" {
		return "toolcall:" + callID
	}
	if eventID := strings.TrimSpace(event.EventID); eventID != "" {
		return "toolcall:" + eventID
	}
	fallback := firstNonEmptyString(event.Payload.TurnID, sessionID, fmt.Sprintf("%d", timestamp))
	if fallback == "" {
		return ""
	}
	return "toolcall:" + fallback
}

func callMessageUpdateStatus(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventCallCompleted:
		return string(activityshared.ActivityStatusCompleted)
	case activityshared.EventCallFailed:
		return string(activityshared.ActivityStatusFailed)
	case activityshared.EventCallStarted:
		status := firstNonEmptyString(event.Payload.Status, stringFromPayload(event.Payload.Metadata, "status"))
		switch strings.ToLower(status) {
		case string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput), "waiting":
			return status
		default:
			return string(activityshared.ActivityStatusRunning)
		}
	default:
		return ""
	}
}

func statePatchFromSessionEvent(source agentsessionstore.EventSource, event activityshared.Event, sessionID string, timestamp int64) (agentsessionstore.WorkspaceAgentStatePatch, bool) {
	switch event.Type {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
	default:
		return agentsessionstore.WorkspaceAgentStatePatch{}, false
	}
	patch := agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    sessionID,
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		Title:             event.Payload.Title,
		CurrentPhase:      currentPhaseFromActivityEvent(event),
		LifecycleStatus:   event.Payload.LifecycleStatus,
		LastError:         statePatchLastError(event),
		OccurredAtUnixMS:  timestamp,
	}
	if runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext"); len(runtimeContext) > 0 {
		patch.RuntimeContext = clonePayload(runtimeContext)
	}
	if turnID := strings.TrimSpace(event.Payload.TurnID); turnID != "" {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{
			TurnID:  turnID,
			Phase:   strings.TrimSpace(event.Payload.TurnPhase),
			Outcome: strings.TrimSpace(event.Payload.TurnOutcome),
		}
	}
	applyExplicitTurnLifecycleToPatch(&patch, event)
	switch event.Type {
	case activityshared.EventSessionStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionCompleted:
		patch.LifecycleStatus = string(activityshared.SessionStatusCompleted)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	case activityshared.EventSessionUpdated:
		if event.Payload.EffectiveStatus == string(activityshared.SessionStatusPaused) {
			patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusEnded))
			patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		}
	case activityshared.EventSessionFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		patch.CurrentPhase = string(activityshared.TurnPhaseFailed)
	case activityshared.EventTurnStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseWorking))
		if patch.Turn != nil {
			patch.Turn.StartedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnCompleted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	}
	return patch, true
}

func cloneMessageSemantics(value *agentsessionstore.WorkspaceAgentMessageSemantics) *agentsessionstore.WorkspaceAgentMessageSemantics {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := strings.TrimSpace(*value)
	return &cloned
}

func cloneCompletedCommand(value *agentsessionstore.WorkspaceAgentCompletedCommand) *agentsessionstore.WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneSubmitAvailability(value *agentsessionstore.WorkspaceAgentSubmitAvailability) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneTurnLifecycle(value *agentsessionstore.WorkspaceAgentTurnLifecycle) *agentsessionstore.WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     cloneStringPointer(value.ActiveTurnID),
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          cloneStringPointer(value.Outcome),
		CompletedCommand: cloneCompletedCommand(value.CompletedCommand),
	}
}

func cloneInteractivePrompt(value *agentsessionstore.WorkspaceAgentInteractivePrompt) *agentsessionstore.WorkspaceAgentInteractivePrompt {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentInteractivePrompt{
		Kind:      strings.TrimSpace(value.Kind),
		RequestID: strings.TrimSpace(value.RequestID),
		ToolName:  strings.TrimSpace(value.ToolName),
		Status:    strings.TrimSpace(value.Status),
		Input:     clonePayload(value.Input),
		Output:    clonePayload(value.Output),
		Error:     clonePayload(value.Error),
		Metadata:  clonePayload(value.Metadata),
	}
}

func applyExplicitTurnLifecycleToPatch(patch *agentsessionstore.WorkspaceAgentStatePatch, event activityshared.Event) {
	if patch == nil || !providerUsesExplicitTurnLifecyclePatch(patch.Provider) {
		return
	}
	turnID := strings.TrimSpace(event.Payload.TurnID)
	if turnID == "" {
		return
	}
	lifecyclePhase := codexLifecyclePhaseFromActivityEvent(event)
	if lifecyclePhase == "" {
		return
	}
	activeTurnID := turnID
	turnActive := &activeTurnID
	outcome := strings.TrimSpace(event.Payload.TurnOutcome)
	if lifecyclePhase == "settled" {
		turnActive = nil
		outcome = codexLifecycleOutcomeFromActivityEvent(event)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	}
	if patch.Turn == nil {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{TurnID: turnID}
	}
	patch.Turn.Phase = lifecyclePhase
	patch.Turn.ActiveTurnID = turnActive
	patch.Turn.Outcome = outcome
	patch.Turn.SubmitAvailability = codexSubmitAvailabilityForLifecyclePhase(lifecyclePhase)
	if command := completedCommandFromEventMetadata(event.Payload.Metadata); command != nil {
		patch.Turn.CompletedCommand = command
	}
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
	patch.TurnLifecycle = &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     turnActive,
		Phase:            lifecyclePhase,
		Outcome:          nil,
		CompletedCommand: cloneCompletedCommand(patch.Turn.CompletedCommand),
	}
	if outcome != "" {
		patch.TurnLifecycle.Outcome = &outcome
	}
}

func providerUsesExplicitTurnLifecyclePatch(provider string) bool {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode, ProviderCodex:
		return true
	default:
		return false
	}
}

func completedCommandFromEventMetadata(metadata map[string]any) *agentsessionstore.WorkspaceAgentCompletedCommand {
	kind := firstNonEmptyString(
		stringFromPayload(metadata, "completedCommandKind"),
		stringFromPayload(metadata, "noticeCommand"),
	)
	status := firstNonEmptyString(
		stringFromPayload(metadata, "completedCommandStatus"),
		stringFromPayload(metadata, "noticeCommandStatus"),
	)
	if kind == "" || status == "" {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentCompletedCommand{
		Kind:   kind,
		Status: status,
	}
}

func codexLifecyclePhaseFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnStarted:
		return "running"
	case activityshared.EventTurnUpdated:
		switch strings.TrimSpace(event.Payload.TurnPhase) {
		case "submitted":
			return "submitted"
		case string(activityshared.TurnPhaseWaiting), string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			return "waiting"
		case string(activityshared.TurnPhaseRunning), string(activityshared.TurnPhaseWorking):
			return "running"
		}
	case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
		return "settled"
	}
	return ""
}

func codexLifecycleOutcomeFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func codexSubmitAvailabilityForLifecyclePhase(phase string) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	switch phase {
	case "settled":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "available"}
	case "waiting":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case "submitted", "running":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
	default:
		return nil
	}
}

func statePatchLastError(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventSessionUpdated:
		if strings.TrimSpace(event.Payload.EffectiveStatus) == string(activityshared.SessionStatusPaused) {
			return ""
		}
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return ""
		}
	}
	detail := visibleFailureDetail(event)
	if detail == "" {
		return ""
	}
	code := visibleFailureCode(detail)
	switch code {
	case "provider_concurrency_limit",
		"provider_config_timeout",
		"provider_stream_disconnected",
		"quota_or_rate_limit",
		"request_timed_out":
		phase := "turn"
		if event.Type == activityshared.EventSessionFailed {
			phase = "start"
		}
		return visibleFailureContent(string(event.Provider), phase, code)
	default:
		return detail
	}
}

func currentPhaseFromActivityEvent(event activityshared.Event) string {
	if phase := strings.TrimSpace(event.Payload.TurnPhase); phase != "" {
		return phase
	}
	switch strings.ToLower(strings.TrimSpace(event.Payload.EffectiveStatus)) {
	case string(activityshared.SessionStatusWorking), "running", "streaming":
		return string(activityshared.TurnPhaseWorking)
	case "waiting", string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
		return strings.TrimSpace(event.Payload.EffectiveStatus)
	case string(activityshared.SessionStatusFailed):
		return string(activityshared.TurnPhaseFailed)
	case string(activityshared.SessionStatusCompleted), string(activityshared.SessionStatusIdle), "ready":
		return string(activityshared.TurnPhaseIdle)
	default:
		return ""
	}
}

func timelineItemFromSessionEvent(
	roomID string,
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentTimelineItem, *agentsessionstore.WorkspaceAgentStatePatch, bool) {
	item := agentsessionstore.WorkspaceAgentTimelineItem{
		RoomID:           strings.TrimSpace(roomID),
		AgentSessionID:   strings.TrimSpace(sessionID),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		EventSource:      "runtime",
		EventID:          strings.TrimSpace(event.EventID),
		ActorType:        "agent",
		ActorID:          firstNonEmptyString(string(event.Provider), source.Provider),
		OccurredAtUnixMS: timestamp,
		CreatedAtUnixMS:  timestamp,
	}
	if item.AgentSessionID == "" || item.EventID == "" {
		return agentsessionstore.WorkspaceAgentTimelineItem{}, nil, false
	}
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		role := string(event.Payload.Role)
		if role == "" {
			role = string(activityshared.MessageRoleAssistant)
		}
		item.Role = role
		item.ItemType = messageTimelineItemType(role)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "streamState"), event.Payload.Status)
		item.Payload = clonePayload(event.Payload.Metadata)
		if item.Payload == nil {
			item.Payload = map[string]any{}
		}
		item.Payload = withOwnerThreadID(item.Payload, event)
		if event.Payload.Content != "" {
			if _, exists := item.Payload["content"]; !exists {
				item.Payload["content"] = event.Payload.Content
			}
			item.Payload["text"] = event.Payload.Content
		}
		if role == string(activityshared.MessageRoleUser) {
			item.ActorType = "user"
		}
		return item, nil, true
	case activityshared.EventCallStarted:
		item.ItemType = "call.started"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusRunning), "running")
		item.Payload = payloadWithCallBody("input", event.Payload.Input, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventCallCompleted:
		item.ItemType = "call.completed"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusCompleted), "completed")
		item.Payload = payloadWithCallBody("output", event.Payload.Output, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventCallFailed:
		item.ItemType = "call.errored"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusFailed), "failed")
		item.Payload = payloadWithCallBody("error", event.Payload.Error, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventActivityStarted,
		activityshared.EventActivityUpdated,
		activityshared.EventActivityCompleted,
		activityshared.EventActivityFailed:
		item.ItemType = string(event.Type)
		item.CallID = strings.TrimSpace(event.Payload.ActivityKey)
		item.CallType = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "kind"), "activity")
		item.Name = firstNonEmptyString(
			stringFromPayload(event.Payload.Metadata, "title"),
			stringFromPayload(event.Payload.Metadata, "description"),
			item.CallID,
		)
		item.Status = activityTimelineStatus(event)
		item.Payload = clonePayload(event.Payload.Metadata)
		if item.Payload == nil {
			item.Payload = map[string]any{}
		}
		item.Payload["activityKey"] = strings.TrimSpace(event.Payload.ActivityKey)
		return item, nil, true
	default:
		return agentsessionstore.WorkspaceAgentTimelineItem{}, nil, false
	}
}

func activityTimelineStatus(event activityshared.Event) string {
	return firstNonEmptyString(
		event.Payload.ActivityStatus,
		stringFromPayload(event.Payload.Metadata, "status"),
		event.Payload.Status,
		activityTimelineDefaultStatus(event.Type),
	)
}

func activityTimelineDefaultStatus(eventType activityshared.EventType) string {
	switch eventType {
	case activityshared.EventActivityCompleted:
		return string(activityshared.ActivityStatusCompleted)
	case activityshared.EventActivityFailed:
		return string(activityshared.ActivityStatusFailed)
	default:
		return string(activityshared.ActivityStatusRunning)
	}
}

func messageTimelineItemType(role string) string {
	switch strings.TrimSpace(role) {
	case string(activityshared.MessageRoleUser):
		return "message.user"
	case string(activityshared.MessageRoleAssistantThinking):
		return "message.assistant_thinking"
	default:
		return "message.assistant"
	}
}

func reportCallTimelineEventID(callID string, source agentsessionstore.EventSource, event activityshared.Event) string {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return strings.TrimSpace(event.EventID)
	}
	provider := strings.TrimSpace(firstNonEmptyString(string(event.Provider), source.Provider))
	providerSessionID := strings.TrimSpace(firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID))
	if provider == "" || providerSessionID == "" {
		return strings.TrimSpace(event.EventID)
	}
	return provider + ":" + providerSessionID + ":call:" + callID
}

func entityPatchFromSessionEvent(
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
	item agentsessionstore.WorkspaceAgentTimelineItem,
) *agentsessionstore.WorkspaceAgentStatePatch {
	if strings.TrimSpace(item.CallID) == "" && strings.TrimSpace(item.Name) == "" {
		return nil
	}
	entity := agentsessionstore.WorkspaceAgentEntityPatch{
		CallID:   strings.TrimSpace(item.CallID),
		TurnID:   strings.TrimSpace(item.TurnID),
		CallType: firstNonEmptyString(item.CallType, "tool"),
		Name:     strings.TrimSpace(item.Name),
		Status:   strings.TrimSpace(item.Status),
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		entity.Input = clonePayload(event.Payload.Input)
		entity.StartedAtUnixMS = timestamp
	case activityshared.EventCallCompleted:
		entity.Output = clonePayload(event.Payload.Output)
		entity.CompletedAtUnixMS = timestamp
	case activityshared.EventCallFailed:
		if len(event.Payload.Output) > 0 {
			entity.Output = clonePayload(event.Payload.Output)
		}
		entity.Error = clonePayload(event.Payload.Error)
		entity.CompletedAtUnixMS = timestamp
	}
	return &agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(sessionID),
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		OccurredAtUnixMS:  timestamp,
		Entities:          []agentsessionstore.WorkspaceAgentEntityPatch{entity},
	}
}

func payloadWithCallBody(key string, payload map[string]any, metadata map[string]any) map[string]any {
	out := clonePayload(metadata)
	if out == nil {
		out = map[string]any{}
	}
	if len(payload) > 0 {
		out[key] = clonePayload(payload)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func withOwnerThreadID(payload map[string]any, event activityshared.Event) map[string]any {
	ownerThreadID := strings.TrimSpace(event.OwnerThreadID)
	if ownerThreadID == "" {
		return payload
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["ownerThreadId"] = ownerThreadID
	// The spawn call that created the owning child thread. The GUI attaches
	// sub-agent lanes to their collab card by this id alone (ADR 0007); a
	// child row without it never attaches by guesswork.
	if ownerCallID := strings.TrimSpace(event.OwnerCallID); ownerCallID != "" {
		payload["ownerCallId"] = ownerCallID
	}
	return payload
}

func collapseReportTimelineItems(items []agentsessionstore.WorkspaceAgentTimelineItem) []agentsessionstore.WorkspaceAgentTimelineItem {
	if len(items) <= 1 {
		return items
	}
	out := make([]agentsessionstore.WorkspaceAgentTimelineItem, 0, len(items))
	seen := make(map[string]int, len(items))
	for _, item := range items {
		eventID := strings.TrimSpace(item.EventID)
		if eventID == "" {
			out = append(out, item)
			continue
		}
		if index, ok := seen[eventID]; ok {
			out[index] = mergeReportTimelineItem(out[index], item)
			continue
		}
		seen[eventID] = len(out)
		out = append(out, item)
	}
	return out
}

func mergeReportTimelineItem(base agentsessionstore.WorkspaceAgentTimelineItem, incoming agentsessionstore.WorkspaceAgentTimelineItem) agentsessionstore.WorkspaceAgentTimelineItem {
	merged := base
	replaceState := reportTimelineItemRank(incoming) >= reportTimelineItemRank(base)
	if merged.ID == 0 {
		merged.ID = incoming.ID
	}
	merged.RoomID = firstNonEmptyString(merged.RoomID, incoming.RoomID)
	merged.AgentSessionID = firstNonEmptyString(merged.AgentSessionID, incoming.AgentSessionID)
	merged.TurnID = firstNonEmptyString(merged.TurnID, incoming.TurnID)
	merged.EventSource = firstNonEmptyString(merged.EventSource, incoming.EventSource)
	merged.EventID = firstNonEmptyString(merged.EventID, incoming.EventID)
	merged.ActorType = firstNonEmptyString(merged.ActorType, incoming.ActorType)
	merged.ActorID = firstNonEmptyString(merged.ActorID, incoming.ActorID)
	merged.Role = firstNonEmptyString(merged.Role, incoming.Role)
	merged.CallType = firstNonEmptyString(merged.CallType, incoming.CallType)
	merged.CallID = firstNonEmptyString(merged.CallID, incoming.CallID)
	merged.Name = firstNonEmptyString(merged.Name, incoming.Name)
	if replaceState {
		merged.ItemType = firstNonEmptyString(incoming.ItemType, merged.ItemType)
		merged.Status = firstNonEmptyString(incoming.Status, merged.Status)
	} else {
		merged.ItemType = firstNonEmptyString(merged.ItemType, incoming.ItemType)
		merged.Status = firstNonEmptyString(merged.Status, incoming.Status)
	}
	if incoming.OccurredAtUnixMS > 0 && (merged.OccurredAtUnixMS <= 0 || incoming.OccurredAtUnixMS < merged.OccurredAtUnixMS) {
		merged.OccurredAtUnixMS = incoming.OccurredAtUnixMS
	}
	if incoming.CreatedAtUnixMS > 0 && (merged.CreatedAtUnixMS <= 0 || incoming.CreatedAtUnixMS < merged.CreatedAtUnixMS) {
		merged.CreatedAtUnixMS = incoming.CreatedAtUnixMS
	}
	merged.Payload = mergeReportPayload(merged.Payload, incoming.Payload)
	return merged
}

func reportTimelineItemRank(item agentsessionstore.WorkspaceAgentTimelineItem) int {
	switch strings.ToLower(strings.TrimSpace(item.Status)) {
	case "completed", "complete", "success", "succeeded", "failed", "failure", "error", "errored", "canceled":
		return 3
	case "waiting_approval", "waiting", "running", "streaming", "working":
		return 2
	}
	switch strings.ToLower(strings.TrimSpace(item.ItemType)) {
	case "call.completed", "call.failed", "call.errored":
		return 3
	case "call.started":
		return 2
	default:
		return 1
	}
}

func mergeReportPayload(base map[string]any, incoming map[string]any) map[string]any {
	out := clonePayload(base)
	if out == nil {
		out = map[string]any{}
	}
	for key, value := range incoming {
		if payloadValueIsEmpty(value) {
			continue
		}
		if existing, ok := out[key]; ok {
			existingMap, existingOK := existing.(map[string]any)
			incomingMap, incomingOK := value.(map[string]any)
			if existingOK && incomingOK {
				out[key] = mergeReportPayload(existingMap, incomingMap)
				continue
			}
		}
		out[key] = clonePayloadValue(value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func payloadValueIsEmpty(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func clonePayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = clonePayloadValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = clonePayloadValue(item)
		}
		return out
	default:
		return value
	}
}

func stringFromPayload(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	return asString(payload[key])
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (r Reporter) maxAttempts() int {
	if r.MaxAttempts > 0 {
		return r.MaxAttempts
	}
	return 3
}

func (r Reporter) backoffForAttempt(attempt int) time.Duration {
	index := attempt - 1
	if index >= 0 && index < len(r.Backoff) {
		return r.Backoff[index]
	}
	if index >= 0 && index < len(defaultReportRetryBackoff) {
		return defaultReportRetryBackoff[index]
	}
	return defaultReportRetryBackoff[len(defaultReportRetryBackoff)-1]
}

func (r Reporter) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func (r Reporter) logReportFailure(input agentsessionstore.ReportActivityInput, attempt int, maxAttempts int, reply agentsessionstore.ReportActivityReply, err error) {
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(input)
	r.logger().Error(
		"agent session activity report failed after retries",
		"event", "agent_session.activity_report.failed",
		"room_id", input.WorkspaceID,
		"agent_session_id", input.Source.AgentID,
		"provider", input.Source.Provider,
		"provider_session_id", input.Source.ProviderSessionID,
		"timeline_item_count", len(input.TimelineItems),
		"state_patch_count", len(input.StatePatches),
		"message_update_count", len(input.MessageUpdates),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
		"accepted_timeline_item_count", reply.AcceptedTimelineItemCount,
		"accepted_state_patch_count", reply.AcceptedStatePatchCount,
		"accepted_message_update_count", reply.AcceptedMessageUpdateCount,
		"attempt", attempt,
		"max_attempts", maxAttempts,
		"error", err,
	)
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
