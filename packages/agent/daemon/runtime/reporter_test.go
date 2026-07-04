package agentruntime

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

type retryingActivityClient struct {
	failuresBeforeSuccess int
	calls                 int
	inputs                []agentsessionstore.ReportActivityInput
	stateInputs           []agentsessionstore.ReportSessionStateInput
	messageInputs         []agentsessionstore.ReportSessionMessagesInput
	reply                 *agentsessionstore.ReportActivityReply
}

func (c *retryingActivityClient) ReportActivity(
	_ context.Context,
	input agentsessionstore.ReportActivityInput,
) (agentsessionstore.ReportActivityReply, error) {
	c.calls++
	c.inputs = append(c.inputs, input)
	if c.calls <= c.failuresBeforeSuccess {
		return agentsessionstore.ReportActivityReply{}, errors.New("temporary report failure")
	}
	if c.reply != nil {
		return *c.reply, nil
	}
	return acceptedReportActivityReply(input), nil
}

func (c *retryingActivityClient) ReportSessionState(
	_ context.Context,
	input agentsessionstore.ReportSessionStateInput,
) (agentsessionstore.ReportSessionStateReply, error) {
	c.calls++
	c.stateInputs = append(c.stateInputs, input)
	if c.calls <= c.failuresBeforeSuccess {
		return agentsessionstore.ReportSessionStateReply{}, errors.New("temporary report failure")
	}
	if c.reply != nil && c.reply.AcceptedStatePatchCount == 0 {
		return agentsessionstore.ReportSessionStateReply{Accepted: false}, nil
	}
	return agentsessionstore.ReportSessionStateReply{Accepted: true, LastEventAtUnixMS: input.State.OccurredAtUnixMS}, nil
}

func (c *retryingActivityClient) ReportSessionMessages(
	_ context.Context,
	input agentsessionstore.ReportSessionMessagesInput,
) (agentsessionstore.ReportSessionMessagesReply, error) {
	c.calls++
	c.messageInputs = append(c.messageInputs, input)
	if c.calls <= c.failuresBeforeSuccess {
		return agentsessionstore.ReportSessionMessagesReply{}, errors.New("temporary report failure")
	}
	if c.reply != nil {
		return agentsessionstore.ReportSessionMessagesReply{AcceptedCount: c.reply.AcceptedMessageUpdateCount}, nil
	}
	return agentsessionstore.ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}

func acceptedReportActivityReply(input agentsessionstore.ReportActivityInput) agentsessionstore.ReportActivityReply {
	return agentsessionstore.ReportActivityReply{
		AcceptedTimelineItemCount:  len(input.TimelineItems),
		AcceptedStatePatchCount:    len(input.StatePatches),
		AcceptedMessageUpdateCount: len(input.MessageUpdates),
	}
}

func TestReporterRetriesActivityReportAndPreservesRuntimeOrigin(t *testing.T) {
	t.Parallel()

	client := &retryingActivityClient{failuresBeforeSuccess: 2}
	var logBuffer bytes.Buffer
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		Logger:         slog.New(slog.NewTextHandler(&logBuffer, nil)),
		MaxAttempts:    3,
		Backoff:        []time.Duration{0, 0},
	}

	err := reporter.Report(context.Background(), reportActivityInput(reportTestSession(), []activityshared.Event{
		newSessionActivityEvent(reportTestSession(), EventSessionStarted, SessionStatusReady, nil),
	}))
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 3 {
		t.Fatalf("calls = %d, want 3", client.calls)
	}
	if got := client.stateInputs[len(client.stateInputs)-1].Source.SessionOrigin; got != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("session origin = %q, want %q", got, WorkspaceAgentSessionOriginRuntime)
	}
	logs := logBuffer.String()
	if !strings.Contains(logs, "agent_session.activity_report.retry") {
		t.Fatalf("logs did not contain retry event: %s", logs)
	}
	if !strings.Contains(logs, "agent_session.activity_report.succeeded_after_retry") {
		t.Fatalf("logs did not contain retry success event: %s", logs)
	}
	if !strings.Contains(logs, "agent session activity report succeeded") {
		t.Fatalf("logs did not contain success event: %s", logs)
	}
}

func TestReporterSuppressesRoutineSuccessLogsAtInfoLevel(t *testing.T) {
	t.Parallel()

	client := &retryingActivityClient{}
	var logBuffer bytes.Buffer
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		Logger:         slog.New(slog.NewTextHandler(&logBuffer, nil)),
		MaxAttempts:    1,
	}

	err := reporter.Report(context.Background(), reportActivityInput(reportTestSession(), []activityshared.Event{
		newSessionActivityEvent(reportTestSession(), EventSessionStarted, SessionStatusReady, nil),
	}))
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want 1", client.calls)
	}
	logs := logBuffer.String()
	if strings.Contains(logs, "agent_session.activity_report.prepared") ||
		strings.Contains(logs, "agent_session.activity_report.succeeded") {
		t.Fatalf("routine success logs should be debug-only: %s", logs)
	}
}

func TestReporterReturnsErrorAfterRetriesExhausted(t *testing.T) {
	t.Parallel()

	client := &retryingActivityClient{failuresBeforeSuccess: 10}
	var logBuffer bytes.Buffer
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		Logger:         slog.New(slog.NewTextHandler(&logBuffer, nil)),
		MaxAttempts:    3,
		Backoff:        []time.Duration{0, 0},
	}

	err := reporter.Report(context.Background(), reportActivityInput(reportTestSession(), []activityshared.Event{
		newSessionActivityEvent(reportTestSession(), EventSessionStarted, SessionStatusReady, nil),
	}))
	if err == nil {
		t.Fatal("Report returned nil error after retries were exhausted")
	}
	if client.calls != 3 {
		t.Fatalf("calls = %d, want 3", client.calls)
	}
	if logs := logBuffer.String(); !strings.Contains(logs, "agent_session.activity_report.failed") {
		t.Fatalf("logs did not contain final failure event: %s", logs)
	}
}

