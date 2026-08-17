package agentruntime

import (
	"encoding/json"
	"strings"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestACPNormalizerProjectsSemanticMessageDeltaWithoutSnapshotDiff(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	normalizer := newACPTurnNormalizer()

	first := normalizer.AppendAssistantChunk(session, "turn-1", "Hel")
	second := normalizer.AppendAssistantChunk(session, "turn-1", "Hello")
	stream := ProjectActivityEventsToStreamEvents(session, append(first, second...))
	if len(stream) != 2 || stream[0].EventType != StreamEventMessageDelta || stream[1].EventType != StreamEventMessageDelta {
		t.Fatalf("stream = %#v, want two message deltas", stream)
	}
	firstDelta := stream[0].Data.(liveprotocol.Event)
	secondDelta := stream[1].Data.(liveprotocol.Event)
	var firstData, secondData liveprotocol.MessageDeltaData
	if err := json.Unmarshal(firstDelta.Data, &firstData); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(secondDelta.Data, &secondData); err != nil {
		t.Fatal(err)
	}
	if firstData.Content == nil || firstData.Content.Operation != "set" || string(firstData.Content.Value) != `"Hel"` {
		t.Fatalf("first delta = %#v", firstData)
	}
	if secondData.Content == nil || secondData.Content.Operation != "append_text" || secondData.Content.Text != "lo" {
		t.Fatalf("second delta = %#v", secondData)
	}

	terminal := normalizer.FinishCompleted(session, "turn-1")
	if got := ProjectActivityEventsToStreamEvents(session, terminal); len(got) != 0 {
		t.Fatalf("precommit terminal leaked to live stream: %#v", got)
	}
}

func TestSnapshotNormalizerProjectsSuffixAppendAndFullRewrite(t *testing.T) {
	t.Parallel()
	session := reportTestSession()

	tests := []struct {
		name  string
		apply func(*acpTurnNormalizer, string) []activityshared.Event
		role  string
		kind  string
	}{
		{
			name: "assistant",
			apply: func(normalizer *acpTurnNormalizer, snapshot string) []activityshared.Event {
				return normalizer.ApplyStreamingAssistantSnapshot(
					session,
					"turn-1",
					snapshot,
					"assistant-1",
				)
			},
			role: RoleAssistant,
			kind: "text",
		},
		{
			name: "thinking",
			apply: func(normalizer *acpTurnNormalizer, snapshot string) []activityshared.Event {
				return normalizer.ApplyStreamingThinkingSnapshot(
					session,
					"turn-1",
					snapshot,
					"thinking-1",
				)
			},
			role: RoleAssistantThinking,
			kind: "reasoning",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			normalizer := newACPTurnNormalizer()

			assertSnapshotLiveOperation(
				t,
				test.apply(normalizer, "Hel"),
				test.role,
				test.kind,
				"set",
				"Hel",
			)
			assertSnapshotLiveOperation(
				t,
				test.apply(normalizer, "Hello"),
				test.role,
				test.kind,
				"append_text",
				"lo",
			)
			if duplicate := test.apply(normalizer, "Hello"); len(duplicate) != 0 {
				t.Fatalf("duplicate snapshot events = %#v, want none", duplicate)
			}
			assertSnapshotLiveOperation(
				t,
				test.apply(normalizer, "Help"),
				test.role,
				test.kind,
				"set",
				"Help",
			)
		})
	}
}

func assertSnapshotLiveOperation(
	t *testing.T,
	events []activityshared.Event,
	wantRole string,
	wantKind string,
	wantOperation string,
	wantContent string,
) {
	t.Helper()
	if len(events) != 1 {
		t.Fatalf("events = %#v, want one snapshot event", events)
	}
	event := events[0]
	if string(event.Payload.Role) != wantRole ||
		event.Payload.Metadata[liveMessageKindMetadataKey] != wantKind {
		t.Fatalf("snapshot identity = role %q metadata %#v", event.Payload.Role, event.Payload.Metadata)
	}
	operation, ok := event.Payload.Metadata[liveContentOperationMetadataKey].(*liveprotocol.MessageContentOperation)
	if !ok || operation == nil || operation.Operation != wantOperation {
		t.Fatalf("live operation = %#v, want %q", operation, wantOperation)
	}
	switch wantOperation {
	case "append_text":
		if operation.Text != wantContent || len(operation.Value) != 0 {
			t.Fatalf("append operation = %#v, want suffix %q", operation, wantContent)
		}
	case "set":
		var content string
		if err := json.Unmarshal(operation.Value, &content); err != nil {
			t.Fatal(err)
		}
		if content != wantContent || operation.Text != "" {
			t.Fatalf("set operation = %#v content %q, want %q", operation, content, wantContent)
		}
	}
}

