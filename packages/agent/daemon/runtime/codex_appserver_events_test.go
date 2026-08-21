package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

type appServerCaptureConn struct {
	mu     sync.Mutex
	sent   [][]byte
	closed chan struct{}
}

func newAppServerCaptureConn() *appServerCaptureConn {
	return &appServerCaptureConn{closed: make(chan struct{})}
}

func (c *appServerCaptureConn) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	return nil
}

func (c *appServerCaptureConn) Recv() (ProcessFrame, error) {
	<-c.closed
	return ProcessFrame{}, io.EOF
}

func (c *appServerCaptureConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

func (c *appServerCaptureConn) responses(t *testing.T) []acpMessage {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]acpMessage, 0, len(c.sent))
	for _, data := range c.sent {
		var message acpMessage
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatalf("unmarshal sent frame %q: %v", data, err)
		}
		out = append(out, message)
	}
	return out
}

func mustJSONRawMessage(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return raw
}

func TestCodexAppServerCompactionAdvisoryWarningIsScopedToCompaction(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.ProviderSessionID = "thread-1"
	reducer := newCodexAppServerReducer(&CodexAppServerAdapter{})
	warning := acpMessage{
		Method: appServerNotifyWarning,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "thread-1",
			"turnId":   "provider-turn-1",
			"message":  appServerCompactionAdvisoryMessage,
		}),
	}

	withoutCompaction := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		warning,
		newACPTurnNormalizer(),
		nil,
	)
	if len(withoutCompaction.Events) != 1 {
		t.Fatalf("unscoped advisory events = %#v, want one warning notice", withoutCompaction.Events)
	}

	compaction := newACPTurnNormalizer()
	compaction.StartCompactionNotice("compaction:turn-1")
	duringCompaction := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		warning,
		compaction,
		nil,
	)
	if len(duringCompaction.Events) != 0 {
		t.Fatalf("compaction advisory events = %#v, want no duplicate transcript warning", duringCompaction.Events)
	}
	warning.Params = mustJSONRawMessage(t, map[string]any{
		"threadId": "thread-1",
		"turnId":   "provider-turn-1",
		"message":  appServerCompactionAdvisoryMessage + "\n",
	})
	nearMatch := reducer.ReduceNotification(nil, session, "turn-1", warning, compaction, nil)
	if len(nearMatch.Events) != 1 {
		t.Fatalf("near-match advisory events = %#v, want warning preserved", nearMatch.Events)
	}
}

func TestCodexAppServerCompactionKeepsUnrelatedWarnings(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	session.ProviderSessionID = "thread-1"
	normalizer := newACPTurnNormalizer()
	normalizer.StartCompactionNotice("compaction:turn-1")

	warning := "  Model fell back to a smaller context window.\n"
	reduction := newCodexAppServerReducer(&CodexAppServerAdapter{}).ReduceNotification(
		nil,
		session,
		"turn-1",
		acpMessage{
			Method: appServerNotifyWarning,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "thread-1",
				"turnId":   "provider-turn-1",
				"message":  warning,
			}),
		},
		normalizer,
		nil,
	)
	if len(reduction.Events) != 1 {
		t.Fatalf("unrelated warning events = %#v, want one warning notice", reduction.Events)
	}
	if detail := asString(reduction.Events[0].Payload.Metadata["detail"]); detail != strings.TrimSpace(warning) {
		t.Fatalf("unrelated warning detail = %q, want normalized event detail %q", detail, strings.TrimSpace(warning))
	}
	if !appServerNotificationUsesNormalizer(appServerNotifyWarning) {
		t.Fatal("warning notifications must serialize with compaction lifecycle updates")
	}
}