func TestTimelineItemPreservesStructuredUserContentMetadata(t *testing.T) {
	structuredContent := []map[string]any{
		{"type": "text", "text": "look"},
		{"type": "image", "mimeType": "image/png", "attachmentId": "attachment-1"},
	}
	item, _, ok := timelineItemFromSessionEvent(
		"workspace-1",
		agentsessionstore.EventSource{Provider: "codex"},
		activityshared.Event{
			EventID:  "event-1",
			Type:     activityshared.EventMessageCreated,
			Provider: activityshared.ProviderCodex,
			Payload: activityshared.EventPayload{
				Role:    activityshared.MessageRoleUser,
				Content: "look",
				Metadata: map[string]any{
					"content": structuredContent,
				},
			},
		},
		"session-1",
		123,
	)
	if !ok {
		t.Fatal("timelineItemFromSessionEvent returned !ok")
	}
	if got := item.Payload["content"]; got == nil {
		t.Fatalf("payload content missing: %#v", item.Payload)
	} else if _, ok := got.([]map[string]any); !ok {
		t.Fatalf("payload content = %#v, want structured content blocks", got)
	}
	if got := item.Payload["text"]; got != "look" {
		t.Fatalf("payload text = %#v, want display text", got)
	}
}

func TestReporterSendsMessageOnlyReport(t *testing.T) {
	t.Parallel()

	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	err := reporter.Report(context.Background(), agentsessionstore.ReportActivityInput{
		WorkspaceID: "room-1",
		Source: agentsessionstore.EventSource{
			Provider: "codex",
			AgentID:  "agent-session-1",
		},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "agent-session-1",
			MessageID:      "message-1",
			TurnID:         "turn-1",
			Seq:            1,
			Role:           "assistant",
			Kind:           "text",
			Payload:        map[string]any{"text": "hello"},
		}},
	})
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want 1", client.calls)
	}
	if got := len(client.messageInputs[0].Updates); got != 1 {
		t.Fatalf("message updates = %d, want 1", got)
	}
}

func TestReporterReturnsErrorWhenMessageUpdatesPartiallyAccepted(t *testing.T) {
	t.Parallel()

	client := &retryingActivityClient{
		reply: &agentsessionstore.ReportActivityReply{
			AcceptedTimelineItemCount:  1,
			AcceptedStatePatchCount:    1,
			AcceptedMessageUpdateCount: 0,
		},
	}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	err := reporter.Report(context.Background(), mixedMessageUpdateReportInput())
	if err == nil {
		t.Fatal("Report returned nil error for partially accepted message updates")
	}
	if !strings.Contains(err.Error(), "message updates") {
		t.Fatalf("error = %q, want mention message updates", err.Error())
	}
}

func TestReporterSucceedsWhenMixedReportCountsAccepted(t *testing.T) {
	t.Parallel()

	input := mixedMessageUpdateReportInput()
	client := &retryingActivityClient{
		reply: ptrReportActivityReply(acceptedReportActivityReply(input)),
	}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	if err := reporter.Report(context.Background(), input); err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 2 {
		t.Fatalf("calls = %d, want state and messages reports", client.calls)
	}
}

func TestReporterProjectsMessagesAndCallsToSessionMessageUpdatesOnly(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	report := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "message-user-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleUser, "inspect repo", nil),
		newTurnActivityEventWithID(session, "call-1-item", EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read", map[string]any{
			"callId":   "call-1",
			"callType": "tool",
			"name":     "Read",
			"toolName": "Read",
			"input":    map[string]any{"path": "README.md"},
		}),
		newTurnActivityEventWithID(session, "call-1-item", EventCallCompleted, "turn-1", messageStreamStateCompleted, "", "Read", map[string]any{
			"callId":   "call-1",
			"callType": "tool",
			"name":     "Read",
			"toolName": "Read",
			"output":   map[string]any{"text": "hello"},
		}),
	})
	err := reporter.Report(context.Background(), report)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want one session message report", client.calls)
	}
	if len(report.TimelineItems) != 0 {
		t.Fatalf("timeline items = %#v, want no legacy timeline output", report.TimelineItems)
	}
	if len(report.MessageUpdates) != 3 {
		t.Fatalf("message updates = %#v, want user message and call lifecycle updates", report.MessageUpdates)
	}
	if got := countEntityPatches(report.StatePatches); got != 0 {
		t.Fatalf("entity patches = %#v, count = %d, want no legacy timeline-derived entity patches", report.StatePatches, got)
	}
}