func TestThinkingDeltaPreservesAssistantThinkingRole(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events := normalizer.AppendThinkingChunk(session, "turn-1", "inspect")
	stream := ProjectActivityEventsToStreamEvents(session, events)
	if len(stream) != 1 {
		t.Fatalf("stream = %#v", stream)
	}
	event := stream[0].Data.(liveprotocol.Event)
	var data liveprotocol.MessageDeltaData
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Role != RoleAssistantThinking || data.Kind != "reasoning" {
		t.Fatalf("thinking delta = %#v", data)
	}
}

func TestExplicitToolOutputDeltaPersistsSnapshotAndProjectsOffsetAppend(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "command-1",
		"title":         "printf",
		"kind":          "execute",
		"status":        "in_progress",
		"rawInput":      map[string]any{"command": "printf"},
	})
	if !ok || len(started) != 1 {
		t.Fatalf("started = %#v, ok = %v", started, ok)
	}

	first := normalizer.AppendToolOutputDelta(session, "turn-1", "command-1", "你")
	second := normalizer.AppendToolOutputDelta(session, "turn-1", "command-1", "好\n")
	stream := ProjectActivityEventsToStreamEvents(session, append(first, second...))
	if len(stream) != 2 {
		t.Fatalf("stream = %#v, want two tool output deltas", stream)
	}
	var firstDelta, secondDelta liveprotocol.MessageDeltaData
	for index, target := range []*liveprotocol.MessageDeltaData{&firstDelta, &secondDelta} {
		event, ok := stream[index].Data.(liveprotocol.Event)
		if !ok {
			t.Fatalf("stream[%d] data = %T", index, stream[index].Data)
		}
		if err := json.Unmarshal(event.Data, target); err != nil {
			t.Fatal(err)
		}
	}
	if firstDelta.ToolOutput == nil ||
		firstDelta.ToolOutput.Operation != "set" ||
		firstDelta.ToolOutput.Text != "你" ||
		firstDelta.ToolOutput.OffsetBytes != nil {
		t.Fatalf("first tool output = %#v", firstDelta.ToolOutput)
	}
	if secondDelta.ToolOutput == nil ||
		secondDelta.ToolOutput.Operation != "append_text" ||
		secondDelta.ToolOutput.Text != "好\n" ||
		secondDelta.ToolOutput.OffsetBytes == nil ||
		*secondDelta.ToolOutput.OffsetBytes != int64(len("你")) {
		t.Fatalf("second tool output = %#v", secondDelta.ToolOutput)
	}

	report := reportActivityInput(session, second)
	if len(report.MessageUpdates) != 1 {
		t.Fatalf("report = %#v, want one cumulative tool snapshot", report)
	}
	startReport := reportActivityInput(session, started)
	if len(startReport.MessageUpdates) != 1 {
		t.Fatalf("start report = %#v, want one canonical tool anchor", startReport)
	}
	if firstDelta.MessageID != startReport.MessageUpdates[0].MessageID ||
		secondDelta.MessageID != startReport.MessageUpdates[0].MessageID ||
		report.MessageUpdates[0].MessageID != startReport.MessageUpdates[0].MessageID {
		t.Fatalf(
			"tool message identity = start:%q first:%q second:%q snapshot:%q, want one canonical anchor",
			startReport.MessageUpdates[0].MessageID,
			firstDelta.MessageID,
			secondDelta.MessageID,
			report.MessageUpdates[0].MessageID,
		)
	}
	output, _ := report.MessageUpdates[0].Payload["output"].(map[string]any)
	if output["text"] != "你好\n" {
		t.Fatalf("persisted output = %#v", output)
	}
}

func TestExplicitToolOutputDeltaTruncatesOnceAndDropsLaterChunks(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "command-large",
		"title":         "printf",
		"kind":          "execute",
		"status":        "in_progress",
	})
	if !ok || len(started) != 1 {
		t.Fatalf("started = %#v, ok = %v", started, ok)
	}

	firstLength := canonical.ToolOutputTextMaxBytes -
		len(canonical.ToolOutputTruncationMarker) -
		len("\n") -
		8
	if events := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"command-large",
		strings.Repeat("x", firstLength),
	); len(events) != 1 {
		t.Fatalf("first output events = %#v, want one", events)
	}
	truncated := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"command-large",
		strings.Repeat("y", 64),
	)
	if len(truncated) != 1 {
		t.Fatalf("truncated output events = %#v, want one", truncated)
	}
	if later := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"command-large",
		"ignored",
	); len(later) != 0 {
		t.Fatalf("later output events = %#v, want dropped after truncation", later)
	}

	output := payloadMap(truncated[0].Payload.Metadata, "output")["text"].(string)
	if len(output) > canonical.ToolOutputTextMaxBytes ||
		!strings.HasSuffix(output, canonical.ToolOutputTruncationMarker) {
		t.Fatalf("snapshot output was not bounded: %d bytes", len(output))
	}
	stream := ProjectActivityEventsToStreamEvents(session, truncated)
	if len(stream) != 1 || stream[0].EventType != StreamEventMessageDelta {
		t.Fatalf("stream = %#v, want one tool output delta", stream)
	}
	var delta liveprotocol.MessageDeltaData
	if err := json.Unmarshal(stream[0].Data.(liveprotocol.Event).Data, &delta); err != nil {
		t.Fatal(err)
	}
	if delta.ToolOutput == nil ||
		delta.ToolOutput.Operation != "append_text" ||
		delta.ToolOutput.OffsetBytes == nil ||
		*delta.ToolOutput.OffsetBytes != int64(firstLength) ||
		!strings.HasSuffix(delta.ToolOutput.Text, canonical.ToolOutputTruncationMarker) {
		t.Fatalf("truncated live operation = %#v", delta.ToolOutput)
	}

	report := reportActivityInput(session, truncated)
	persisted := report.MessageUpdates[0].Payload["output"].(map[string]any)["text"].(string)
	if persisted != output {
		t.Fatal("live runtime snapshot and durable report used different truncated output")
	}
}