func TestCodexAppServerFinalFileCitationsBecomePortableFileMentions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		text string
		want string
	}{
		{
			name: "Windows output",
			text: `Created :codex-file-citation{path="C:\Users\local user\output.docx" purpose="output"}`,
			want: `Created [@output.docx](<C:/Users/local%20user/output.docx>)`,
		},
		{
			name: "Windows UNC remains provider text",
			text: `Created :codex-file-citation{path="\\server\share\output.docx" purpose="output"}`,
			want: `Created :codex-file-citation{path="\\server\share\output.docx" purpose="output"}`,
		},
		{
			name: "POSIX output with reordered attributes",
			text: `Created :codex-file-citation{purpose="output" path="/Users/local user/output.docx"}`,
			want: `Created [@output.docx](</Users/local%20user/output.docx>)`,
		},
		{
			name: "relative path remains provider text",
			text: `Created :codex-file-citation{path="output.docx" purpose="output"}`,
			want: `Created :codex-file-citation{path="output.docx" purpose="output"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			session := reportTestSession()
			normalizer := newACPTurnNormalizer()
			events := newCodexAppServerReducer(&CodexAppServerAdapter{}).ReduceNotification(
				nil,
				session,
				"turn-1",
				acpMessage{
					Method: appServerNotifyItemCompleted,
					Params: mustJSONRawMessage(t, map[string]any{
						"item": map[string]any{"type": "agentMessage", "text": tt.text},
					}),
				},
				normalizer,
				nil,
			).Events
			if len(events) != 1 || events[0].Payload.Content != tt.want {
				t.Fatalf("item/completed events = %#v, want content %q", events, tt.want)
			}

			turnText := appServerTurnFinalAssistantText(map[string]any{
				"items": []any{map[string]any{"type": "agentMessage", "text": tt.text}},
			})
			if turnText != tt.want {
				t.Fatalf("turn/completed text = %q, want %q", turnText, tt.want)
			}
		})
	}
}

func TestCodexAppServerCommandOutputDeltaUsesToolOutputFastLane(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	session.ProviderSessionID = "thread-1"
	normalizer := newACPTurnNormalizer()
	reducer := newCodexAppServerReducer(&CodexAppServerAdapter{})

	started := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		acpMessage{
			Method: appServerNotifyItemStarted,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "thread-1",
				"turnId":   "provider-turn-1",
				"item": map[string]any{
					"type": "commandExecution", "id": "command-1",
					"command": "printf hello", "status": "inProgress",
				},
			}),
		},
		normalizer,
		nil,
	)
	if len(started.Events) != 1 || started.Events[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v", started.Events)
	}
	startReport := reportActivityInput(session, started.Events)
	if len(startReport.MessageUpdates) != 1 {
		t.Fatalf("started report = %#v, want one canonical tool anchor", startReport)
	}

	output := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		acpMessage{
			Method: appServerNotifyCommandOutputDelta,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "thread-1",
				"turnId":   "provider-turn-1",
				"itemId":   "command-1",
				"delta":    "hello",
			}),
		},
		normalizer,
		nil,
	)
	if len(output.Events) != 1 {
		t.Fatalf("output events = %#v", output.Events)
	}
	stream := ProjectActivityEventsToStreamEvents(session, output.Events)
	if len(stream) != 1 || stream[0].EventType != StreamEventMessageDelta {
		t.Fatalf("output stream = %#v", stream)
	}
	liveEvent := stream[0].Data.(liveprotocol.Event)
	var data liveprotocol.MessageDeltaData
	if err := json.Unmarshal(liveEvent.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.ToolOutput == nil ||
		data.ToolOutput.Operation != "set" ||
		data.ToolOutput.Text != "hello" {
		t.Fatalf("tool output delta = %#v", data.ToolOutput)
	}
	if data.MessageID != startReport.MessageUpdates[0].MessageID {
		t.Fatalf(
			"live output message id = %q, want canonical start anchor %q",
			data.MessageID,
			startReport.MessageUpdates[0].MessageID,
		)
	}

	completed := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		acpMessage{
			Method: appServerNotifyItemCompleted,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "thread-1",
				"turnId":   "provider-turn-1",
				"item": map[string]any{
					"type": "commandExecution", "id": "command-1",
					"command": "printf hello", "status": "completed",
					"aggregatedOutput": "hello", "exitCode": 0,
				},
			}),
		},
		normalizer,
		nil,
	)
	if len(completed.Events) != 1 || completed.Events[0].Type != activityshared.EventCallCompleted {
		t.Fatalf("completed events = %#v", completed.Events)
	}
	completedReport := reportActivityInput(session, completed.Events)
	if len(completedReport.MessageUpdates) != 1 {
		t.Fatalf("completed report = %#v, want one canonical terminal tool update", completedReport)
	}
	if completedReport.MessageUpdates[0].MessageID != startReport.MessageUpdates[0].MessageID {
		t.Fatalf(
			"completed message id = %q, want canonical start anchor %q",
			completedReport.MessageUpdates[0].MessageID,
			startReport.MessageUpdates[0].MessageID,
		)
	}
}

func TestCodexAppServerCommandOutputDeltaBeforeItemStartPreservesPrefix(t *testing.T) {
	t.Parallel()
	session := reportTestSession()
	session.ProviderSessionID = "thread-1"
	normalizer := newACPTurnNormalizer()
	reducer := newCodexAppServerReducer(&CodexAppServerAdapter{})

	for _, chunk := range []string{"first\n", "second\n"} {
		early := reducer.ReduceNotification(
			nil,
			session,
			"turn-1",
			acpMessage{
				Method: appServerNotifyCommandOutputDelta,
				Params: mustJSONRawMessage(t, map[string]any{
					"threadId": "thread-1",
					"turnId":   "provider-turn-1",
					"itemId":   "command-1",
					"delta":    chunk,
				}),
			},
			normalizer,
			nil,
		)
		if len(early.Events) != 0 {
			t.Fatalf("early events for %q = %#v, want no output before its anchor", chunk, early.Events)
		}
	}

	started := reducer.ReduceNotification(
		nil,
		session,
		"turn-1",
		acpMessage{
			Method: appServerNotifyItemStarted,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "thread-1",
				"turnId":   "provider-turn-1",
				"item": map[string]any{
					"type": "commandExecution", "id": "command-1",
					"command": "printf first", "status": "inProgress",
				},
			}),
		},
		normalizer,
		nil,
	)
	if len(started.Events) != 2 ||
		started.Events[0].Type != activityshared.EventCallStarted ||
		started.Events[1].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want anchor followed by buffered prefix", started.Events)
	}
	report := reportActivityInput(session, started.Events)
	if len(report.MessageUpdates) != 2 {
		t.Fatalf("report = %#v, want anchor and cumulative prefix", report)
	}
	startMessageID := report.MessageUpdates[0].MessageID
	if report.MessageUpdates[1].MessageID != startMessageID {
		t.Fatalf(
			"message ids = %q / %q, want one canonical tool row",
			startMessageID,
			report.MessageUpdates[1].MessageID,
		)
	}
	output, _ := report.MessageUpdates[1].Payload["output"].(map[string]any)
	if output["text"] != "first\nsecond\n" {
		t.Fatalf("persisted buffered prefix = %#v", output)
	}
}

// appServerUserInputAnswers is the codex-specific translation of the GUI's
// interactive answer payload into codex's requestUserInput response. The GUI
// contract (packages/agent/gui shared/agentConversation/interactiveAnswerPayload.ts)
// keys answers under answersByQuestionId; `answers` is only a flat display list.
// These cases pin that contract so the adapter can't silently drift back to
// reading the wrong field (the bug that made codex ignore the user's choice).
func TestAppServerUserInputAnswers(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		params    map[string]any
		selection pendingInteractiveResponse
		want      map[string]any
	}{
		{
			name: "canonical single-select from answersByQuestionId",
			selection: pendingInteractiveResponse{
				payload: map[string]any{
					"answers":             []any{"Health check"},
					"answersByQuestionId": map[string]any{"plan-kind": "Health check"},
				},
			},
			want: map[string]any{
				"plan-kind": map[string]any{"answers": []string{"Health check"}},
			},
		},
		{
			name: "multi-select values preserved",
			selection: pendingInteractiveResponse{
				payload: map[string]any{
					"answersByQuestionId": map[string]any{"areas": []any{"A", "B"}},
				},
			},
			want: map[string]any{
				"areas": map[string]any{"answers": []string{"A", "B"}},
			},
		},
		{
			name: "legacy answers-as-map still accepted",
			selection: pendingInteractiveResponse{
				payload: map[string]any{
					"answers": map[string]any{"q1": "postgres"},
				},
			},
			want: map[string]any{
				"q1": map[string]any{"answers": []string{"postgres"}},
			},
		},
		{
			name:   "falls back to optionId keyed by the request's questions",
			params: map[string]any{"questions": []any{map[string]any{"id": "q1"}}},
			selection: pendingInteractiveResponse{
				optionID: "Renderer A",
				payload:  map[string]any{},
			},
			want: map[string]any{
				"q1": map[string]any{"answers": []string{"Renderer A"}},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := appServerUserInputAnswers(tc.params, tc.selection)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("appServerUserInputAnswers = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestAppServerUserInputIncludesSkillAndMentionItems(t *testing.T) {
	t.Parallel()

	got := appServerUserInput([]PromptContentBlock{
		{Type: "text", Text: "use these"},
		{Type: "skill", Name: "review", Path: "/tmp/review/SKILL.md"},
		{Type: "mention", Name: "GitHub", Path: "app://github"},
	})
	want := []map[string]any{
		{"type": "text", "text": "use these"},
		{"type": "skill", "name": "review", "path": "/tmp/review/SKILL.md"},
		{"type": "mention", "name": "GitHub", "path": "app://github"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("appServerUserInput = %#v, want %#v", got, want)
	}
}

func TestAppServerUserInputMapsImageDataAndURLSources(t *testing.T) {
	t.Parallel()
	signedURL := "https://bucket.example/image.webp?token=secret"
	got := appServerUserInput([]PromptContentBlock{
		{Type: "image", MimeType: "image/png", Data: "aGk="},
		{Type: "image", MimeType: "image/webp", URL: signedURL},
	})
	want := []map[string]any{
		{"type": "image", "url": "data:image/png;base64,aGk="},
		{"type": "image", "url": signedURL},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("appServerUserInput = %#v, want %#v", got, want)
	}
}

func TestCodexAppServerAdapterRoutesLinkedChildThreadEvents(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
		CWD:               "/workspace",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})
	reducer := newCodexAppServerReducer(adapter)
	normalizer := newACPTurnNormalizer()

	parentEvents := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "parent-turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-child-1",
				"tool":              "spawnAgent",
				"status":            "inProgress",
				"prompt":            "inspect",
				"receiverThreadIds": []any{"child-thread-1"},
			},
		}),
	}, normalizer, nil).Events
	if len(parentEvents) != 2 || parentEvents[0].Type != activityshared.EventSessionStarted || parentEvents[0].SessionKind != "child" {
		t.Fatalf("parent collab events = %#v, want atomic child creation followed by parent tool event", parentEvents)
	}
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}

	childLifecycleEvents := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyTurnCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "child-thread-1",
			"turn":     map[string]any{"id": "child-turn-1", "status": "completed"},
		}),
	}, normalizer, nil).Events
	if len(childLifecycleEvents) != 1 {
		t.Fatalf("child lifecycle events = %#v, want one child turn terminal event", childLifecycleEvents)
	}
	lifecycle := childLifecycleEvents[0]
	if lifecycle.Type != activityshared.EventTurnCompleted ||
		lifecycle.AgentSessionID != child.agentSessionID ||
		lifecycle.ProviderSessionID != "child-thread-1" ||
		lifecycle.ParentToolCallID != "spawn-child-1" ||
		lifecycle.Payload.TurnID != child.turnID {
		t.Fatalf("child turn terminal = %#v", lifecycle)
	}

	childEvents := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyAgentMessageDelta,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "child-thread-1",
			"turnId":   "child-turn-1",
			"itemId":   "child-msg-1",
			"delta":    "child output",
		}),
	}, normalizer, nil).Events
	if len(childEvents) != 1 {
		t.Fatalf("child events = %#v, want one event", childEvents)
	}
	event := childEvents[0]
	if event.AgentSessionID != child.agentSessionID || event.ProviderSessionID != "child-thread-1" {
		t.Fatalf("event session = %q/%q, want child session", event.AgentSessionID, event.ProviderSessionID)
	}
	if event.Payload.TurnID != child.turnID || event.ParentToolCallID != "spawn-child-1" {
		t.Fatalf("child event relation = %#v", event)
	}
	if event.Payload.Role != activityshared.MessageRoleAssistant || event.Payload.Content != "child output" {
		t.Fatalf("child payload = %#v", event.Payload)
	}

	parentAfterChild := normalizer.AppendAssistantChunk(session, "parent-turn-1", "parent output")
	if len(parentAfterChild) != 1 || parentAfterChild[0].Payload.Content != "parent output" {
		t.Fatalf("parent normalizer was corrupted by child lane: %#v", parentAfterChild)
	}
}

func TestCodexAppServerAdapterRegistersSubAgentActivityChild(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
		CWD:               "/workspace",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})
	reducer := newCodexAppServerReducer(adapter)
	normalizer := newACPTurnNormalizer()
	notification := acpMessage{
		Method: appServerNotifyItemCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "parent-turn-1",
			"item": map[string]any{
				"type":          "subAgentActivity",
				"id":            "spawn-child-1",
				"agentThreadId": "child-thread-1",
				"agentPath":     "/root/reviewer",
				"kind":          "started",
			},
		}),
	}

	events := reducer.ReduceNotification(
		nil,
		session,
		"parent-turn-1",
		notification,
		normalizer,
		nil,
	).Events
	if len(events) != 2 {
		t.Fatalf("subAgentActivity events = %#v, want child creation and completed parent tool call", events)
	}
	childStarted := events[0]
	if childStarted.Type != activityshared.EventSessionStarted ||
		childStarted.SessionKind != "child" ||
		childStarted.ProviderSessionID != "child-thread-1" ||
		childStarted.ParentToolCallID != "spawn-child-1" {
		t.Fatalf("child start = %#v", childStarted)
	}
	parentCall := events[1]
	parentCallInput := payloadMap(parentCall.Payload.Metadata, "input")
	if parentCall.Type != activityshared.EventCallCompleted ||
		parentCall.AgentSessionID != session.AgentSessionID ||
		parentCall.Payload.CallID != "spawn-child-1" ||
		parentCall.Payload.Name != "spawnAgent" ||
		parentCallInput["agentName"] != "spawnAgent" {
		t.Fatalf("parent spawn call = %#v", parentCall)
	}
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok || child.parentItemID != "spawn-child-1" || child.parentAgentSessionID != session.AgentSessionID {
		t.Fatalf("registered child = %#v (ok=%v)", child, ok)
	}

	duplicate := reducer.ReduceNotification(
		nil,
		session,
		"parent-turn-1",
		notification,
		normalizer,
		nil,
	).Events
	if len(duplicate) != 0 {
		t.Fatalf("duplicate subAgentActivity events = %#v, want none", duplicate)
	}
}

func TestCodexAppServerAdapterRoutesChildFileChangeApprovalWithChildInput(t *testing.T) {
	t.Parallel()

	conn := newAppServerCaptureConn()
	client := newCodexAppServerClient(conn)
	defer func() { _ = client.Close() }()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "root-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "root-thread-1",
		CWD:               "/workspace",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:        session.ProviderSessionID,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	})
	_, _ = adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}
	childSession := appServerChildSession(session, "child-thread-1", child)
	update, ok := appServerItemToolCallUpdate(map[string]any{
		"id":     "child-file-change-1",
		"type":   "fileChange",
		"status": "inProgress",
		"changes": []any{
			map[string]any{"path": "/workspace/permission-probe.txt", "kind": map[string]any{"type": "add"}},
		},
	}, false)
	if !ok {
		t.Fatal("child file change did not produce a tool-call update")
	}
	if events, _ := child.normalizer.ToolCallEvents(childSession, child.turnID, update); len(events) == 0 {
		t.Fatal("child file change did not populate its turn normalizer")
	}

	var emitted []activityshared.Event
	var emittedMu sync.Mutex
	emit := func(events []activityshared.Event) {
		emittedMu.Lock()
		emitted = append(emitted, events...)
		emittedMu.Unlock()
	}
	message := acpMessage{
		ID:     json.RawMessage(`"child-approval-1"`),
		Method: appServerMethodFileChangeApproval,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "child-thread-1",
			"turnId":   "provider-child-turn-1",
			"itemId":   "child-file-change-1",
		}),
	}
	if _, err := adapter.appServerServerRequest(context.Background(), client, session, "root-turn-1", message, newACPTurnNormalizer(), emit); err != nil {
		t.Fatalf("appServerServerRequest: %v", err)
	}

	if pending := adapter.getPendingRequest(session.AgentSessionID, "root-turn-1", "child-approval-1"); pending != nil {
		t.Fatalf("approval was registered on root: %#v", pending)
	}
	pending := adapter.getPendingRequest(child.agentSessionID, child.turnID, "child-approval-1")
	if pending == nil {
		t.Fatal("approval was not registered on canonical child")
		return
	}
	changes, ok := pending.input["changes"].([]any)
	if !ok || len(changes) != 1 || asString(payloadObject(changes[0])["path"]) != "/workspace/permission-probe.txt" {
		t.Fatalf("child approval input = %#v, want known child file changes", pending.input)
	}
	emittedMu.Lock()
	requested := append([]activityshared.Event(nil), emitted...)
	emittedMu.Unlock()
	for _, event := range requested {
		if event.AgentSessionID != child.agentSessionID ||
			event.ProviderSessionID != "child-thread-1" ||
			event.Payload.TurnID != child.turnID ||
			event.SessionKind != "child" ||
			event.RootAgentSessionID != session.AgentSessionID ||
			event.RootTurnID != "root-turn-1" ||
			event.ParentToolCallID != "spawn-child-1" {
			t.Fatalf("requested event was not child-scoped: %#v", event)
		}
	}

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		AgentSessionID: child.agentSessionID,
		TurnID:         child.turnID,
		RequestID:      "child-approval-1",
		OptionID:       "approve",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	waitForCondition(t, func() bool {
		emittedMu.Lock()
		defer emittedMu.Unlock()
		return len(eventsOfType(emitted, activityshared.EventCallCompleted)) == 1
	})

	emittedMu.Lock()
	resolved := append([]activityshared.Event(nil), emitted...)
	emittedMu.Unlock()
	for _, event := range resolved {
		if event.AgentSessionID != child.agentSessionID || event.Payload.TurnID != child.turnID || event.SessionKind != "child" {
			t.Fatalf("resolved event was not child-scoped: %#v", event)
		}
	}
	responses := conn.responses(t)
	var result map[string]any
	if len(responses) == 1 {
		_ = json.Unmarshal(responses[0].Result, &result)
	}
	if len(responses) != 1 || asString(result["decision"]) != "accept" {
		t.Fatalf("approval response = %#v, want accept", responses)
	}
}

func TestCodexAppServerAdapterSteersChildApprovalFeedbackToExactProviderTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	_, _ = adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}
	appSession := adapter.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		t.Fatal("root app-server session is not live")
	}
	transport.server.mu.Lock()
	transport.server.hangSteer = true
	transport.server.mu.Unlock()
	adapter.turnSteerTimeout = 25 * time.Millisecond
	message := acpMessage{
		ID:     json.RawMessage(`"child-approval-feedback-1"`),
		Method: appServerMethodCommandApproval,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "child-thread-1",
			"turnId":   "provider-child-turn-1",
			"itemId":   "child-command-1",
		}),
	}
	if _, err := adapter.appServerServerRequest(
		context.Background(),
		appSession.client,
		session,
		"root-turn-1",
		message,
		newACPTurnNormalizer(),
		func([]activityshared.Event) {},
	); err != nil {
		t.Fatalf("appServerServerRequest: %v", err)
	}
	const feedback = "Do not run the command. Report that you stopped."
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		AgentSessionID: child.agentSessionID,
		TurnID:         child.turnID,
		RequestID:      "child-approval-feedback-1",
		OptionID:       "deny",
		Payload:        map[string]any{"denyMessage": feedback},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if got := adapter.InteractiveDispositionForTarget(session, child.agentSessionID, child.turnID, "child-approval-feedback-1"); got != InteractiveDispositionAnswered {
		t.Fatalf("interactive disposition = %q, want answered while feedback steer is pending", got)
	}

	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, transport.conn, appServerMethodTurnSteer)) == 1
	})
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["threadId"]) != "child-thread-1" ||
		asString(steer["expectedTurnId"]) != "provider-child-turn-1" {
		t.Fatalf("turn/steer target = %#v, want exact child thread and turn", steer)
	}
	input, _ := steer["input"].([]any)
	if len(input) != 1 || asString(payloadObject(input[0])["text"]) != feedback {
		t.Fatalf("turn/steer input = %#v, want full feedback", steer["input"])
	}
}

func TestCodexAppServerAdapterResolvesChildApprovalOutOfBand(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "root-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "root-thread-1",
		CWD:               "/workspace",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:        session.ProviderSessionID,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	})
	_, _ = adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("child thread was not registered")
	}
	childSession := appServerChildSession(session, "child-thread-1", child)
	if _, _, err := adapter.appServerApprovalRequested(
		childSession,
		child.turnID,
		json.RawMessage(`"child-approval-1"`),
		appServerMethodCommandApproval,
		map[string]any{"itemId": "child-command-1"},
		child.normalizer,
	); err != nil {
		t.Fatalf("appServerApprovalRequested: %v", err)
	}

	reduction := newCodexAppServerReducer(adapter).ReduceNotification(
		nil,
		session,
		"root-turn-1",
		acpMessage{
			Method: appServerNotifyServerRequestResolved,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId":  "child-thread-1",
				"requestId": "child-approval-1",
			}),
		},
		newACPTurnNormalizer(),
		nil,
	)
	if len(reduction.Events) != 0 {
		t.Fatalf("serverRequest/resolved events = %#v, want no direct events", reduction.Events)
	}
	if disposition := adapter.InteractiveDispositionForTarget(
		session,
		child.agentSessionID,
		child.turnID,
		"child-approval-1",
	); disposition != InteractiveDispositionSuperseded {
		t.Fatalf("child approval disposition = %q, want superseded", disposition)
	}
}

func TestCodexAppServerAdapterRejectsApprovalForUnknownChildThread(t *testing.T) {
	t.Parallel()

	conn := newAppServerCaptureConn()
	client := newCodexAppServerClient(conn)
	defer func() { _ = client.Close() }()
	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "root-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "root-thread-1",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:        session.ProviderSessionID,
		pendingRequests: make(map[string]*pendingInteractiveRequest),
	})
	var emitted []activityshared.Event
	_, err := adapter.appServerServerRequest(
		context.Background(),
		client,
		session,
		"root-turn-1",
		acpMessage{
			ID:     json.RawMessage(`"foreign-approval-1"`),
			Method: appServerMethodCommandApproval,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": "foreign-thread-1",
				"turnId":   "foreign-turn-1",
				"itemId":   "foreign-command-1",
			}),
		},
		newACPTurnNormalizer(),
		func(events []activityshared.Event) { emitted = append(emitted, events...) },
	)
	if err == nil {
		t.Fatal("unknown child approval was accepted")
	}
	if len(emitted) != 0 || adapter.getPendingRequest(session.AgentSessionID, "root-turn-1", "foreign-approval-1") != nil {
		t.Fatalf("unknown child approval mutated root: events=%#v", emitted)
	}
	responses := conn.responses(t)
	if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != -32000 {
		t.Fatalf("unknown child response = %#v, want one -32000 error", responses)
	}
}

// Only the spawn card creates the immutable child relationship. Wait/close
// cards may reference provider threads but cannot create a child session.
func TestCodexAppServerControlCardNeverClaimsChildOwnership(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
		CWD:               "/workspace",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})

	_, _ = adapter.rememberAppServerChildThreads(session, session.ProviderSessionID, session.AgentSessionID, "parent-turn-1", session.AgentSessionID, "parent-turn-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "wait-call-1",
		"tool":              "wait",
		"receiverThreadIds": []any{"child-thread-1"},
	})
	child, ok := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if ok {
		t.Fatalf("child after control card = %#v, want no child without a delegation edge", child)
	}

	_, _ = adapter.rememberAppServerChildThreads(session, session.ProviderSessionID, session.AgentSessionID, "parent-turn-1", session.AgentSessionID, "parent-turn-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-call-1",
		"tool":              "spawnAgent",
		"receiverThreadIds": []any{"child-thread-1"},
	})
	child, ok = adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	if !ok || child.parentItemID != "spawn-call-1" {
		t.Fatalf("child after spawn card = %#v, want ownership claimed by spawn-call-1", child)
	}
}

func TestCodexAppServerUnsupportedServerRequestCardsFollowDisposition(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		method   string
		wantCard bool
	}{
		// Schema-known background request the daemon deliberately declines:
		// respond -32601 silently, no transcript failure card.
		{name: "known background request stays silent", method: "account/chatgptAuthTokens/refresh", wantCard: false},
		{name: "known attestation request stays silent", method: "attestation/generate", wantCard: false},
		{name: "known foreground request renders failure card", method: "item/tool/call", wantCard: true},
		{name: "unknown request renders failure card", method: "definitely/notInSchema", wantCard: true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conn := newAppServerCaptureConn()
			client := newCodexAppServerClient(conn)
			defer func() { _ = client.Close() }()

			adapter := NewCodexAppServerAdapter(nil)
			session := Session{
				AgentSessionID:    "agent-session-1",
				Provider:          ProviderCodex,
				ProviderSessionID: "thread-1",
				CWD:               "/workspace",
			}
			var emitted []activityshared.Event
			events, err := adapter.handleAppServerMessage(context.Background(), client, session, "turn-1", acpMessage{
				ID:     json.RawMessage(`41`),
				Method: tc.method,
				Params: json.RawMessage(`{}`),
			}, newACPTurnNormalizer(), func(events []activityshared.Event) {
				emitted = append(emitted, events...)
			}, nil)
			if err != nil || len(events) != 0 {
				t.Fatalf("handleAppServerMessage = %#v, %v", events, err)
			}

			responses := conn.responses(t)
			if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != -32601 {
				t.Fatalf("responses = %#v, want one -32601 error response", responses)
			}
			if !tc.wantCard {
				if len(emitted) != 0 {
					t.Fatalf("emitted = %#v, want no transcript card for known method", emitted)
				}
				return
			}
			if len(emitted) != 1 || emitted[0].Type != activityshared.EventCallFailed {
				t.Fatalf("emitted = %#v, want one call.failed card", emitted)
			}
		})
	}
}

func TestCodexAppServerClassifiesEveryGeneratedServerRequest(t *testing.T) {
	t.Parallel()

	for _, method := range codexproto.ServerRequestMethods() {
		if disposition := appServerServerRequestDispositionForMethod(method); disposition == appServerServerRequestUnknown {
			t.Errorf("generated server request %q has no explicit adapter disposition", method)
		}
	}
}

func TestCodexAppServerMessageOnlyMCPElicitationRoundTripsApproval(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		optionID     string
		meta         map[string]any
		wantAction   string
		wantPersist  string
		wantOptionID []string
	}{
		{
			name:         "allow once",
			optionID:     "approve",
			meta:         map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []any{"session", "always"}},
			wantAction:   "accept",
			wantOptionID: []string{"approve", "approve_for_session", "approve_always", "cancel"},
		},
		{
			name:         "allow for session",
			optionID:     "approve_for_session",
			meta:         map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []any{"session", "always"}},
			wantAction:   "accept",
			wantPersist:  "session",
			wantOptionID: []string{"approve", "approve_for_session", "approve_always", "cancel"},
		},
		{
			name:         "always allow",
			optionID:     "approve_always",
			meta:         map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []any{"session", "always"}},
			wantAction:   "accept",
			wantPersist:  "always",
			wantOptionID: []string{"approve", "approve_for_session", "approve_always", "cancel"},
		},
		{
			name:         "cancel tool call",
			optionID:     "cancel",
			meta:         map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []any{"session", "always"}},
			wantAction:   "cancel",
			wantOptionID: []string{"approve", "approve_for_session", "approve_always", "cancel"},
		},
		{
			name:         "decline ordinary request",
			optionID:     "deny",
			wantAction:   "decline",
			wantOptionID: []string{"approve", "deny", "cancel"},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conn := newAppServerCaptureConn()
			client := newCodexAppServerClient(conn)
			defer func() { _ = client.Close() }()
			adapter := NewCodexAppServerAdapter(nil)
			session := Session{
				AgentSessionID:    "agent-session-1",
				Provider:          ProviderCodex,
				ProviderSessionID: "thread-1",
				CWD:               "/workspace",
			}
			adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
				threadID:        session.ProviderSessionID,
				pendingRequests: make(map[string]*pendingInteractiveRequest),
			})

			var emitted []activityshared.Event
			_, err := adapter.handleAppServerMessage(
				context.Background(),
				client,
				session,
				"turn-1",
				acpMessage{
					ID:     json.RawMessage(`"elicitation-1"`),
					Method: "mcpServer/elicitation/request",
					Params: mustJSONRawMessage(t, map[string]any{
						"threadId":   "thread-1",
						"turnId":     "provider-turn-1",
						"serverName": "node_repl",
						"mode":       "form",
						"message":    "Allow node_repl to control the visible Browser?",
						"requestedSchema": map[string]any{
							"type":       "object",
							"properties": map[string]any{},
						},
						"_meta": tc.meta,
					}),
				},
				newACPTurnNormalizer(),
				func(events []activityshared.Event) { emitted = append(emitted, events...) },
				nil,
			)
			if err != nil {
				t.Fatalf("handleAppServerMessage: %v", err)
			}

			pending := adapter.getPendingRequest(session.AgentSessionID, "turn-1", "elicitation-1")
			if pending == nil || pending.kind != "approval" || asString(pending.input["reason"]) != "Allow node_repl to control the visible Browser?" {
				t.Fatalf("pending elicitation = %#v, want visible approval", pending)
			}
			optionIDs := make([]string, 0, len(pending.options))
			for _, option := range pending.options {
				optionIDs = append(optionIDs, asString(option["optionId"]))
			}
			if !reflect.DeepEqual(optionIDs, tc.wantOptionID) {
				t.Fatalf("option ids = %#v, want %#v", optionIDs, tc.wantOptionID)
			}
			for _, option := range pending.options {
				if asString(option["optionId"]) == "cancel" &&
					(asString(option["name"]) != "Cancel" || asString(option["kind"]) != "reject_once") {
					t.Fatalf("cancel option = %#v, want neutral one-shot cancellation presentation", option)
				}
			}
			if requested := eventsOfType(emitted, activityshared.EventInteractionRequested); len(requested) != 1 {
				t.Fatalf("interaction.requested events = %#v, want one", requested)
			}

			result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
				TurnID:    "turn-1",
				RequestID: "elicitation-1",
				OptionID:  tc.optionID,
			})
			if err != nil || !result.Accepted || result.OptionID != tc.optionID {
				t.Fatalf("SubmitInteractive = %#v, %v", result, err)
			}

			responses := conn.responses(t)
			if len(responses) != 1 || responses[0].Error != nil {
				t.Fatalf("responses = %#v, want one success", responses)
			}
			var response map[string]any
			if err := json.Unmarshal(responses[0].Result, &response); err != nil {
				t.Fatalf("unmarshal elicitation response: %v", err)
			}
			if asString(response["action"]) != tc.wantAction {
				t.Fatalf("response = %#v, want action %q", response, tc.wantAction)
			}
			meta := payloadObject(response["_meta"])
			if asString(meta["persist"]) != tc.wantPersist {
				t.Fatalf("response meta = %#v, want persist %q", meta, tc.wantPersist)
			}
			if _, exists := response["content"]; exists {
				t.Fatalf("message-only response = %#v, want no content", response)
			}
		})
	}
}

func TestCodexAppServerRejectsMCPElicitationItCannotRepresent(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		params map[string]any
	}{
		{
			name: "form fields",
			params: map[string]any{
				"mode":    "form",
				"message": "Choose a value",
				"requestedSchema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"value": map[string]any{"type": "string"},
					},
				},
			},
		},
		{
			name: "URL mode",
			params: map[string]any{
				"mode":          "url",
				"message":       "Open authorization page",
				"url":           "https://example.com/authorize",
				"elicitationId": "url-1",
			},
		},
		{
			name: "tool suggestion",
			params: map[string]any{
				"mode":    "form",
				"message": "Install a suggested tool",
				"requestedSchema": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
				"_meta": map[string]any{"codex_approval_kind": "tool_suggestion"},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conn := newAppServerCaptureConn()
			client := newCodexAppServerClient(conn)
			defer func() { _ = client.Close() }()
			adapter := NewCodexAppServerAdapter(nil)
			session := Session{
				AgentSessionID:    "agent-session-1",
				Provider:          ProviderCodex,
				ProviderSessionID: "thread-1",
			}
			adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
				threadID:        session.ProviderSessionID,
				pendingRequests: make(map[string]*pendingInteractiveRequest),
			})
			params := clonePayload(tc.params)
			params["threadId"] = "thread-1"
			params["turnId"] = "provider-turn-1"
			params["serverName"] = "node_repl"

			_, err := adapter.handleAppServerMessage(
				context.Background(),
				client,
				session,
				"turn-1",
				acpMessage{
					ID:     json.RawMessage(`"elicitation-unsupported"`),
					Method: "mcpServer/elicitation/request",
					Params: mustJSONRawMessage(t, params),
				},
				newACPTurnNormalizer(),
				func([]activityshared.Event) {},
				nil,
			)
			if err == nil {
				t.Fatal("unrepresentable elicitation was accepted")
			}
			if pending := adapter.getPendingRequest(session.AgentSessionID, "turn-1", "elicitation-unsupported"); pending != nil {
				t.Fatalf("unrepresentable elicitation registered pending state: %#v", pending)
			}
			responses := conn.responses(t)
			if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != -32602 {
				t.Fatalf("responses = %#v, want one -32602", responses)
			}
		})
	}
}

// ADR 0003 open question: can child-thread events arrive before the parent
// collabAgentToolCall announces receiverThreadIds? This detector makes real
// deployments answer it permanently: unknown-thread drops are remembered, and
// registration reports how many events were lost to the ordering gap.
func TestCodexAppServerChildRegistrationReportsEarlyDrops(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})

	// Two child events arrive before anything registered the child: both drop.
	for range 2 {
		route := adapter.appServerNotificationRoute(session, "parent-turn-1", appServerNotifyAgentMessageDelta, map[string]any{
			"threadId": "child-early-1",
			"turnId":   "child-turn-1",
			"delta":    "early output",
		})
		if !route.drop || len(route.events) != 0 {
			t.Fatalf("unknown thread event should drop: %#v", route)
		}
	}

	added, _ := adapter.rememberAppServerChildThreads(session, session.ProviderSessionID, session.AgentSessionID, "parent-turn-1", session.AgentSessionID, "parent-turn-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-1",
		"receiverThreadIds": []any{"child-early-1", "child-clean-2"},
	})
	if len(added) != 2 {
		t.Fatalf("added = %#v, want both children", added)
	}

	early, ok := adapter.appServerChildThread(session.AgentSessionID, "child-early-1")
	if !ok || early.droppedBeforeRegistration != 2 {
		t.Fatalf("child-early-1 droppedBeforeRegistration = %#v (ok=%v), want 2", early, ok)
	}
	clean, ok := adapter.appServerChildThread(session.AgentSessionID, "child-clean-2")
	if !ok || clean.droppedBeforeRegistration != 0 {
		t.Fatalf("child-clean-2 droppedBeforeRegistration = %#v (ok=%v), want 0", clean, ok)
	}
}

func TestCodexAppServerChildTerminalBeforeRegistrationIsReplayed(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		method        string
		params        map[string]any
		terminalEvent activityshared.EventType
	}{
		{
			name:          "turn completed",
			method:        appServerNotifyTurnCompleted,
			params:        map[string]any{"turn": map[string]any{"id": "child-turn-1", "status": "completed"}},
			terminalEvent: activityshared.EventTurnCompleted,
		},
		{
			name:          "terminal error",
			method:        appServerNotifyError,
			params:        map[string]any{"willRetry": false, "error": map[string]any{"message": "child failed"}},
			terminalEvent: activityshared.EventTurnFailed,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := NewCodexAppServerAdapter(nil)
			session := Session{
				AgentSessionID:    "agent-session-1",
				Provider:          ProviderCodex,
				ProviderSessionID: "parent-thread-1",
				CWD:               "/workspace",
			}
			adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})
			reducer := newCodexAppServerReducer(adapter)
			normalizer := newACPTurnNormalizer()

			terminalParams := clonePayload(test.params)
			terminalParams["threadId"] = "child-thread-1"
			terminalParams["turnId"] = "child-turn-1"
			if events := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
				Method: test.method,
				Params: mustJSONRawMessage(t, terminalParams),
			}, normalizer, nil).Events; len(events) != 0 {
				t.Fatalf("early terminal events = %#v, want buffered until child registration", events)
			}

			events := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
				Method: appServerNotifyItemStarted,
				Params: mustJSONRawMessage(t, map[string]any{
					"threadId": session.ProviderSessionID,
					"turnId":   "parent-turn-1",
					"item": map[string]any{
						"type":              "collabAgentToolCall",
						"id":                "spawn-child-1",
						"tool":              "spawnAgent",
						"status":            "inProgress",
						"receiverThreadIds": []any{"child-thread-1"},
					},
				}),
			}, normalizer, nil).Events

			terminalCount := 0
			for _, event := range events {
				if event.Type == test.terminalEvent {
					terminalCount++
					if event.SessionKind != "child" || event.ProviderSessionID != "child-thread-1" {
						t.Fatalf("terminal event = %#v, want child routing", event)
					}
				}
			}
			if terminalCount != 1 {
				t.Fatalf("terminal events = %#v, want exactly one replayed %s", events, test.terminalEvent)
			}
		})
	}
}

func TestCodexAppServerChildThreadNameUpdateEmitsNameMarker(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})
	reducer := newCodexAppServerReducer(adapter)
	normalizer := newACPTurnNormalizer()

	reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "parent-turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-child-1",
				"tool":              "spawnAgent",
				"status":            "inProgress",
				"receiverThreadIds": []any{"child-thread-1"},
			},
		}),
	}, normalizer, nil)

	nameEvents := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyThreadNameUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId":   "child-thread-1",
			"threadName": "Repo smell analyst",
		}),
	}, normalizer, nil).Events
	if len(nameEvents) != 1 {
		t.Fatalf("child name events = %#v, want one name marker", nameEvents)
	}
	marker := nameEvents[0]
	if marker.Type != activityshared.EventSessionUpdated ||
		marker.ProviderSessionID != "child-thread-1" ||
		marker.Payload.Title != "Repo smell analyst" ||
		marker.SessionKind != "child" {
		t.Fatalf("child title event = %#v", marker)
	}

	// The PARENT thread's own name updates keep today's behavior (no marker).
	parentNameEvents := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyThreadNameUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId":   session.ProviderSessionID,
			"threadName": "Parent title",
		}),
	}, normalizer, nil).Events
	for _, event := range parentNameEvents {
		if event.AgentSessionID != session.AgentSessionID {
			t.Fatalf("parent thread name updated another session: %#v", event)
		}
	}
}

func TestCodexAppServerChildThreadErrorDoesNotFailParentTurn(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
		CWD:               "/workspace",
	}
	activeTurn := &codexAppServerActiveTurn{
		turnID:   "parent-turn-1",
		phase:    codexAppServerTurnPhaseRunning,
		terminal: make(chan codexAppServerTurnTerminal, 1),
	}
	// activeTurnID stays empty on purpose: before turn/started records the
	// provider turn id (or during a goal-continuation gap) the empty id
	// matches any turn id as a wildcard, so a child error routed to the
	// parent would fail its running turn.
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:   session.ProviderSessionID,
		activeTurn: activeTurn,
	})
	reducer := newCodexAppServerReducer(adapter)
	normalizer := newACPTurnNormalizer()

	// Link the child thread the same way a real collab spawn does.
	reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "parent-turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-child-1",
				"tool":              "spawnAgent",
				"status":            "inProgress",
				"prompt":            "inspect",
				"receiverThreadIds": []any{"child-thread-1"},
			},
		}),
	}, normalizer, nil)

	events := reducer.ReduceNotification(nil, session, "parent-turn-1", acpMessage{
		Method: appServerNotifyError,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId":  "child-thread-1",
			"willRetry": false,
			"error":     map[string]any{"message": "child thread exploded"},
		}),
	}, normalizer, nil).Events
	if len(events) != 1 ||
		events[0].Type != activityshared.EventTurnFailed ||
		events[0].ProviderSessionID != "child-thread-1" ||
		activityshared.BestEffortErrorMessage(events[0].Payload) != "child thread exploded" {
		t.Fatalf("child error events = %#v, want one child failed turn", events)
	}
	if activeTurn.phase != codexAppServerTurnPhaseRunning {
		t.Fatalf("parent turn phase = %q, want still running", activeTurn.phase)
	}
	select {
	case terminal := <-activeTurn.terminal:
		t.Fatalf("parent turn terminal = %#v, want none from child error", terminal)
	default:
	}
}

func TestCodexAppServerStrayTurnStartedDoesNotHijackActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "parent-thread-1",
		CWD:               "/workspace",
	}
	activeTurn := &codexAppServerActiveTurn{
		turnID:   "local-turn-1",
		phase:    codexAppServerTurnPhaseRunning,
		terminal: make(chan codexAppServerTurnTerminal, 1),
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:   session.ProviderSessionID,
		activeTurn: activeTurn,
	})
	reducer := newCodexAppServerReducer(adapter)
	normalizer := newACPTurnNormalizer()

	// The user's turn records its provider turn id.
	reducer.ReduceNotification(nil, session, "local-turn-1", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-real", "status": "inProgress"},
		}),
	}, normalizer, nil)
	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "turn-real" {
		t.Fatalf("activeTurnID = %q, want turn-real", got)
	}

	// A stray server-initiated turn starts on the same thread mid-task
	// (e.g. auto-compaction). It must not steal the live turn's identity.
	reducer.ReduceNotification(nil, session, "local-turn-1", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-stray", "status": "inProgress"},
		}),
	}, normalizer, nil)

	// The real turn completes; the waiting Exec must receive its payload.
	reducer.ReduceNotification(nil, session, "local-turn-1", acpMessage{
		Method: appServerNotifyTurnCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-real", "status": "completed"},
		}),
	}, normalizer, nil)

	select {
	case terminal := <-activeTurn.terminal:
		if asString(terminal.turn["id"]) != "turn-real" || terminal.phase != codexAppServerTurnPhaseCompleted {
			t.Fatalf("terminal = %#v, want completed turn-real payload", terminal)
		}
	default:
		t.Fatalf(
			"real turn/completed was dropped: stray turn/started hijacked activeTurnID (now %q); awaitTurnCompletion would block forever",
			adapter.sessionActiveTurnID(session.AgentSessionID),
		)
	}
}

// TestCodexAppServerAdapterApplyTokenUsagePrefersLastRequest verifies that
// usedTokens reflects the most-recent request's context size ("last"), not the
// running sum across all requests in the thread ("total").  The two diverge
// quickly in agentic sessions: after ten 27 K-token calls the cumulative total
// hits 270 K and falsely saturates a 258 K context window even though each
// individual request was only 10 % full.
// TestCodexAppServerAdapterApplyTokenUsagePrefersInputTokens verifies the
// precedence chain: last.inputTokens > last.totalTokens > total.totalTokens.
// last.inputTokens is the most accurate context-fill indicator because it
// excludes response and reasoning tokens that don't occupy the context window.
func TestCodexAppServerAdapterApplyTokenUsagePrefersInputTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last": map[string]any{
				"inputTokens":           int64(1000),
				"outputTokens":          int64(150),
				"reasoningOutputTokens": int64(50),
				"totalTokens":           int64(1200),
			},
			"total":              map[string]any{"totalTokens": int64(4800)},
			"modelContextWindow": int64(272000),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := int64Value(contextWindow["usedTokens"]); used != 1000 {
		t.Fatalf("usedTokens = %v, want last.inputTokens (1000): context fill should exclude response/reasoning tokens", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageFallsBackToLastTotalTokens verifies
// that last.totalTokens is used when last.inputTokens is absent — the schema
// guarantees totalTokens is always present in a TokenUsageBreakdown.
func TestCodexAppServerAdapterApplyTokenUsageFallsBackToLastTotalTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"totalTokens": int64(1200)},
			"total":              map[string]any{"totalTokens": int64(4800)},
			"modelContextWindow": int64(272000),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := int64Value(contextWindow["usedTokens"]); used != 1200 {
		t.Fatalf("usedTokens = %v, want last.totalTokens (1200), not cumulative total (4800)", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageCompactFrameUsesLastTotalTokens
// reproduces the post-compaction frame Codex app-server emits: last.inputTokens
// is explicitly 0 while last.totalTokens carries the real compacted context size
// (summary). The display must show the compacted size, not 0. (Captured live:
// seed last.inputTokens=26017 -> compact last.inputTokens=0/totalTokens=5763.)
func TestCodexAppServerAdapterApplyTokenUsageCompactFrameUsesLastTotalTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)

	// Seed turn: window is full at 26017.
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"inputTokens": int64(26017), "totalTokens": int64(26049)},
			"total":              map[string]any{"totalTokens": int64(26049)},
			"modelContextWindow": int64(258400),
		},
	})

	// Compact frame: inputTokens is explicitly 0, totalTokens=5763 is the real
	// post-compaction context size.
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"inputTokens": int64(0), "totalTokens": int64(5763)},
			"total":              map[string]any{"totalTokens": int64(26049)},
			"modelContextWindow": int64(258400),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := int64Value(contextWindow["usedTokens"]); used != 5763 {
		t.Fatalf("usedTokens = %v, want post-compact last.totalTokens (5763); a literal 0 inputTokens must not be shown as the context fill", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageNoCumulativeFalsePositive verifies
// that repeated calls with the same per-request size do not inflate usedTokens
// beyond the context window, which would falsely trigger the compact alert.
func TestCodexAppServerAdapterApplyTokenUsageNoCumulativeFalsePositive(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	window := int64(258400)
	perRequest := int64(27000)

	// Simulate 10 tool calls, each sending ~27 K tokens.  The cumulative total
	// grows to 270 K (> window), but the per-request "last" stays at 27 K.
	for i := range 10 {
		adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
			"tokenUsage": map[string]any{
				"last":               map[string]any{"totalTokens": perRequest},
				"total":              map[string]any{"totalTokens": perRequest * int64(i+1)},
				"modelContextWindow": window,
			},
		})
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	used, _ := int64Value(contextWindow["usedTokens"])
	total, _ := int64Value(contextWindow["totalTokens"])
	if used > total {
		t.Fatalf("usedTokens (%d) > totalTokens (%d): cumulative sum is leaking into context-window display", used, total)
	}
	if used != perRequest {
		t.Fatalf("usedTokens = %d, want per-request last (%d)", used, perRequest)
	}
}

// The GUI keys sub-agent lanes to the collab card by child thread id, so the
// projected rawInput must carry the item's receiverThreadIds from the start
// (item/started already includes them).
func TestAppServerCollabAgentRawInputCarriesReceiverThreadIDs(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "call-subagent-1",
		"tool":              "spawnAgent",
		"status":            "inProgress",
		"prompt":            "Do a thing.",
		"receiverThreadIds": []any{"child-thread-1", " child-thread-2 ", ""},
	}, false)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawInput, ok := update["rawInput"].(map[string]any)
	if !ok {
		t.Fatalf("rawInput = %#v, want map", update["rawInput"])
	}
	ids, ok := rawInput["receiverThreadIds"].([]any)
	if !ok {
		t.Fatalf("rawInput.receiverThreadIds = %#v, want []any", rawInput["receiverThreadIds"])
	}
	if len(ids) != 2 || ids[0] != "child-thread-1" || ids[1] != "child-thread-2" {
		t.Fatalf("receiverThreadIds = %#v, want [child-thread-1 child-thread-2]", ids)
	}
}