func TestReportActivityInputProjectsRuntimeMessagesToMessageUpdates(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	userEvent := newTurnActivityEventWithID(session, "user-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleUser, "inspect repo", map[string]any{
		"clientSubmitId": "submit-1",
		"messageId":      "client-submit:user:submit-1",
	})
	userEvent.OccurredAtUnixMS = 101
	assistantEvent := newTurnActivityEventWithID(session, "assistant-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "found README", map[string]any{
		"streamState":  messageStreamStateCompleted,
		"adapterExtra": "not-forwarded",
	})
	assistantEvent.OccurredAtUnixMS = 102
	thinkingEvent := newTurnActivityEventWithID(session, "thinking-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistantThinking, "checking files", map[string]any{
		"messageId":   "thinking-message-1",
		"streamState": messageStreamStateCompleted,
	})
	thinkingEvent.OwnerThreadID = "child-thread-1"
	thinkingEvent.OwnerCallID = "spawn-call-1"
	thinkingEvent.OccurredAtUnixMS = 103

	report := reportActivityInput(session, []activityshared.Event{userEvent, assistantEvent, thinkingEvent})

	if len(report.MessageUpdates) != 3 {
		t.Fatalf("message updates = %#v, want user, assistant, and reasoning updates", report.MessageUpdates)
	}
	user := report.MessageUpdates[0]
	if user.AgentSessionID != session.AgentSessionID ||
		user.MessageID != "client-submit:user:submit-1" ||
		user.Seq != uint64(userEvent.OccurredAtUnixMS) ||
		user.TurnID != "turn-1" ||
		user.Role != "user" ||
		user.Kind != "text" ||
		user.OccurredAtUnixMS != userEvent.OccurredAtUnixMS ||
		user.Payload["content"] != "inspect repo" ||
		user.Payload["source"] != "runtime" ||
		user.Payload["clientSubmitId"] != "submit-1" {
		t.Fatalf("user message update = %#v", user)
	}
	assistant := report.MessageUpdates[1]
	if assistant.MessageID != "assistant-event-1" ||
		assistant.Seq != uint64(assistantEvent.OccurredAtUnixMS) ||
		assistant.Role != "assistant" ||
		assistant.Kind != "text" ||
		assistant.Payload["content"] != "found README" ||
		assistant.Payload["source"] != "runtime" {
		t.Fatalf("assistant message update = %#v", assistant)
	}
	if _, ok := assistant.Payload["adapterExtra"]; ok {
		t.Fatalf("assistant message update payload = %#v, want compact UI payload", assistant.Payload)
	}
	thinking := report.MessageUpdates[2]
	if thinking.MessageID != "thinking-message-1" ||
		thinking.Seq != uint64(thinkingEvent.OccurredAtUnixMS) ||
		thinking.Role != "assistant" ||
		thinking.Kind != "reasoning" ||
		thinking.Payload["content"] != "checking files" ||
		thinking.Payload["source"] != "runtime" ||
		thinking.Payload["ownerThreadId"] != "child-thread-1" ||
		thinking.Payload["ownerCallId"] != "spawn-call-1" {
		t.Fatalf("thinking message update = %#v", thinking)
	}
}

func TestReportActivityInputProjectsDisplayPromptAndRichContent(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	userEvent := newTurnActivityEventWithID(session, "user-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleUser, "Run Automation", map[string]any{
		"messageId":     "user-message-1",
		"displayPrompt": "Run Automation",
		"content": []any{map[string]any{
			"type": "text",
			"text": "real automation prompt",
		}, map[string]any{
			"type":         "image",
			"mimeType":     "image/png",
			"attachmentId": "attachment-1",
			"data":         "base64-image-bytes",
		}},
	})
	userEvent.OccurredAtUnixMS = 101

	report := reportActivityInput(session, []activityshared.Event{userEvent})

	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one user update", report.MessageUpdates)
	}
	user := report.MessageUpdates[0]
	if user.Payload["text"] != "Run Automation" ||
		user.Payload["displayPrompt"] != "Run Automation" {
		t.Fatalf("user message payload = %#v, want text and displayPrompt", user.Payload)
	}
	content := payloadArray(user.Payload["content"])
	if len(content) != 2 {
		t.Fatalf("user message content = %#v, want rich content blocks", user.Payload["content"])
	}
	imageBlock := payloadObject(content[1])
	if _, exists := imageBlock["data"]; exists {
		t.Fatalf("user message image block retained data bytes: %#v", imageBlock)
	}
}

func TestReportActivityInputForwardsMessageKindToPayload(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	planEvent := newTurnActivityEventWithID(session, "plan-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "# Plan\n1. inspect", map[string]any{
		"messageId":   "plan-message-1",
		"streamState": messageStreamStateCompleted,
		"messageKind": "plan",
	})
	planEvent.OccurredAtUnixMS = 110

	report := reportActivityInput(session, []activityshared.Event{planEvent})
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one plan update", report.MessageUpdates)
	}
	plan := report.MessageUpdates[0]
	if plan.Payload["messageKind"] != "plan" {
		t.Fatalf("plan message payload = %#v, want messageKind=plan forwarded to the GUI", plan.Payload)
	}
}

func TestReportActivityInputForwardsSubAgentMarkerFieldsToPayload(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	marker := newTurnActivityEventWithID(session, "subagent-lifecycle:child-1:turn-1", EventMessage, "turn-1", "canceled", RoleAssistant, "", map[string]any{
		"messageId":               "subagent-lifecycle:child-1:turn-1",
		"contentMode":             messageContentModeSnapshot,
		"streamState":             "canceled",
		"messageKind":             "subAgentLifecycle",
		"subAgentLifecycleStatus": "canceled",
		"subAgentName":            "Repo smell analyst",
		"detail":                  "user requested",
		"ownerThreadId":           "child-1",
	})
	marker.OwnerThreadID = "child-1"
	marker.OccurredAtUnixMS = 120

	report := reportActivityInput(session, []activityshared.Event{marker})
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one marker update", report.MessageUpdates)
	}
	payload := report.MessageUpdates[0].Payload
	// The GUI settles lane status/identity from these fields; the reporter
	// must not strip them (observed live: markers stored without
	// subAgentLifecycleStatus left lanes running forever).
	if payload["subAgentLifecycleStatus"] != "canceled" ||
		payload["subAgentName"] != "Repo smell analyst" ||
		payload["detail"] != "user requested" {
		t.Fatalf("marker payload = %#v, want sub-agent fields forwarded", payload)
	}
}