func TestToolOutputDeltaWaitsForKnownStartAnchor(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	if events := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"missing-command",
		"first",
	); len(events) != 0 {
		t.Fatalf("pre-anchor output events = %#v, want no invented anchor", events)
	}
	started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "missing-command",
		"title":         "printf",
		"kind":          "execute",
		"status":        "in_progress",
	})
	if !ok || len(started) != 2 {
		t.Fatalf("started = %#v, ok = %v, want anchor followed by buffered output", started, ok)
	}
	if started[0].Type != activityshared.EventCallStarted ||
		started[1].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v", started)
	}
	stream := ProjectActivityEventsToStreamEvents(session, started)
	if len(stream) != 2 ||
		stream[0].EventType != StreamEventMessageUpdate ||
		stream[1].EventType != StreamEventMessageDelta {
		t.Fatalf("stream = %#v, want canonical anchor then live output", stream)
	}
	var delta liveprotocol.MessageDeltaData
	if err := json.Unmarshal(stream[1].Data.(liveprotocol.Event).Data, &delta); err != nil {
		t.Fatal(err)
	}
	if delta.ToolOutput == nil ||
		delta.ToolOutput.Operation != "set" ||
		delta.ToolOutput.Text != "first" {
		t.Fatalf("buffered tool output = %#v", delta.ToolOutput)
	}
}

func TestToolOutputDeltaTruncatesBufferedPreAnchorOutput(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	large := strings.Repeat("x", canonical.ToolOutputTextMaxBytes+64)
	if events := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"buffered-large-command",
		large,
	); len(events) != 0 {
		t.Fatalf("pre-anchor output events = %#v, want buffered output", events)
	}
	started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "buffered-large-command",
		"title":         "printf",
		"kind":          "execute",
		"status":        "in_progress",
	})
	if !ok || len(started) != 2 {
		t.Fatalf("started = %#v, ok = %v, want anchor and truncated buffered output", started, ok)
	}
	output := payloadMap(started[1].Payload.Metadata, "output")["text"].(string)
	if len(output) > canonical.ToolOutputTextMaxBytes ||
		!strings.HasSuffix(output, canonical.ToolOutputTruncationMarker) {
		t.Fatalf("buffered output was not bounded: %d bytes", len(output))
	}
	if later := normalizer.AppendToolOutputDelta(
		session,
		"turn-1",
		"buffered-large-command",
		"ignored",
	); len(later) != 0 {
		t.Fatalf("later output events = %#v, want dropped after buffered truncation", later)
	}
}

