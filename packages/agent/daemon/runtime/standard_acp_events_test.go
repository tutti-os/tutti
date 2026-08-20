package agentruntime

import (
	"encoding/json"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestStandardACPToolCallEventInfersCompletedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	completed, ok := standardACPToolCallEventWithID(session, "event-complete-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_completed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred complete) returned !ok")
	}
	if completed.Type != activityshared.EventCallCompleted {
		t.Fatalf("completed event type = %s, want call.completed", completed.Type)
	}
	if completed.Payload.Output["stdout"] != "/workspace/app\n" {
		t.Fatalf("completed output = %#v, want stdout preserved", completed.Payload.Output)
	}
	if completed.Payload.Metadata["toolName"] != "Bash" {
		t.Fatalf("completed tool name = %#v, want Bash", completed.Payload.Metadata["toolName"])
	}
}

func TestStandardACPToolAliasOverridesProviderToolIDDeclaratively(t *testing.T) {
	update := map[string]any{"title": "replace", "toolCallId": "call-1"}
	applyStandardACPToolAlias(standardACPConfig{toolAliases: map[string]string{"replace": "Edit"}}, update)
	if got := update["toolName"]; got != "Edit" {
		t.Fatalf("toolName = %#v, want Edit", got)
	}
}

func TestStandardACPToolCallEventInfersFailedStatusFromRawOutput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	failed, ok := standardACPToolCallEventWithID(session, "event-failed-inferred", "turn-1", "tool_call_update", readSessionTestdataJSON(t, "standard_acp_tool_call_update_failed_without_status.json"))
	if !ok {
		t.Fatal("standardACPToolCallEventWithID(inferred failed) returned !ok")
	}
	if failed.Type != activityshared.EventCallFailed {
		t.Fatalf("failed event type = %s, want call.failed", failed.Type)
	}
	if failed.Payload.Error["output"] != "Exit code 137" {
		t.Fatalf("failed error = %#v, want raw output preserved", failed.Payload.Error)
	}
}

func TestStandardACPNonzeroToolExitDoesNotFailCompletedAssistantTurn(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	normalizer := newACPTurnNormalizer()
	toolEvents := standardACPUpdateEvents(standardACPConfig{provider: hermesExtensionTestProvider}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "git-check-1",
			"title": "Run command",
			"kind": "execute",
			"rawInput": {"command": "powershell.exe -Command 'git status; git diff; git diff --no-index -- /dev/null README.md'"},
			"rawOutput": {"exitCode": 1, "stdout": "diff --git a/README.md b/README.md"}
		}
	}`), normalizer)
	if len(toolEvents) != 1 || toolEvents[0].Type != activityshared.EventCallFailed {
		t.Fatalf("tool events = %#v, want one call.failed", toolEvents)
	}

	normalizer.ApplyAssistantFinalText("The comparison completed and found differences.")
	turnEvents := normalizer.FinishCompleted(session, "turn-1")
	assistant := activityMessagesWithRole(turnEvents, activityshared.MessageRoleAssistant)
	if len(assistant) != 1 || assistant[0].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("assistant events = %#v, want completed assistant response", assistant)
	}
}

func TestStandardACPNormalizerKeepsCanonicalToolIdentityAcrossDynamicTitles(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	normalizer := newACPTurnNormalizer()
	started := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "edit-1",
			"title": "apply_patch",
			"status": "in_progress",
			"kind": "edit",
			"rawInput": {"patchText": "*** Begin Patch"}
		}
	}`), normalizer)
	completed := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "edit-1",
			"title": "Success. Updated the following files: index.html",
			"status": "completed",
			"kind": "edit",
			"rawInput": {"patchText": "*** Begin Patch"},
			"rawOutput": {"metadata": {"diff": "Index: index.html", "files": [{"filePath": "index.html"}]}}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Payload.Metadata["toolName"] != "Edit" {
		t.Fatalf("started events = %#v, want canonical Edit", started)
	}
	if len(completed) != 1 || completed[0].Payload.Metadata["toolName"] != "Edit" {
		t.Fatalf("completed events = %#v, want stable canonical Edit", completed)
	}
	if completed[0].Payload.Metadata["kind"] != "edit" {
		t.Fatalf("completed metadata = %#v, want ACP kind", completed[0].Payload.Metadata)
	}
	if completed[0].Payload.Output["diff"] != "Index: index.html" {
		t.Fatalf("completed output = %#v, want promoted diff", completed[0].Payload.Output)
	}
	if files, ok := completed[0].Payload.Output["files"].([]any); !ok || len(files) != 1 {
		t.Fatalf("completed output = %#v, want promoted files", completed[0].Payload.Output)
	}
}