func TestReportActivityInputForwardsSystemNoticeMetadataToPayload(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	noticeEvent := newTurnActivityEventWithID(session, "notice-event-1", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "Codex warning", map[string]any{
		"messageId":         "notice-message-1",
		"kind":              "agent_system_notice",
		"noticeKind":        "warning",
		"severity":          "warning",
		"title":             "Codex warning",
		"detail":            "Skill descriptions were shortened to fit the 2% skills context budget.",
		"additionalDetails": "Disable unused skills or plugins to leave more room for the rest.",
		"code":              "CODEX_VERSION_TOO_OLD",
		"retryable":         false,
		"streamState":       messageStreamStateCompleted,
	})
	noticeEvent.OccurredAtUnixMS = 111

	report := reportActivityInput(session, []activityshared.Event{noticeEvent})
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one notice update", report.MessageUpdates)
	}
	notice := report.MessageUpdates[0]
	if notice.Payload["kind"] != "agent_system_notice" ||
		notice.Payload["noticeKind"] != "warning" ||
		notice.Payload["severity"] != "warning" ||
		notice.Payload["title"] != "Codex warning" ||
		notice.Payload["detail"] != "Skill descriptions were shortened to fit the 2% skills context budget." ||
		notice.Payload["additionalDetails"] != "Disable unused skills or plugins to leave more room for the rest." ||
		notice.Payload["code"] != "CODEX_VERSION_TOO_OLD" ||
		notice.Payload["retryable"] != false {
		t.Fatalf("notice message payload = %#v, want system notice metadata forwarded to the GUI", notice.Payload)
	}
}

func TestReportActivityInputProjectsRuntimeCallsToStableMessageUpdates(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	started := newTurnActivityEventWithID(session, "call-event-start", EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read", map[string]any{
		"callId":   "call-1",
		"callType": "tool",
		"name":     "Read",
		"toolName": "Read",
		"input":    map[string]any{"path": "README.md"},
	})
	started.OccurredAtUnixMS = 201
	completed := newTurnActivityEventWithID(session, "call-event-complete", EventCallCompleted, "turn-1", messageStreamStateCompleted, "", "Read", map[string]any{
		"callId":   "call-1",
		"callType": "tool",
		"name":     "Read",
		"toolName": "Read",
		"output":   map[string]any{"text": "hello"},
	})
	completed.OccurredAtUnixMS = 202

	report := reportActivityInput(session, []activityshared.Event{started, completed})

	if len(report.MessageUpdates) != 2 {
		t.Fatalf("message updates = %#v, want start and completion updates", report.MessageUpdates)
	}
	startUpdate := report.MessageUpdates[0]
	if startUpdate.MessageID != "toolcall:call-1" ||
		startUpdate.Seq != uint64(started.OccurredAtUnixMS) ||
		startUpdate.TurnID != "turn-1" ||
		startUpdate.Role != "assistant" ||
		startUpdate.Kind != "tool_call" ||
		startUpdate.Status != "running" ||
		startUpdate.CallID != "call-1" ||
		startUpdate.Title != "Read" ||
		startUpdate.StartedAtUnixMS != started.OccurredAtUnixMS ||
		startUpdate.CompletedAtUnixMS != 0 ||
		startUpdate.Payload["source"] != "runtime" ||
		startUpdate.Payload["name"] != "Read" ||
		startUpdate.Payload["input"].(map[string]any)["path"] != "README.md" {
		t.Fatalf("started call update = %#v", startUpdate)
	}
	completeUpdate := report.MessageUpdates[1]
	if completeUpdate.MessageID != "toolcall:call-1" ||
		completeUpdate.Seq != uint64(completed.OccurredAtUnixMS) ||
		completeUpdate.Role != "assistant" ||
		completeUpdate.Kind != "tool_call" ||
		completeUpdate.Status != "completed" ||
		completeUpdate.CallID != "call-1" ||
		completeUpdate.Title != "Read" ||
		completeUpdate.StartedAtUnixMS != 0 ||
		completeUpdate.CompletedAtUnixMS != completed.OccurredAtUnixMS ||
		completeUpdate.Payload["source"] != "runtime" ||
		completeUpdate.Payload["name"] != "Read" ||
		completeUpdate.Payload["output"].(map[string]any)["text"] != "hello" {
		t.Fatalf("completed call update = %#v", completeUpdate)
	}
}

func TestReportActivityInputPreservesToolInputFromTerminalMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	completed := newTurnActivityEventWithID(session, "call-event-complete", EventCallCompleted, "turn-1", messageStreamStateCompleted, "", "Search web", map[string]any{
		"callId":   "call-1",
		"callType": "tool",
		"name":     "Search web",
		"toolName": "WebSearch",
		"input": map[string]any{
			"query": "opencode architecture",
		},
		"status": "completed",
	})
	completed.OccurredAtUnixMS = 202

	report := reportActivityInput(session, []activityshared.Event{completed})

	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one", report.MessageUpdates)
	}
	update := report.MessageUpdates[0]
	input, _ := update.Payload["input"].(map[string]any)
	if update.Title != "WebSearch" || update.Payload["toolName"] != "WebSearch" || input["query"] != "opencode architecture" {
		t.Fatalf("terminal tool message update = %#v, want metadata input and tool name", update)
	}
}

func TestReportActivityInputDoesNotUseCallIDAsMessageUpdateTitle(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	callID := "call_SMAI3q45S9s5TwOqO8R7ZMdU"
	started := newTurnActivityEventWithID(session, "call-event-start", EventCallStarted, "turn-1", messageStreamStateStreaming, "", callID, map[string]any{
		"callId":   callID,
		"callType": "tool",
		"name":     callID,
		"toolName": "Bash",
		"input":    map[string]any{"command": "pwd"},
	})
	started.OccurredAtUnixMS = 203

	report := reportActivityInput(session, []activityshared.Event{started})

	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want one call update", report.MessageUpdates)
	}
	update := report.MessageUpdates[0]
	if update.Title != "Bash" {
		t.Fatalf("message update title = %q, want canonical tool title", update.Title)
	}
	if got := update.Payload["name"]; got != "Bash" {
		t.Fatalf("message update payload = %#v, want canonical name", update.Payload)
	}
	if got := update.Payload["toolName"]; got != "Bash" {
		t.Fatalf("message update payload = %#v, want canonical toolName", update.Payload)
	}
}