func TestTruncatedBufferedToolOutputFitsLivePublisher(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name  string
		large string
	}{
		{
			name:  "ASCII",
			large: strings.Repeat("x", canonical.ToolOutputTextMaxBytes+64),
		},
		{
			name:  "JSON escaping",
			large: strings.Repeat("\x00", canonical.ToolOutputTextMaxBytes+64),
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			session := reportTestSession()
			normalizer := newACPTurnNormalizer()
			if events := normalizer.AppendToolOutputDelta(
				session,
				"turn-1",
				"buffered-large-command",
				test.large,
			); len(events) != 0 {
				t.Fatalf("pre-anchor output events = %#v, want buffered output", events)
			}
			started, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "buffered-large-command",
				"title":         "printf",
				"kind":          "execute",
				"status":        "in_progress",
			})
			if !ok || len(started) != 2 {
				t.Fatalf("started = %#v, ok = %v, want anchor and buffered output", started, ok)
			}
			expected := payloadMap(started[1].Payload.Metadata, "output")["text"].(string)
			stream := ProjectActivityEventsToStreamEvents(session, started)

			publisher, err := liveprotocol.NewPublisher(liveprotocol.PublisherConfig{
				StreamID: "stream-1", BindingID: "binding-1", Epoch: 1,
			})
			if err != nil {
				t.Fatal(err)
			}
			var delivered string
			deltaCount := 0
			for _, streamEvent := range stream {
				if streamEvent.EventType != StreamEventMessageDelta {
					continue
				}
				event, ok := streamEvent.Data.(liveprotocol.Event)
				if !ok {
					t.Fatalf("stream event data has type %T", streamEvent.Data)
				}
				frames, err := publisher.Publish(liveprotocol.PublishInput{
					Event: &event, Immediate: true,
				})
				if err != nil {
					t.Fatal(err)
				}
				if len(frames) != 1 || len(frames[0].Deliveries) != 1 {
					t.Fatalf("published frames = %#v, want one delivery", frames)
				}
				delivery := frames[0].Deliveries[0]
				if delivery.Kind != liveprotocol.DeliveryKindEvent {
					t.Fatalf("delivery kind = %v, want event", delivery.Kind)
				}
				deliveredEvent, err := liveprotocol.DecodeEvent(delivery.Event)
				if err != nil {
					t.Fatal(err)
				}
				var delta liveprotocol.MessageDeltaData
				if err := json.Unmarshal(deliveredEvent.Data, &delta); err != nil {
					t.Fatal(err)
				}
				if delta.ToolOutput == nil {
					t.Fatalf("delivered delta = %#v, want tool output", delta)
				}
				switch delta.ToolOutput.Operation {
				case "set":
					if deltaCount != 0 {
						t.Fatalf("set operation arrived after %d deltas", deltaCount)
					}
					delivered = delta.ToolOutput.Text
				case "append_text":
					if delta.ToolOutput.OffsetBytes == nil ||
						*delta.ToolOutput.OffsetBytes != int64(len(delivered)) {
						t.Fatalf(
							"append offset = %#v, delivered bytes = %d",
							delta.ToolOutput.OffsetBytes,
							len(delivered),
						)
					}
					delivered += delta.ToolOutput.Text
				default:
					t.Fatalf("tool output operation = %#v", delta.ToolOutput)
				}
				deltaCount++
			}
			if deltaCount < 2 {
				t.Fatalf("delta count = %d, want split delivery", deltaCount)
			}
			if delivered != expected ||
				len(delivered) > canonical.ToolOutputTextMaxBytes ||
				!strings.HasSuffix(delivered, canonical.ToolOutputTruncationMarker) {
				t.Fatalf(
					"delivered output mismatch: got %d bytes, want %d",
					len(delivered),
					len(expected),
				)
			}
		})
	}
}

func TestExtensionProviderProjectsTurnLifecycleEvents(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.Provider = "acp:gemini"
	started := newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)
	failed := newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
		"error": "quota exceeded",
	})

	if started.Type != activityshared.EventTurnStarted {
		t.Fatalf("extension turn started event = %#v, want %q", started, activityshared.EventTurnStarted)
	}
	if failed.Type != activityshared.EventTurnFailed {
		t.Fatalf("extension turn failed event = %#v, want %q", failed, activityshared.EventTurnFailed)
	}
	if started.Provider != activityshared.Provider("acp:gemini") || failed.Provider != activityshared.Provider("acp:gemini") {
		t.Fatalf("extension event providers = %q, %q; want acp:gemini", started.Provider, failed.Provider)
	}
}

func TestEventSourceCarriesStableSessionIncarnation(t *testing.T) {
	source := eventSourceFromSession(Session{Provider: "codex", AgentSessionID: "session", CreatedAtUnixMS: 4242})
	if source.SessionCreatedAtUnixMS != 4242 {
		t.Fatalf("session incarnation = %d", source.SessionCreatedAtUnixMS)
	}
}

func TestSessionAuditProjectsSeparatelyFromTurnMessages(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	audit := newSessionAuditEventWithID(session, "goal-control:op-1", RoleUser, "/goal clear", map[string]any{"goalControl": true})
	report := reportActivityInput(session, []activityshared.Event{audit})
	if len(report.SessionAudits) != 1 || len(report.MessageUpdates) != 0 || len(report.StatePatches) != 0 {
		t.Fatalf("report = %#v, want one standalone audit", report)
	}
	if report.SessionAudits[0].AuditID != "goal-control:op-1" || report.SessionAudits[0].Payload["goalControl"] != true {
		t.Fatalf("audit = %#v", report.SessionAudits[0])
	}
	stream := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{audit})
	if len(stream) != 1 || stream[0].EventType != StreamEventSessionAudit {
		t.Fatalf("stream events = %#v", stream)
	}
}

func TestSessionFailureProjectsVisibleAuditWithoutTurn(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	event := newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
		"error": "provider failed before turn admission",
	})

	report := reportActivityInput(session, []activityshared.Event{event})
	if len(report.StatePatches) != 1 || len(report.SessionAudits) != 1 || len(report.MessageUpdates) != 0 {
		t.Fatalf("report = %#v, want state plus turnless visible audit", report)
	}
	audit := report.SessionAudits[0]
	if audit.AuditID == "" || audit.Role != RoleAssistant || audit.Payload["kind"] != visibleErrorKind ||
		audit.Payload["phase"] != "start" || audit.Payload["detail"] != "provider failed before turn admission" {
		t.Fatalf("visible failure audit = %#v", audit)
	}

	stream := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{event})
	if len(stream) != 2 || stream[0].EventType != StreamEventStatePatch || stream[1].EventType != StreamEventSessionAudit {
		t.Fatalf("stream = %#v, want state plus session audit", stream)
	}
	streamAudit, ok := stream[1].Data.(agentsessionstore.WorkspaceAgentSessionAuditUpdate)
	if !ok || streamAudit.AuditID != audit.AuditID {
		t.Fatalf("stream audit = %#v, want durable audit identity %q", stream[1].Data, audit.AuditID)
	}
}