func TestCursorACPDeleteToolPreservesDeletedFileChangeKind(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderCursor}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "delete-1",
			"title": "Delete obsolete.txt",
			"status": "completed",
			"kind": "delete",
			"content": [{
				"type": "diff",
				"path": "/workspace/obsolete.txt",
				"oldText": "obsolete\n",
				"newText": ""
			}]
		}
	}`), normalizer)
	if len(events) != 2 || events[0].Type != activityshared.EventCallCompleted || events[1].Type != activityshared.EventTurnUpdated {
		t.Fatalf("delete events = %#v, want completed call followed by turn.updated", events)
	}
	if events[0].Payload.Metadata["toolName"] != "Write" {
		t.Fatalf("delete tool name = %#v, want Cursor-compatible Write", events[0].Payload.Metadata["toolName"])
	}
	files := payloadArray(payloadMap(events[1].Payload.Metadata, "fileChanges")["files"])
	if len(files) != 1 || files[0]["change"] != "deleted" {
		t.Fatalf("turn file changes = %#v, want one deleted file", files)
	}
}

func TestACPToolNameRecognizesOpenCodeTodoPayload(t *testing.T) {
	t.Parallel()
	if got := acpToolName("todo-1", "0 todos", "other", map[string]any{"todos": []any{}}); got != "TodoWrite" {
		t.Fatalf("acpToolName() = %q, want TodoWrite", got)
	}
}

func TestStandardACPToolCallLifecycleReusesStableEventID(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		provider string
		config   standardACPConfig
	}{
		{
			name:     "hermes default config",
			provider: hermesExtensionTestProvider,
			config:   standardACPConfig{provider: hermesExtensionTestProvider},
		},
		{
			name:     "hermes",
			provider: hermesExtensionTestProvider,
			config:   standardACPConfig{provider: hermesExtensionTestProvider},
		},
		{
			name:     "openclaw",
			provider: ProviderOpenClaw,
			config:   standardACPConfig{provider: ProviderOpenClaw},
		},
		{
			name:     "opencode",
			provider: ProviderOpenCode,
			config:   standardACPConfig{provider: ProviderOpenCode},
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			session := standardTestSession(tc.provider)
			session.ProviderSessionID = tc.name + "-session-1"
			normalizer := newACPTurnNormalizer()

			started := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "pending",
					"kind": "tool",
					"rawInput": {"command": "pwd"}
				}
			}`), normalizer)
			if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
				t.Fatalf("started events = %#v, want one call.started", started)
			}

			completed := standardACPUpdateEvents(tc.config, session, "turn-1", json.RawMessage(`{
				"update": {
					"sessionUpdate": "tool_call_update",
					"toolCallId": "tool-current",
					"title": "Bash",
					"status": "completed",
					"kind": "tool",
					"rawOutput": {"stdout": "/workspace/app\n"}
				}
			}`), normalizer)
			if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
				t.Fatalf("completed events = %#v, want one call.completed", completed)
			}
			if started[0].EventID == "" {
				t.Fatalf("started event id = empty, want stable event id")
			}
			if completed[0].EventID != started[0].EventID {
				t.Fatalf("event ids = %q / %q, want same stable tool event id", started[0].EventID, completed[0].EventID)
			}
		})
	}
}

func TestStandardACPNormalizerSegmentsAssistantAndThinkingAroundToolCalls(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	session.ProviderSessionID = "hermes-session-segment-1"
	normalizer := newACPTurnNormalizer()

	var events []activityshared.Event
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking before tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "Before tool. ")...)
	events = append(events, standardACPUpdateEvents(standardACPConfig{provider: hermesExtensionTestProvider}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "tool-segment-1",
			"title": "Bash",
			"status": "pending"
		}
	}`), normalizer)...)
	events = append(events, normalizer.AppendThinkingChunk(session, "turn-1", "Thinking after tool. ")...)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "After tool.")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateCompleted)...)

	assistantMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(assistantMessages) != 4 {
		t.Fatalf("assistant messages = %#v, want streaming+completed before tool and streaming+completed after tool", assistantMessages)
	}
	if assistantMessages[0].EventID == "" ||
		assistantMessages[1].EventID != assistantMessages[0].EventID ||
		assistantMessages[2].EventID == "" ||
		assistantMessages[3].EventID != assistantMessages[2].EventID ||
		assistantMessages[2].EventID == assistantMessages[0].EventID {
		t.Fatalf("assistant event IDs = %#v, want distinct IDs split by tool boundary", assistantMessages)
	}
	if assistantMessages[1].Payload.Content != "Before tool. " ||
		assistantMessages[3].Payload.Content != "After tool." {
		t.Fatalf("assistant contents = %#v, want text split around tool call", assistantMessages)
	}

	thinkingMessages := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	if len(thinkingMessages) != 4 {
		t.Fatalf("thinking messages = %#v, want streaming+completed before tool and streaming+completed after tool", thinkingMessages)
	}
	if thinkingMessages[0].EventID == "" ||
		thinkingMessages[1].EventID != thinkingMessages[0].EventID ||
		thinkingMessages[2].EventID == "" ||
		thinkingMessages[3].EventID != thinkingMessages[2].EventID ||
		thinkingMessages[2].EventID == thinkingMessages[0].EventID {
		t.Fatalf("thinking event IDs = %#v, want distinct IDs split by tool boundary", thinkingMessages)
	}
	if thinkingMessages[1].Payload.Content != "Thinking before tool. " ||
		thinkingMessages[3].Payload.Content != "Thinking after tool. " {
		t.Fatalf("thinking contents = %#v, want thinking split around tool call", thinkingMessages)
	}

	if events[2].Type != activityshared.EventMessageAppended ||
		events[3].Type != activityshared.EventMessageAppended ||
		events[4].Type != activityshared.EventCallStarted ||
		events[5].Type != activityshared.EventMessageAppended ||
		events[6].Type != activityshared.EventMessageAppended {
		t.Fatalf("event order = %#v, want thinking completion, assistant completion, tool call, then next segments", events)
	}
}

func TestStandardACPUpdateDoesNotProjectInternalMentionRoutingTitle(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	session.ProviderSessionID = "hermes-session-1"
	events := standardACPUpdateEvents(standardACPConfig{provider: hermesExtensionTestProvider}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "session_info_update",
			"title": "`+tuttiMentionRoutingReminder+`"
		}
	}`), newACPTurnNormalizer())
	for _, event := range events {
		if event.Payload.Title == tuttiMentionRoutingReminder {
			t.Fatalf("events = %#v, want internal mention routing title excluded from title updates", events)
		}
	}
}

func TestStandardACPSystemNoticeChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	session.ProviderSessionID = "hermes-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: hermesExtensionTestProvider}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Codex switched to HTTPS transport."
			},
			"_meta": {
				"tsh": {
					"kind": "agent_system_notice",
					"noticeKind": "transport_fallback",
					"severity": "warning",
					"title": "Codex switched to HTTPS transport.",
					"detail": "Falling back from WebSockets to HTTPS transport."
				}
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	event := events[0]
	if event.Type != activityshared.EventMessageAppended || event.Payload.Role != activityshared.MessageRoleAssistant {
		t.Fatalf("event = %#v, want assistant message", event)
	}
	if got := event.Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := event.Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestStandardACPTransportFallbackTextProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderNexight)
	session.ProviderSessionID = "nexight-session-1"

	events := standardACPUpdateEvents(NewNexightAdapter(nil).config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_fallback" {
		t.Fatalf("noticeKind = %#v, want transport_fallback", got)
	}
}

func TestStandardACPReconnectThoughtChunkProjectsAssistantNotice(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderNexight)
	session.ProviderSessionID = "nexight-session-1"

	events := standardACPUpdateEvents(NewNexightAdapter(nil).config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_thought_chunk",
			"content": {
				"type": "text",
				"text": "Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: None })"
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one system notice message", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got != "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want agent_system_notice", got)
	}
	if got := events[0].Payload.Metadata["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
}

func TestNexightACPSystemNoticeMessageFromStderr(t *testing.T) {
	t.Parallel()

	mapper := NewNexightAdapter(nil).config.stderrMessageMapper
	if mapper == nil {
		t.Fatal("nexight config stderrMessageMapper = nil, want stream-error mapper")
	}

	message, ok := mapper([]byte(
		`2026-05-29T09:05:51.179821Z ERROR codex_acp::thread: Handled error during turn: Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: Some(401) }) Some("unexpected status 401 Unauthorized")`,
	))
	if !ok {
		t.Fatal("stderr notice ok = false, want true")
	}
	if message.Method != acpMethodUpdate {
		t.Fatalf("method = %q, want %q", message.Method, acpMethodUpdate)
	}
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if got := params.Update["sessionUpdate"]; got != "stream_error" {
		t.Fatalf("sessionUpdate = %#v, want stream_error", got)
	}
	if got := params.Update["noticeKind"]; got != "transport_retry" {
		t.Fatalf("noticeKind = %#v, want transport_retry", got)
	}
	if got := params.Update["source"]; got != "acp_stderr" {
		t.Fatalf("source = %#v, want acp_stderr", got)
	}

	if _, ok := mapper([]byte("WARN unrelated")); ok {
		t.Fatal("generic stderr ok = true, want false")
	}
}

func TestStandardACPTransportFallbackTextStaysProviderScoped(t *testing.T) {
	t.Parallel()

	session := standardTestSession(hermesExtensionTestProvider)
	session.ProviderSessionID = "hermes-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: hermesExtensionTestProvider}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "agent_message_chunk",
			"content": {
				"type": "text",
				"text": "Falling back from WebSockets to HTTPS transport."
			}
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want normal assistant chunk for non-Codex providers", events)
	}
	if got := events[0].Payload.Metadata["kind"]; got == "agent_system_notice" {
		t.Fatalf("notice kind marker = %#v, want ordinary assistant message", got)
	}
	if got := events[0].Payload.Content; got != "Falling back from WebSockets to HTTPS transport." {
		t.Fatalf("content = %q, want ordinary assistant content", got)
	}
}

func firstUserMessageContent(t *testing.T, events []activityshared.Event) string {
	t.Helper()
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended && event.Payload.Role == activityshared.MessageRoleUser {
			return event.Payload.Content
		}
	}
	t.Fatalf("events = %#v, want user message event", events)
	return ""
}