func TestReportActivityInputCanonicalizesToolNamesAcrossAgents(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	tests := []struct {
		name        string
		payloadName string
		metadata    map[string]any
		wantTool    string
		wantName    string
	}{
		{
			name:        "codex exec command becomes bash",
			payloadName: "exec_command",
			metadata:    map[string]any{"toolName": "exec_command"},
			wantTool:    "Bash",
			wantName:    "Bash",
		},
		{
			name:        "gemini shell command becomes bash",
			payloadName: "run_shell_command",
			metadata:    map[string]any{"toolName": "run_shell_command"},
			wantTool:    "Bash",
			wantName:    "Bash",
		},
		{
			name:        "subagent task becomes agent",
			payloadName: "run_subagent",
			metadata:    map[string]any{"toolName": "Task"},
			wantTool:    "Agent",
			wantName:    "Agent",
		},
		{
			name:        "delegate task becomes agent",
			payloadName: "delegate_task",
			metadata:    map[string]any{"toolName": "delegate_task"},
			wantTool:    "Agent",
			wantName:    "Agent",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			event := newTurnActivityEventWithID(session, "call-event-"+tt.name, EventCallStarted, "turn-1", messageStreamStateStreaming, "", tt.payloadName, map[string]any{
				"callId":   "call-" + strings.ReplaceAll(tt.name, " ", "-"),
				"callType": "tool",
				"name":     tt.payloadName,
				"input":    map[string]any{"command": "pwd"},
			})
			for key, value := range tt.metadata {
				event.Payload.Metadata[key] = value
			}
			event.OccurredAtUnixMS = 204

			report := reportActivityInput(session, []activityshared.Event{event})
			if len(report.MessageUpdates) != 1 {
				t.Fatalf("message updates = %#v, want one call update", report.MessageUpdates)
			}
			update := report.MessageUpdates[0]
			if got := update.Payload["toolName"]; got != tt.wantTool {
				t.Fatalf("message update payload = %#v, want toolName %q", update.Payload, tt.wantTool)
			}
			if got := update.Title; got != tt.wantName {
				t.Fatalf("message update title = %q, want %q", got, tt.wantName)
			}
			if got := update.Payload["name"]; got != tt.wantName {
				t.Fatalf("message update payload = %#v, want name %q", update.Payload, tt.wantName)
			}
		})
	}
}

func TestReporterSendsRuntimeMessageOnlyReport(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	message := newTurnActivityEventWithID(session, "assistant-message-only", EventMessage, "turn-1", messageStreamStateStreaming, RoleAssistant, "streaming", map[string]any{
		"streamState": messageStreamStateStreaming,
	})
	message.OccurredAtUnixMS = 301
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	err := reporter.Report(context.Background(), reportActivityInput(session, []activityshared.Event{message}))
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want one message report", client.calls)
	}
	if len(client.messageInputs[0].Updates) != 1 {
		t.Fatalf("reported message updates = %#v, want one", client.messageInputs[0].Updates)
	}
	if len(client.stateInputs) != 0 {
		t.Fatalf("reported state inputs = %#v, want message-only report", client.stateInputs)
	}
}

func TestReporterProjectsCanonicalFieldsFromStartedAndCompletedCallsToMessageUpdates(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	updates := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "call-2-item", EventCallStarted, "turn-2", messageStreamStateStreaming, "", "Run command", map[string]any{
			"callId":   "call-2",
			"callType": "tool",
			"name":     "Run command",
			"toolName": "Bash",
			"input": map[string]any{
				"command": "ls -la",
				"cwd":     "/workspace/app",
			},
		}),
		newTurnActivityEventWithID(session, "call-2-item", EventCallCompleted, "turn-2", messageStreamStateCompleted, "", "Run command", map[string]any{
			"callId":   "call-2",
			"callType": "tool",
			"name":     "Run command",
			"toolName": "Bash",
			"output": map[string]any{
				"stdout": "README.md\n",
			},
			"error": map[string]any{
				"stderr": "warning: truncated\n",
			},
		}),
	}).MessageUpdates

	if len(updates) != 2 {
		t.Fatalf("message updates = %#v, want start and completion updates", updates)
	}
	if updates[0].MessageID != updates[1].MessageID {
		t.Fatalf("message updates = %#v, want stable message id across lifecycle", updates)
	}
	if got := updates[0].Payload["toolName"]; got != "Bash" {
		t.Fatalf("payload = %#v, want canonical toolName", updates[0].Payload)
	}
	if got := updates[0].Payload["input"].(map[string]any)["command"]; got != "ls -la" {
		t.Fatalf("payload = %#v, want started input preserved", updates[0].Payload)
	}
	if got := updates[1].Payload["output"].(map[string]any)["stdout"]; got != "README.md\n" {
		t.Fatalf("payload = %#v, want completed output preserved", updates[1].Payload)
	}
	if got := updates[1].Payload["output"].(map[string]any)["text"]; got != "README.md" {
		t.Fatalf("payload = %#v, want canonical output text", updates[1].Payload)
	}
	if got := updates[1].Payload["error"].(map[string]any)["stderr"]; got != "warning: truncated\n" {
		t.Fatalf("payload = %#v, want completed error preserved", updates[1].Payload)
	}
	if got := updates[1].Payload["error"].(map[string]any)["text"]; got != "warning: truncated" {
		t.Fatalf("payload = %#v, want canonical error text", updates[1].Payload)
	}
	if got := updates[1].Status; got != "completed" {
		t.Fatalf("completed update = %#v, want completed status preserved", updates[1])
	}
}