func TestGoalReconcileRequiredProjectsOnlyToInternalControlReport(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	ctx, ok := activityEventContext(session, "goal-reconcile:req-1", "")
	if !ok {
		t.Fatal("activity event context unavailable")
	}
	event := activityshared.NewGoalReconcileRequired(ctx, map[string]any{
		"requestId": "req-1", "providerTurnId": "provider-turn-old", "fenceMode": "operation",
		"expectedGoalOperationId": "goal-op-2", "expectedGoalRevision": int64(2),
		"expectedGoalRepairEpoch": int64(1), "quiesceSucceeded": true,
	})
	report := reportActivityInput(session, []activityshared.Event{event})
	if len(report.GoalReconcileRequests) != 1 || len(report.SessionAudits) != 0 || len(report.MessageUpdates) != 0 || len(report.StatePatches) != 0 {
		t.Fatalf("internal reconcile report = %#v", report)
	}
	request := report.GoalReconcileRequests[0]
	if request.RequestID != "req-1" || request.ExpectedOperationID != "goal-op-2" || request.ExpectedRevision != 2 || request.ExpectedRepairEpoch != 1 || !request.QuiesceSucceeded {
		t.Fatalf("internal reconcile request = %#v", request)
	}
	if stream := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{event}); len(stream) != 0 {
		t.Fatalf("internal reconcile evidence leaked to realtime stream: %#v", stream)
	}
}

func TestReportableActivityEventsReportsOnlyCompletedAssistantSnapshots(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"
	streaming := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateStreaming, RoleAssistant, "hel", map[string]any{
		"streamState": messageStreamStateStreaming,
	})
	completed := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "hello", map[string]any{
		"streamState": messageStreamStateCompleted,
	})
	thinkingStreaming := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateStreaming, RoleAssistantThinking, "thinking", map[string]any{
		"streamState": messageStreamStateStreaming,
	})
	thinkingCompleted := newTurnActivityEvent(session, EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistantThinking, "thinking done", map[string]any{
		"streamState": messageStreamStateCompleted,
	})

	events := ReportableActivityEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventMessage, "turn-1", "", RoleUser, "say hello", nil),
		streaming,
		completed,
		thinkingStreaming,
		thinkingCompleted,
	})

	if len(events) != 3 {
		t.Fatalf("activity events = %#v, want user, completed assistant, and completed thinking snapshots", events)
	}
	if events[0].Type != activityshared.EventMessageAppended || events[1].Type != activityshared.EventMessageAppended || events[2].Type != activityshared.EventMessageAppended {
		t.Fatalf("activity event types = %#v, want message events", events)
	}
	if events[2].Payload.Role != activityshared.MessageRoleAssistantThinking {
		t.Fatalf("thinking role = %q, want assistant_thinking", events[2].Payload.Role)
	}
	if events[1].Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("activity metadata streamState = %#v, want completed", events[1].Payload.Metadata)
	}
}

func TestReportableActivityEventsIncludesRootProviderTurnLifecycle(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	ctx, ok := activityEventContext(session, "root-provider-turn", "root-turn-1")
	if !ok {
		t.Fatal("activityEventContext() returned !ok")
	}
	events := ReportableActivityEvents([]activityshared.Event{
		activityshared.NewRootProviderTurnStarted(ctx, "root-turn-1", "provider-turn-1"),
		activityshared.NewRootProviderTurnCompleted(ctx, "root-turn-1", "provider-turn-1", activityshared.TurnOutcomeCompleted),
	})

	if len(events) != 2 {
		t.Fatalf("activity events = %#v, want root provider start and completion", events)
	}
	report := reportActivityInput(session, events)
	if len(report.StatePatches) != 2 {
		t.Fatalf("state patches = %#v, want root provider start and completion", report.StatePatches)
	}
	started := report.StatePatches[0].RootProviderTurn
	if started == nil || started.RootTurnID != "root-turn-1" || started.ProviderTurnID != "provider-turn-1" || started.Phase != agentsessionstore.RootProviderTurnPhaseRunning {
		t.Fatalf("started root provider turn = %#v, want running transition", started)
	}
	completed := report.StatePatches[1].RootProviderTurn
	if completed == nil || completed.RootTurnID != "root-turn-1" || completed.ProviderTurnID != "provider-turn-1" || completed.Phase != agentsessionstore.RootProviderTurnPhaseCompleted || completed.Outcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("completed root provider turn = %#v, want completed transition", completed)
	}
	if completed.ErrorCode != "" {
		t.Fatalf("completed root provider turn error code = %q, want empty", completed.ErrorCode)
	}
}

