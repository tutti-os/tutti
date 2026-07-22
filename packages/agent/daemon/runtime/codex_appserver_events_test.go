package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"sync"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
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

func TestCodexAppServerUnhandledServerRequestCardOnlyForUnknownMethods(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		method   string
		wantCard bool
	}{
		// Schema-known background request the daemon deliberately declines:
		// respond -32601 silently, no transcript failure card.
		{name: "known background request stays silent", method: "account/chatgptAuthTokens/refresh", wantCard: false},
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

func TestUnexpectedExternalAuthRefreshUsesRegistryOwnership(t *testing.T) {
	t.Parallel()

	if !unexpectedExternalAuthRefresh(ProviderTuttiAgent, appServerMethodChatgptAuthTokensRefresh) {
		t.Fatal("runtime-owned auth should diagnose an external refresh request")
	}
	if unexpectedExternalAuthRefresh(ProviderCodex, appServerMethodChatgptAuthTokensRefresh) {
		t.Fatal("host-owned auth should keep the normal background request path")
	}
	if unexpectedExternalAuthRefresh(ProviderTuttiAgent, "account/other") {
		t.Fatal("unrelated requests must not be diagnosed as auth refresh")
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