func TestReporterProjectsStandardACPToolLifecycleToStableMessageUpdates(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.Provider = ProviderGemini
	updates := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "stable-tool-item", EventCallStarted, "turn-std", messageStreamStateStreaming, "", "Bash", map[string]any{
			"callId":   "tool-std-1",
			"callType": "tool",
			"name":     "Bash",
			"input": map[string]any{
				"command": "pwd",
			},
		}),
		newTurnActivityEventWithID(session, "stable-tool-item", EventCallCompleted, "turn-std", messageStreamStateCompleted, "", "Bash", map[string]any{
			"callId":   "tool-std-1",
			"callType": "tool",
			"name":     "Bash",
			"output": map[string]any{
				"stdout": "/workspace/app\n",
			},
		}),
	}).MessageUpdates

	if len(updates) != 2 {
		t.Fatalf("message updates = %#v, want start and completion updates", updates)
	}
	if updates[0].MessageID != updates[1].MessageID || updates[1].CallID != "tool-std-1" {
		t.Fatalf("message updates = %#v, want stable call message for tool-std-1", updates)
	}
	if got := updates[0].Payload["input"].(map[string]any)["command"]; got != "pwd" {
		t.Fatalf("payload = %#v, want preserved input", updates[0].Payload)
	}
	if got := updates[1].Payload["output"].(map[string]any)["stdout"]; got != "/workspace/app\n" {
		t.Fatalf("payload = %#v, want preserved output", updates[1].Payload)
	}
	if got := updates[1].Payload["output"].(map[string]any)["text"]; got != "/workspace/app" {
		t.Fatalf("payload = %#v, want canonical output text", updates[1].Payload)
	}
}

func TestReporterCanonicalizesToolOutputTextFromContentBlocks(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	report := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "web-search-complete", EventCallCompleted, "turn-web", messageStreamStateCompleted, "", "WebSearch", map[string]any{
			"callId":   "call-web",
			"callType": "tool",
			"name":     "WebSearch",
			"toolName": "WebSearch",
			"output": map[string]any{
				"content": []any{
					map[string]any{
						"type": "tool_result",
						"text": "Web search results for query: \"Tokyo weather\"",
					},
				},
			},
		}),
	})

	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want 1", report.MessageUpdates)
	}
	output, _ := report.MessageUpdates[0].Payload["output"].(map[string]any)
	if got := output["text"]; got != "Web search results for query: \"Tokyo weather\"" {
		t.Fatalf("output = %#v, want canonical output text from content blocks", output)
	}
}

func TestReporterProjectsFailedCallOutputAlongsideError(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	report := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "failed-call-item", EventCallFailed, "turn-failed", messageStreamStateFailed, "", "Run command", map[string]any{
			"callId":   "call-failed",
			"callType": "tool",
			"name":     "Run command",
			"toolName": "Bash",
			"output": map[string]any{
				"aggregated_output": "fatal: not a git repository\n",
				"stderr":            "fatal: not a git repository\n",
			},
			"error": map[string]any{
				"message":           "fatal: not a git repository",
				"aggregated_output": "fatal: not a git repository\n",
			},
		}),
	})

	if len(report.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want 1", report.MessageUpdates)
	}
	item := report.MessageUpdates[0]
	if item.Kind != "tool_call" || item.Status != "failed" {
		t.Fatalf("message update = %#v, want failed call snapshot", item)
	}
	output, _ := item.Payload["output"].(map[string]any)
	if got := output["aggregated_output"]; got != "fatal: not a git repository\n" {
		t.Fatalf("timeline payload = %#v, want mirrored output", item.Payload)
	}
	errorPayload, _ := item.Payload["error"].(map[string]any)
	if got := errorPayload["message"]; got != "fatal: not a git repository" {
		t.Fatalf("timeline payload = %#v, want error payload preserved", item.Payload)
	}
	if got := countEntityPatches(report.StatePatches); got != 0 {
		t.Fatalf("entity patches = %#v, count = %d, want no legacy entity patches", report.StatePatches, got)
	}
}

func TestSummarizeReportActivityInputForLog(t *testing.T) {
	t.Parallel()

	report := reportActivityInput(reportTestSession(), []activityshared.Event{
		newTurnActivityEventWithID(reportTestSession(), "call-3-item", EventCallStarted, "turn-3", messageStreamStateStreaming, "", "Run command", map[string]any{
			"callId":   "call-3",
			"callType": "tool",
			"name":     "Run command",
			"input": map[string]any{
				"command": "pwd",
			},
		}),
		newTurnActivityEventWithID(reportTestSession(), "call-3-item", EventCallCompleted, "turn-3", messageStreamStateCompleted, "", "Run command", map[string]any{
			"callId":   "call-3",
			"callType": "tool",
			"name":     "Run command",
			"output": map[string]any{
				"stdout": "/workspace/app\n",
			},
		}),
	})

	messageUpdates, statePatches := SummarizeReportActivityInputForLog(report)
	if len(messageUpdates) != 2 {
		t.Fatalf("message update summary = %#v, want started and completed updates", messageUpdates)
	}
	if !strings.Contains(messageUpdates[0], "tool_call") ||
		!strings.Contains(messageUpdates[0], "body=input") ||
		!strings.Contains(messageUpdates[1], "body=output") {
		t.Fatalf("message update summary = %#v, want started input and completed output", messageUpdates)
	}
	if len(statePatches) != 0 {
		t.Fatalf("state patch summary = %#v, want no legacy entity patches", statePatches)
	}
}