func TestRootProviderTurnFailurePersistsVisibleErrorCode(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.Provider = ProviderTuttiAgent
	ctx, ok := activityEventContext(session, "root-provider-turn-failed", "root-turn-1")
	if !ok {
		t.Fatal("activityEventContext() returned !ok")
	}
	const errorMessage = "You've hit your usage limit. Insufficient credits. View Tutti plans at https://tutti.sh/profile/plan, or try again later."
	failed := activityshared.NewRootProviderTurnCompleted(ctx, "root-turn-1", "provider-turn-1", activityshared.TurnOutcomeFailed)
	failed.Payload.Metadata = map[string]any{"error": errorMessage}

	report := reportActivityInput(session, []activityshared.Event{failed})
	if len(report.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want one root provider failure", report.StatePatches)
	}
	completed := report.StatePatches[0].RootProviderTurn
	if completed == nil {
		t.Fatal("root provider turn transition is nil")
		return
	}
	if completed.ErrorMessage != errorMessage {
		t.Fatalf("root provider turn error message = %q, want %q", completed.ErrorMessage, errorMessage)
	}
	if completed.ErrorCode != "insufficient_credits" {
		t.Fatalf("root provider turn error code = %q, want insufficient_credits", completed.ErrorCode)
	}
}

func TestRootProviderTurnFailurePersistsUnknownCodeWithoutDiagnostics(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	ctx, ok := activityEventContext(session, "root-provider-turn-failed", "root-turn-1")
	if !ok {
		t.Fatal("activityEventContext() returned !ok")
	}
	failed := activityshared.NewRootProviderTurnCompleted(ctx, "root-turn-1", "provider-turn-1", activityshared.TurnOutcomeFailed)

	report := reportActivityInput(session, []activityshared.Event{failed})
	if len(report.StatePatches) != 1 {
		t.Fatalf("state patches = %#v, want one root provider failure", report.StatePatches)
	}
	completed := report.StatePatches[0].RootProviderTurn
	if completed == nil {
		t.Fatal("root provider turn transition is nil")
	}
	if completed.ErrorCode != "unknown" || completed.ErrorMessage != "" {
		t.Fatalf("root provider turn error = %q/%q, want unknown/empty", completed.ErrorCode, completed.ErrorMessage)
	}
}

func TestSessionStatusFromActivityPreservesWaiting(t *testing.T) {
	t.Parallel()

	got := sessionStatusFromActivity(string(activityshared.SessionStatusWaiting))

	if got != SessionStatusWaiting {
		t.Fatalf("sessionStatusFromActivity(waiting) = %q, want %q", got, SessionStatusWaiting)
	}
}

func TestActivitySessionStatusFromControllerStatusPreservesWaiting(t *testing.T) {
	t.Parallel()

	got := activitySessionStatusFromControllerStatus(SessionStatusWaiting)

	if got != activityshared.SessionStatusWaiting {
		t.Fatalf("activitySessionStatusFromControllerStatus(waiting) = %q, want %q", got, activityshared.SessionStatusWaiting)
	}
}

func TestReportableActivityEventsReportsFailedAssistantFinalSnapshots(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events := append([]activityshared.Event{},
		normalizer.AppendThinkingChunk(session, "turn-1", "thinking")...,
	)
	events = append(events, normalizer.AppendAssistantChunk(session, "turn-1", "answer")...)
	events = append(events, normalizer.Finish(session, "turn-1", messageStreamStateFailed)...)

	report := reportActivityInput(session, events)
	assistant := messageUpdatesWithKind(report, "text")
	if len(assistant) != 2 {
		t.Fatalf("assistant message updates = %#v, want streaming and failed final", assistant)
	}
	if assistant[1].Status != messageStreamStateFailed {
		t.Fatalf("assistant status = %q, want failed", assistant[1].Status)
	}
	thinking := messageUpdatesWithKind(report, "reasoning")
	if len(thinking) != 2 {
		t.Fatalf("thinking message updates = %#v, want streaming and failed final", thinking)
	}
	if thinking[1].Status != messageStreamStateFailed {
		t.Fatalf("thinking status = %q, want failed", thinking[1].Status)
	}
}

func TestReportableActivityEventsReportsInterruptedOpenToolCalls(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"toolCallId": "tool-1",
		"title":      "Run command",
		"status":     "in_progress",
		"kind":       "execute",
		"rawInput": map[string]any{
			"command": []any{"/bin/zsh", "-lc", "rg TODO"},
		},
	})
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}

	events = append(events, normalizer.FinishInterrupted(session, "turn-1", "user_interrupt")...)
	report := reportActivityInput(session, events)
	failedCalls := messageUpdatesWithKind(report, "tool_call")
	if len(failedCalls) != 2 {
		t.Fatalf("failed call message updates = %#v, want start and interrupted final", failedCalls)
	}
	failedCall := failedCalls[1]
	if failedCall.Status != "failed" {
		t.Fatalf("failed call status = %q, want failed", failedCall.Status)
	}
	if got := payloadString(failedCall.Payload, "status"); got != SessionStatusCanceled {
		t.Fatalf("failed call payload status = %q, want canceled", got)
	}
	if got := payloadString(payloadMap(failedCall.Payload, "error"), "reason"); got != "user_interrupt" {
		t.Fatalf("failed call error payload = %#v, want interrupt reason", failedCall.Payload)
	}
}

// TestReportableActivityEventsReportsFailedOpenToolCalls covers a tool call
// that is still open (no item/completed ever arrived for it) when its own
// turn otherwise reaches a normal terminal state - for example codex
// silently declining a spawnAgent delegation for a schema conflict, with no
// further notification tied to that call id for the rest of the turn
// (confirmed via exported session transcripts). Reporting it as a
// successful completion would paint a rejected/never-run call as having
// succeeded, which is exactly what previously left rejected sub-agent
// delegations rendered as stuck "running"/"queued" forever instead of
// failed. It must close out as failed, matching how an interrupted/failed
// turn already handles dangling calls.
func TestReportableActivityEventsReportsFailedOpenToolCalls(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	events, ok := normalizer.ToolCallEvents(session, "turn-1", map[string]any{
		"toolCallId": "tool-1",
		"title":      "Run command",
		"status":     "in_progress",
		"kind":       "execute",
		"rawInput": map[string]any{
			"command": []any{"/bin/zsh", "-lc", "cat .env"},
		},
	})
	if !ok {
		t.Fatal("ToolCallEvents() returned !ok")
	}

	events = append(events, normalizer.FinishCompleted(session, "turn-1")...)
	report := reportActivityInput(session, events)
	completedCalls := messageUpdatesWithKind(report, "tool_call")
	if len(completedCalls) != 2 {
		t.Fatalf("completed call message updates = %#v, want start and failed final", completedCalls)
	}
	if completedCalls[1].MessageID != completedCalls[0].MessageID ||
		completedCalls[1].CallID != completedCalls[0].CallID {
		t.Fatalf("completed call identity = start:%#v completed:%#v, want same message and call IDs", completedCalls[0], completedCalls[1])
	}
	completedCall := completedCalls[1]
	if completedCall.Status != messageStreamStateFailed {
		t.Fatalf("dangling call status = %q, want failed", completedCall.Status)
	}
	if got := payloadString(completedCall.Payload, "status"); got != messageStreamStateFailed {
		t.Fatalf("dangling call payload status = %q, want failed", got)
	}
	if got := payloadMap(completedCall.Payload, "error"); got == nil {
		t.Fatalf("dangling call payload error = %#v, want a non-nil error detail", got)
	}
}

func TestReportableActivityEventsIncludesCallStarted(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ReportableActivityEvents([]activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read files", map[string]any{
			"callId":   "tool-1",
			"callType": "tool",
			"name":     "Read files",
		}),
	})

	if len(events) != 1 {
		t.Fatalf("activity events = %#v, want call.started to be reportable", events)
	}
	if events[0].Type != activityshared.EventCallStarted {
		t.Fatalf("activity event type = %q, want call.started", events[0].Type)
	}
}

func TestNewTurnActivityEventDefaultsUserMessageMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	event := newTurnActivityEventWithID(session, "message-user-1", EventMessage, "turn-1", "", RoleUser, "hello", nil)

	if event.Payload.Metadata["messageId"] != "message-user-1" {
		t.Fatalf("message metadata = %#v, want message id", event.Payload.Metadata)
	}
	if event.Payload.Metadata["contentMode"] != messageContentModeSnapshot {
		t.Fatalf("message metadata = %#v, want snapshot content mode", event.Payload.Metadata)
	}
	if event.Payload.Metadata["streamState"] != messageStreamStateCompleted {
		t.Fatalf("message metadata = %#v, want completed streamState", event.Payload.Metadata)
	}
}

func TestProjectActivityEventsToStreamEventsCarriesApprovalEnvelope(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-approval", SessionStatusWaiting, "", "Read files", map[string]any{
			"callId":   "tool-approval-1",
			"callType": "approval",
			"name":     "Read files",
			"status":   "waiting_approval",
			"input": map[string]any{
				"requestId": "permission-1",
				"options": []map[string]any{
					{"id": "allow_once", "label": "Allow once"},
				},
			},
		}),
	})

	if len(events) != 1 {
		t.Fatalf("stream events = %#v, want one approval call", events)
	}
	item, ok := events[0].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[0].Data)
	}
	if got := payloadMap(item.Payload, "input"); got == nil || got["requestId"] != "permission-1" {
		t.Fatalf("approval input payload = %#v, want requestId", item.Payload)
	}
	if item.Payload["callType"] != "approval" {
		t.Fatalf("callType = %#v, want approval", item.Payload["callType"])
	}
}