func TestSummarizeReportActivityInputForLogIncludesFailedCallDiagnostics(t *testing.T) {
	t.Parallel()

	report := reportActivityInput(reportTestSession(), []activityshared.Event{
		newTurnActivityEventWithID(reportTestSession(), "call-failed-item", EventCallFailed, "turn-failed", messageStreamStateFailed, "", "Generate document", map[string]any{
			"callId":   "call-failed",
			"callType": "tool",
			"name":     "Generate document",
			"toolName": "document-generator",
			"output": map[string]any{
				"stderr": "render failed after loading template\nmore verbose output omitted",
			},
			"error": map[string]any{
				"message": "render failed after loading template\ncaused by missing placeholder",
			},
		}),
	})

	messageUpdates, statePatches := SummarizeReportActivityInputForLog(report)
	if len(messageUpdates) != 1 {
		t.Fatalf("message update summary = %#v, want failed call update", messageUpdates)
	}
	summary := messageUpdates[0]
	if !strings.Contains(summary, "tool_call") ||
		!strings.Contains(summary, "failed") ||
		!strings.Contains(summary, "body=output+error") ||
		!strings.Contains(summary, "name=document-generator") ||
		!strings.Contains(summary, `error="render failed after loading template caused by missing placeholder"`) {
		t.Fatalf("message update summary = %#v, want failed call diagnostics", messageUpdates)
	}
	if len(statePatches) != 0 {
		t.Fatalf("state patch summary = %#v, want no legacy entity patches", statePatches)
	}
}

func TestSummarizeReportActivityInputForLogDoesNotExpandNonCallErrors(t *testing.T) {
	t.Parallel()

	report := agentsessionstore.ReportActivityInput{
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{
			{
				MessageID: "message-failed",
				Kind:      "text",
				Status:    "failed",
				Payload: map[string]any{
					"error": map[string]any{
						"message": "provider returned internal failure details",
					},
				},
			},
		},
	}

	messageUpdates, statePatches := SummarizeReportActivityInputForLog(report)
	if len(messageUpdates) != 1 {
		t.Fatalf("message update summary = %#v, want failed text update", messageUpdates)
	}
	if strings.Contains(messageUpdates[0], "provider returned internal failure details") ||
		strings.Contains(messageUpdates[0], "error=") {
		t.Fatalf("message update summary = %#v, want no expanded non-call error", messageUpdates)
	}
	if len(statePatches) != 0 {
		t.Fatalf("state patch summary = %#v, want no legacy entity patches", statePatches)
	}
}

func TestSummarizeLogValueCountsCollapsesRepeatedValues(t *testing.T) {
	t.Parallel()

	got := summarizeLogValueCounts([]string{
		"message.appended",
		"message.appended",
		"message.appended",
		"turn.completed",
		"message.appended",
	})
	want := []string{"message.appended=4", "turn.completed=1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("summary = %#v, want %#v", got, want)
	}
}

func TestReporterProjectsSessionAndTurnLifecycleToStatePatches(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	input := reportActivityInput(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
		newTurnActivityEventWithID(session, "turn-start-1", EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil),
		newTurnActivityEventWithID(session, "turn-done-1", EventTurnCompleted, "turn-1", SessionStatusReady, "", "", nil),
	})
	err := reporter.Report(context.Background(), input)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 3 {
		t.Fatalf("calls = %d, want 3 state reports", client.calls)
	}
	if len(input.TimelineItems) != 0 {
		t.Fatalf("timeline items = %#v, want none for lifecycle-only report", input.TimelineItems)
	}
	if len(input.StatePatches) != 3 {
		t.Fatalf("state patches = %#v, want 3", input.StatePatches)
	}
	if input.StatePatches[0].LifecycleStatus != string(activityshared.SessionLifecycleStatusActive) {
		t.Fatalf("session patch = %#v", input.StatePatches[0])
	}
	if input.StatePatches[1].Turn == nil ||
		input.StatePatches[1].Turn.TurnID != "turn-1" ||
		input.StatePatches[1].Turn.StartedAtUnixMS == 0 ||
		input.StatePatches[1].CurrentPhase != string(activityshared.TurnPhaseWorking) {
		t.Fatalf("turn started patch = %#v", input.StatePatches[1])
	}
	if input.StatePatches[2].Turn == nil ||
		input.StatePatches[2].Turn.CompletedAtUnixMS == 0 ||
		input.StatePatches[2].Turn.ActiveTurnID != nil ||
		input.StatePatches[2].Turn.Phase != "settled" ||
		input.StatePatches[2].Turn.Outcome != "completed" ||
		input.StatePatches[2].Turn.SubmitAvailability == nil ||
		input.StatePatches[2].Turn.SubmitAvailability.State != "available" ||
		input.StatePatches[2].TurnLifecycle == nil ||
		input.StatePatches[2].TurnLifecycle.ActiveTurnID != nil ||
		input.StatePatches[2].TurnLifecycle.Phase != "settled" ||
		input.StatePatches[2].TurnLifecycle.Outcome == nil ||
		*input.StatePatches[2].TurnLifecycle.Outcome != "completed" ||
		input.StatePatches[2].SubmitAvailability == nil ||
		input.StatePatches[2].SubmitAvailability.State != "available" ||
		input.StatePatches[2].CurrentPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("turn completed patch = %#v", input.StatePatches[2])
	}
}