func TestProjectActivityEventsToStreamEventsCarriesInteractiveMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventCallStarted, "turn-ask-user", SessionStatusWaiting, "", "AskUserQuestion", map[string]any{
			"callId":   "tool-ask-1",
			"callType": "interactive",
			"name":     "AskUserQuestion",
			"status":   "waiting_input",
			"input": map[string]any{
				"questions": []map[string]any{
					{"question": "Which approach should we use?"},
				},
			},
			"metadata": map[string]any{
				"interactiveKind": "ask-user",
			},
		}),
	})

	if len(events) != 1 {
		t.Fatalf("stream events = %#v, want one interactive call", events)
	}
	item, ok := events[0].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[0].Data)
	}
	if item.Payload["callType"] != "interactive" {
		t.Fatalf("callType = %#v, want interactive", item.Payload["callType"])
	}
	if got := payloadMap(item.Payload, "input"); got == nil {
		t.Fatalf("interactive input = %#v, want preserved questions", item.Payload)
	}
	if got := payloadString(item.Payload, "status"); got != "waiting_input" {
		t.Fatalf("status = %q, want waiting_input", got)
	}
}

func TestProjectActivityEventsToStreamEventsAddsVisibleTurnFailureMessage(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.Provider = hermesExtensionTestProvider
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "turn-failed-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "\x1b[33mAPI Error: 429 rate limit\x1b[39m",
		}),
	})
	report := reportActivityInput(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "turn-failed-report-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "API Error: 429 rate limit",
		}),
	})
	if len(report.MessageUpdates) != 1 || len(report.SessionAudits) != 0 {
		t.Fatalf("turn failure report = %#v, want turn message only", report)
	}

	if len(events) != 2 {
		t.Fatalf("stream events = %#v, want state patch and visible failure message", events)
	}
	item, ok := events[1].Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
	if !ok {
		t.Fatalf("stream event data = %#v, want message update", events[1].Data)
	}
	if item.Kind != "text" || item.Status != messageStreamStateFailed {
		t.Fatalf("visible failure item = %#v", item)
	}
	if item.Semantics == nil || !item.Semantics.UserVisibleAssistantResponse {
		t.Fatalf("visible failure semantics = %#v, want explicit user-visible assistant response", item.Semantics)
	}
	if item.Payload["kind"] != visibleErrorKind ||
		item.Payload["phase"] != "turn" ||
		item.Payload["code"] != "quota_or_rate_limit" ||
		item.Payload["detail"] != "API Error: 429 rate limit" {
		t.Fatalf("visible failure payload = %#v", item.Payload)
	}
}

func TestProjectActivityEventsToStreamEventsDoesNotDuplicateVisibleFailureMessage(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ProjectActivityEventsToStreamEvents(session, []activityshared.Event{
		newTurnActivityEventWithID(session, "assistant-failed-1", EventMessage, "turn-1", messageStreamStateFailed, RoleAssistant, "provider failure", map[string]any{
			"streamState": messageStreamStateFailed,
		}),
		newTurnActivityEventWithID(session, "turn-failed-1", EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "provider failure",
		}),
	})

	var visibleFailures int
	for _, event := range events {
		item, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if ok && item.Payload["kind"] == visibleErrorKind {
			visibleFailures++
		}
	}
	if visibleFailures != 0 {
		t.Fatalf("visible failure count = %d, want provider failed assistant message to suppress synthetic item", visibleFailures)
	}
}

func TestNewActivityEventsCarryProjectionMetadata(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	event := newTurnActivityEventWithID(session, "stable-message-id", EventMessage, "turn-1", messageStreamStateCompleted, RoleAssistant, "done", map[string]any{
		"messageId":    "message-1",
		"contentMode":  messageContentModeSnapshot,
		"streamState":  messageStreamStateCompleted,
		"adapterExtra": "kept-for-local-debug",
	})

	if event.EventID != "stable-message-id" {
		t.Fatalf("activity event id = %q, want stable-message-id", event.EventID)
	}
	if event.Type != activityshared.EventMessageAppended {
		t.Fatalf("activity type = %q, want %q", event.Type, activityshared.EventMessageAppended)
	}
	if event.Payload.Metadata["messageId"] != "message-1" {
		t.Fatalf("activity metadata = %#v, want message id copied", event.Payload.Metadata)
	}
}

func TestRuntimeSessionStartUsesSessionStartedEvent(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.AgentSessionID = "4e70b18d-b8b5-47a1-b293-3b98e4a23310"

	events := ReportableActivityEvents([]activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	})

	if len(events) != 1 {
		t.Fatalf("activity events = %#v, want exactly the session.started event", events)
	}
	if events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("activity event type = %q, want %q", events[0].Type, activityshared.EventSessionStarted)
	}
}

func messageUpdatesWithKind(report agentsessionstore.ReportActivityInput, kind string) []agentsessionstore.WorkspaceAgentMessageUpdate {
	var out []agentsessionstore.WorkspaceAgentMessageUpdate
	for _, update := range report.MessageUpdates {
		if update.Kind == kind {
			out = append(out, update)
		}
	}
	return out
}