func TestReporterProjectsSessionCompletedWithServerLifecycleStatus(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	input := reportActivityInput(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionCompleted, SessionStatusCompleted, nil),
	})
	err := reporter.Report(context.Background(), input)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want 1", client.calls)
	}
	if len(input.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want 1", input.StatePatches)
	}
	if input.StatePatches[0].LifecycleStatus != "completed" ||
		input.StatePatches[0].CurrentPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("state patch = %#v, want server-compatible completed lifecycle", input.StatePatches[0])
	}
}

func TestReporterProjectsReadySessionUpdateAsIdlePhase(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	input := reportActivityInput(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, nil),
	})
	err := reporter.Report(context.Background(), input)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 1 {
		t.Fatalf("calls = %d, want 1", client.calls)
	}
	if len(input.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want 1", input.StatePatches)
	}
	if input.StatePatches[0].CurrentPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("state patch = %#v, want ready status projected as idle phase", input.StatePatches[0])
	}
}

func TestReporterProjectsTurnFailureErrorToStatePatch(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	input := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "turn-failed-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "API Error: 403 Key limit exceeded (total limit)",
		}),
	})
	err := reporter.Report(context.Background(), input)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if client.calls != 2 {
		t.Fatalf("calls = %d, want state and visible failure message reports", client.calls)
	}
	if len(client.stateInputs) != 1 {
		t.Fatalf("state inputs = %#v, want 1", client.stateInputs)
	}
	if len(client.messageInputs) != 1 {
		t.Fatalf("message inputs = %#v, want visible failure message", client.messageInputs)
	}
	if len(input.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want 1", input.StatePatches)
	}
	if input.StatePatches[0].CurrentPhase != string(activityshared.TurnPhaseIdle) ||
		input.StatePatches[0].Turn == nil ||
		input.StatePatches[0].Turn.ActiveTurnID != nil ||
		input.StatePatches[0].Turn.Phase != "settled" ||
		input.StatePatches[0].Turn.Outcome != "failed" ||
		input.StatePatches[0].Turn.SubmitAvailability == nil ||
		input.StatePatches[0].Turn.SubmitAvailability.State != "available" ||
		input.StatePatches[0].TurnLifecycle == nil ||
		input.StatePatches[0].TurnLifecycle.ActiveTurnID != nil ||
		input.StatePatches[0].TurnLifecycle.Phase != "settled" ||
		input.StatePatches[0].TurnLifecycle.Outcome == nil ||
		*input.StatePatches[0].TurnLifecycle.Outcome != "failed" ||
		input.StatePatches[0].SubmitAvailability == nil ||
		input.StatePatches[0].SubmitAvailability.State != "available" {
		t.Fatalf("turn failed patch = %#v", input.StatePatches[0])
	}
	if input.StatePatches[0].LastError != "Codex request failed because a quota or rate limit was reached." {
		t.Fatalf("last error = %q, want projected failure reason", input.StatePatches[0].LastError)
	}
	if len(input.MessageUpdates) != 1 {
		t.Fatalf("message updates = %#v, want visible failure message", input.MessageUpdates)
	}
	item := input.MessageUpdates[0]
	if item.Kind != "text" ||
		item.Status != messageStreamStateFailed ||
		item.Payload["kind"] != visibleErrorKind ||
		item.Payload["code"] != "quota_or_rate_limit" {
		t.Fatalf("visible failure message update = %#v", item)
	}
	if item.Payload["detail"] != "API Error: 403 Key limit exceeded (total limit)" {
		t.Fatalf("visible failure detail = %#v", item.Payload["detail"])
	}
}

func TestReporterDoesNotSendEmptyOrUnreportableBatches(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	client := &retryingActivityClient{}
	reporter := Reporter{
		ClientProvider: func() ActivityClient { return client },
		MaxAttempts:    1,
	}

	if err := reporter.Report(context.Background(), reportActivityInput(session, []activityshared.Event{
		{Type: activityshared.EventPresenceHeartbeat},
	})); err != nil {
		t.Fatalf("Report unreportable: %v", err)
	}
	if client.calls != 0 {
		t.Fatalf("calls after unreportable batch = %d, want 0", client.calls)
	}

	if err := reporter.Report(context.Background(), reportActivityInput(Session{}, []activityshared.Event{
		{Type: activityshared.EventMessageAppended, EventID: "message-without-session"},
	})); err != nil {
		t.Fatalf("Report empty projection: %v", err)
	}
	if client.calls != 0 {
		t.Fatalf("calls after empty projection = %d, want 0", client.calls)
	}
}

func reportTestSession() Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
		Status:            SessionStatusReady,
		Title:             "Codex",
		CreatedAtUnixMS:   1,
		UpdatedAtUnixMS:   1,
	}
}

func countEntityPatches(patches []agentsessionstore.WorkspaceAgentStatePatch) int {
	count := 0
	for _, patch := range patches {
		count += len(patch.Entities)
	}
	return count
}

func mixedMessageUpdateReportInput() agentsessionstore.ReportActivityInput {
	return agentsessionstore.ReportActivityInput{
		WorkspaceID: "room-1",
		Source: agentsessionstore.EventSource{
			Provider: "codex",
			AgentID:  "agent-session-1",
		},
		TimelineItems: []agentsessionstore.WorkspaceAgentTimelineItem{{
			AgentSessionID: "agent-session-1",
			EventID:        "event-1",
			ItemType:       "message.assistant",
		}},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-session-1",
			CurrentPhase:   "working",
		}},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "agent-session-1",
			MessageID:      "message-1",
			TurnID:         "turn-1",
			Seq:            1,
			Role:           "assistant",
			Kind:           "text",
			Payload:        map[string]any{"text": "hello"},
		}},
	}
}

func ptrReportActivityReply(reply agentsessionstore.ReportActivityReply) *agentsessionstore.ReportActivityReply {
	return &reply
}
