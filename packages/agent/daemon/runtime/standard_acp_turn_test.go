package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestStandardACPAdapterStampsAuthoritativeTurnLifecycle(t *testing.T) {
	t.Parallel()

	adapter := &standardACPAdapter{}
	adapterSession := &standardACPSession{}
	session := reportTestSession()
	session.Provider = "acp:gemini"
	events := adapter.stampTurnLifecycleSnapshots(adapterSession, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil),
		newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{"error": "quota exceeded"}),
	})

	if len(events) != 2 {
		t.Fatalf("stamped event count = %d, want 2", len(events))
	}
	started, ok := activityshared.TurnLifecycleSnapshotFromEvent(events[0])
	if !ok || started.Origin != activityshared.TurnLifecycleOriginAdapter || started.ActiveTurnID != "turn-1" || started.Phase != "running" || started.Seq != 1 {
		t.Fatalf("started lifecycle snapshot = %#v, %v", started, ok)
	}
	failed, ok := activityshared.TurnLifecycleSnapshotFromEvent(events[1])
	if !ok || failed.Origin != activityshared.TurnLifecycleOriginAdapter || failed.ActiveTurnID != "" || failed.Phase != "settled" || failed.Outcome != "failed" || failed.Seq != 2 {
		t.Fatalf("failed lifecycle snapshot = %#v, %v", failed, ok)
	}
}

func TestStandardACPAdaptersDoNotAdvertiseSessionFork(t *testing.T) {
	t.Parallel()

	adapters := map[string]Adapter{
		"cursor":   newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil),
		"opencode": newOpenCodeTestAdapter(nil),
		"nexight":  NewNexightAdapter(nil),
		"openclaw": NewOpenClawAdapter(nil),
	}
	for name, adapter := range adapters {
		if _, ok := adapter.(SessionForkAdapter); ok {
			t.Fatalf("%s standard ACP adapter advertises Session Fork", name)
		}
	}
}

func TestStandardACPAdaptersReportProviderLifecycleWithoutSettlingCanonicalRoot(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name              string
		agentTitle        string
		providerSessionID string
		provider          string
		build             func(ProcessTransport) *standardACPAdapter
	}{
		{name: "cursor", agentTitle: "Cursor Agent", providerSessionID: "cursor-session-root-lifecycle", provider: ProviderCursor, build: func(transport ProcessTransport) *standardACPAdapter {
			return newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		}},
		{name: "opencode", agentTitle: "OpenCode", providerSessionID: "opencode-session-root-lifecycle", provider: ProviderOpenCode, build: newOpenCodeTestAdapter},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			transport := newStandardACPTransport(tt.agentTitle, tt.providerSessionID)
			adapter := tt.build(transport)
			session := standardTestSession(tt.provider)
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			session.ProviderSessionID = tt.providerSessionID

			events, err := adapter.Exec(context.Background(), session, textPrompt("inspect the workspace"), "", "root-turn-1", nil, nil)
			if err != nil {
				t.Fatalf("Exec: %v", err)
			}
			if !adapter.UsesRootProviderTurnLifecycle() {
				t.Fatal("standard ACP adapter did not opt into daemon-owned root settlement")
			}

			var started, completed bool
			for _, event := range events {
				switch event.Type {
				case activityshared.EventRootProviderTurnStarted:
					started = event.Payload.TurnID == "root-turn-1" && event.Payload.ProviderTurnID == "root-turn-1"
				case activityshared.EventRootProviderTurnCompleted:
					completed = event.Payload.TurnID == "root-turn-1" &&
						event.Payload.ProviderTurnID == "root-turn-1" &&
						event.Payload.TurnOutcome == string(activityshared.TurnOutcomeCompleted)
				case activityshared.EventTurnCompleted, activityshared.EventTurnFailed, activityshared.EventTurnCanceled:
					t.Fatalf("standard ACP emitted canonical terminal event before daemon settlement: %#v", event)
				}
			}
			if !started || !completed {
				t.Fatalf("provider lifecycle started=%v completed=%v, events=%#v", started, completed, activityEventTypeCounts(events))
			}
		})
	}
}

func TestStandardACPAdapterPreservesFinalMarkdownThroughTurnProjection(t *testing.T) {
	t.Parallel()

	const finalMarkdown = "# Result\n\n- first\n- second\n\n```go\nfmt.Println(\"ok\")\n```\n"
	transport := newStandardACPTransport("Cursor Agent", "cursor-session-markdown")
	transport.conn.promptFinalContent = []map[string]any{
		{"type": "text", "text": "# Result\n\n"},
		{"type": "text", "text": "- first\n- second\n\n"},
		{"type": "text", "text": "```go\nfmt.Println(\"ok\")\n```\n"},
	}
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-markdown"

	events, err := adapter.Exec(context.Background(), session, textPrompt("format the result"), "", "turn-markdown", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	messages := activityMessagesWithRole(events, activityshared.MessageRoleAssistant)
	if len(messages) == 0 {
		t.Fatalf("assistant messages = %#v, want final Markdown snapshot", messages)
	}
	want := strings.TrimSpace(finalMarkdown)
	if got := messages[len(messages)-1].Payload.Content; got != want {
		t.Fatalf("final assistant content = %q, want %q", got, want)
	}
}

func TestStandardACPAdapterFailsEmptyCompletedTurn(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Kimi Code", "kimi-session-empty")
	transport.conn.emptyPromptResult = true
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:kimi-code",
		Name:     "kimi-code-acp",
		Command:  []string{"kimi", "acp"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "kimi-session-empty"

	events, err := adapter.Exec(
		context.Background(),
		session,
		textPrompt("hello"),
		"",
		"turn-empty",
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) ||
		!strings.Contains(asString(completed[0].Payload.Metadata["error"]), "provider_empty_response") {
		t.Fatalf("provider turn completion = %#v, want failed empty response", completed)
	}
}

func TestStandardACPAdapterCompletesObservableOutputWithoutAssistantText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		update map[string]any
	}{
		{
			name: "thinking only",
			update: map[string]any{
				"sessionUpdate": "agent_thought_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Considering the request.",
				},
			},
		},
		{
			name: "system notice only",
			update: map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Codex switched to HTTPS transport.",
				},
				"_meta": map[string]any{
					"tsh": map[string]any{
						"kind":       "agent_system_notice",
						"noticeKind": "transport_fallback",
						"severity":   "warning",
						"title":      "Codex switched to HTTPS transport.",
						"detail":     "Falling back from WebSockets to HTTPS transport.",
					},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport("Kimi Code", "kimi-session-observable")
			transport.conn.promptResultUpdates = []map[string]any{tt.update}
			adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider: "acp:kimi-code",
				Name:     "kimi-code-acp",
				Command:  []string{"kimi", "acp"},
			}, transport, LegacyHostMetadata())
			if err != nil {
				t.Fatalf("NewStandardACPAdapter: %v", err)
			}
			adapter := adapterRaw.(*standardACPAdapter)
			session := standardTestSession("acp:kimi-code")
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			session.ProviderSessionID = "kimi-session-observable"

			events, err := adapter.Exec(
				context.Background(),
				session,
				textPrompt("hello"),
				"",
				"turn-observable",
				nil,
				nil,
			)
			if err != nil {
				t.Fatalf("Exec: %v", err)
			}
			completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
			if len(completed) != 1 ||
				completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
				t.Fatalf("provider turn completion = %#v, want completed observable output", completed)
			}
		})
	}
}

func TestStandardACPDropsLateTurnScopedUpdatesOutsidePromptCall(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	events := standardACPUpdateEvents(
		newOpenCodeTestAdapter(nil).config,
		session,
		"settled-root-turn",
		json.RawMessage(`{"update":{"sessionUpdate":"tool_call","toolCallId":"late-task","title":"Task","status":"pending"}}`),
		nil,
	)
	if len(events) != 0 {
		t.Fatalf("late tool events = %#v, want no events attached to the settled root", events)
	}
}

func TestStandardACPRejectsLatePermissionOutsidePromptCall(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-late-permission")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-late-permission"
	client := adapter.getSession(session.AgentSessionID).client

	events, err := adapter.handleACPMessage(context.Background(), client, session, "settled-root-turn", acpMessage{
		ID:     json.RawMessage(`"late-permission"`),
		Method: acpMethodPermission,
		Params: json.RawMessage(`{"toolCall":{"toolCallId":"late-task","title":"Allow Task"},"options":[{"optionId":"allow","kind":"allow_once"}]}`),
	}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "outside an active prompt turn") {
		t.Fatalf("late permission error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("late permission events = %#v, want no synthetic turn or interaction", events)
	}
	if pending := adapter.getPendingApproval(session.AgentSessionID, "settled-root-turn", "late-permission"); pending != nil {
		t.Fatalf("late permission created pending interaction: %#v", pending)
	}
}

func TestStandardACPCancelPropagatesNotifyFailure(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("cancel transport unavailable")
	adapter := newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	activePrompt := &standardACPActivePrompt{done: make(chan struct{})}
	adapterSession := &standardACPSession{
		client:            &acpClient{conn: standardACPFailingSendConnection{err: wantErr}},
		providerSessionID: "cursor-session-cancel",
		activePrompt:      activePrompt,
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if _, err := adapter.Cancel(context.Background(), session, "user canceled"); !errors.Is(err, wantErr) {
		t.Fatalf("Cancel error = %v, want %v", err, wantErr)
	}
	if adapter.standardACPPromptCancelRequested(adapterSession, activePrompt) {
		t.Fatal("failed session/cancel marked the active prompt as canceled")
	}
}

func TestStandardACPCancelWinsOverRetriableAutoContinue(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-cancel-retry-race")
	transport.conn.deferFirstPromptUntilCancel = true
	transport.conn.canceledDeferredPromptRetriableTail = true
	transport.conn.promptStarted = make(chan struct{}, 1)
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(t.Context(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-cancel-retry-race"

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(
			context.Background(),
			session,
			textPrompt("inspect the workspace"),
			"inspect the workspace",
			"turn-cancel-retry-race",
			nil,
			nil,
		)
		execDone <- events
	}()
	select {
	case <-transport.conn.promptStarted:
	case <-t.Context().Done():
		t.Fatal("session/prompt did not start")
	}

	if _, err := adapter.Cancel(t.Context(), session, "user canceled"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	events := <-execDone
	transport.conn.mu.Lock()
	promptCalls := transport.conn.promptCallCount
	transport.conn.mu.Unlock()
	if promptCalls != 1 {
		t.Fatalf("prompt calls = %d, want cancellation to prevent auto-continue", promptCalls)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
		t.Fatalf("provider completion = %#v, want canceled", completed)
	}
}

func TestStandardACPCancelDrainsPromptBeforeAcceptingAnotherTurn(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-cancel-drain")
	transport.conn.deferFirstPromptUntilCancel = true
	transport.conn.promptStarted = make(chan struct{}, 1)
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(t.Context(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-cancel-drain"

	firstDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(
			context.Background(),
			session,
			[]PromptContentBlock{{Type: "text", Text: "first"}},
			"first",
			"turn-first",
			nil,
			nil,
		)
		firstDone <- events
	}()
	select {
	case <-transport.conn.promptStarted:
	case <-t.Context().Done():
		t.Fatal("first session/prompt did not start")
	}

	if _, err := adapter.Cancel(t.Context(), session, "user canceled"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	var firstEvents []activityshared.Event
	select {
	case firstEvents = <-firstDone:
	default:
		t.Fatal("Cancel returned before the active session/prompt drained")
	}
	completed := eventsOfType(firstEvents, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
		t.Fatalf("first provider completion = %#v, want canceled", completed)
	}

	secondEvents, err := adapter.Exec(
		t.Context(),
		session,
		[]PromptContentBlock{{Type: "text", Text: "second"}},
		"second",
		"turn-second",
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("second Exec: %v", err)
	}
	completed = eventsOfType(secondEvents, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("second provider completion = %#v, want completed", completed)
	}
}

func TestStandardACPAutoApprovePropagatesResponseFailure(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("permission response transport unavailable")
	adapter := newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "full-access"
	adapter.storeSession(session.AgentSessionID, &standardACPSession{
		client:            &acpClient{conn: standardACPFailingSendConnection{err: wantErr}},
		providerSessionID: "cursor-session-auto-approve",
		permissionModeID:  "full-access",
	})
	client := adapter.getSession(session.AgentSessionID).client

	events, err := adapter.handleACPMessage(context.Background(), client, session, "root-turn-1", acpMessage{
		ID:     json.RawMessage(`"permission-1"`),
		Method: acpMethodPermission,
		Params: json.RawMessage(`{"toolCall":{"toolCallId":"task-1","title":"Allow Task"},"options":[{"optionId":"allow","kind":"allow_once"}]}`),
	}, newACPTurnNormalizer(), nil, nil)
	if !errors.Is(err, wantErr) {
		t.Fatalf("auto-approve response error = %v, want %v", err, wantErr)
	}
	if len(events) != 0 {
		t.Fatalf("auto-approve response events = %#v, want no false resolution", events)
	}
}

type standardACPFailingSendConnection struct {
	err error
}

func (c standardACPFailingSendConnection) Send([]byte) error {
	return c.err
}

func (standardACPFailingSendConnection) Recv() (ProcessFrame, error) {
	return ProcessFrame{}, io.EOF
}

func (standardACPFailingSendConnection) Close() error {
	return nil
}

func TestOpenCodeAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-1")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this screenshot?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Path:     "/managed/agent-prompt-assets/screen.png",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent error = %v, want nil", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities := capabilitySnapshotValues(snapshot.Capabilities)
	if !containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime capabilities = %#v, want imageInput", capabilities)
	}
}

func TestCursorAdapterAllowsImagePromptWithoutInitializeCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor", "cursor-session-1")
	adapter := NewCursorAdapter(transport)
	session := standardTestSession(ProviderCursor)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	content := []PromptContentBlock{{
		Type: "text",
		Text: "what is in this screenshot?",
	}, {
		Type:     "image",
		MimeType: "image/png",
		Data:     "aW1hZ2U=",
	}}
	if err := adapter.ValidatePromptContent(session, content); err != nil {
		t.Fatalf("ValidatePromptContent error = %v, want nil", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities := capabilitySnapshotValues(snapshot.Capabilities)
	if !containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime capabilities = %#v, want imageInput", capabilities)
	}
}

func TestStandardACPAdapterExecMaterializesRemoteImageAtProviderBoundary(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-remote-image")
	adapter := newOpenCodeTestAdapter(transport)
	imageURL, materializer := testRemotePromptImageMaterializer(t)
	adapter.promptImageMaterializer = materializer
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-remote-image"

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "what is in this screenshot?"},
		{Type: "image", MimeType: "image/png", URL: imageURL},
	}, "", "turn-remote-image", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	params := transport.conn.lastPromptParams()
	prompt, _ := params["prompt"].([]any)
	if len(prompt) != 2 {
		t.Fatalf("session/prompt content = %#v, want text+image", params["prompt"])
	}
	image, _ := prompt[1].(map[string]any)
	if image["mimeType"] != "image/png" || image["data"] != "aGk=" {
		t.Fatalf("session/prompt image = %#v, want inline image data", image)
	}
}

func TestStandardACPAdapterRemoteImageFailurePreservesPromptAndClosesProviderTurn(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-remote-image-failure")
	adapter := newOpenCodeTestAdapter(transport)
	materializeErr := errors.New("remote image unavailable")
	adapter.promptImageMaterializer = func(context.Context, []PromptContentBlock) ([]PromptContentBlock, error) {
		return nil, materializeErr
	}
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-remote-image-failure"

	var streamed []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "what is in this screenshot?"},
		{Type: "image", MimeType: "image/png", URL: "https://images.example/screenshot.png"},
	}, "", "turn-remote-image-failure", func(next []activityshared.Event) {
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if params := transport.conn.lastPromptParams(); len(params) != 0 {
		t.Fatalf("session/prompt params = %#v, want no provider request after materialization failure", params)
	}
	messages := eventsOfType(events, activityshared.EventMessageAppended)
	if len(messages) != 1 || messages[0].Payload.Role != activityshared.MessageRoleUser ||
		messages[0].Payload.Content != "what is in this screenshot?" {
		t.Fatalf("user prompt events = %#v, want original prompt preserved", messages)
	}
	if turnStarted := eventsOfType(events, activityshared.EventTurnStarted); len(turnStarted) != 1 {
		t.Fatalf("turn started events = %#v, want one", turnStarted)
	}
	started := eventsOfType(events, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.ProviderTurnID != "turn-remote-image-failure" {
		t.Fatalf("provider turn started events = %#v, want one", started)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.ProviderTurnID != "turn-remote-image-failure" ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) ||
		completed[0].Payload.Metadata["error"] != materializeErr.Error() {
		t.Fatalf("provider turn completed events = %#v, want failed materialization lifecycle", completed)
	}
	if len(streamed) != len(events) {
		t.Fatalf("streamed event count = %d, returned = %d", len(streamed), len(events))
	}
}

func TestStandardACPAdapterRejectsImagePromptWithoutCapability(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "hermes-session-1"

	content := []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     "/managed/agent-prompt-assets/screen.png",
	}}
	if err := adapter.ValidatePromptContent(session, content); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent error = %v, want ErrPromptImageUnsupported", err)
	}
	snapshot := adapter.SessionState(session)
	capabilities := capabilitySnapshotValues(snapshot.Capabilities)
	if containsString(capabilities, CapabilityImageInput) {
		t.Fatalf("runtime promptCapabilities = %#v, want image unsupported", snapshot.RuntimeContext["promptCapabilities"])
	}
}

func TestStandardACPAdapterExecAddsInternalMentionRoutingPromptForGemini(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-mention-routing")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.PermissionModeID = "full-access"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	prompt := "[@User & Codex story](mention://agent-session/session-1?workspaceId=workspace-1&provider=codex) 这里有什么内容？"

	if _, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-mention", func([]activityshared.Event) {}, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	texts := promptTexts(t, transport.conn.lastPromptParamsSnapshot)
	if len(texts) < 2 {
		t.Fatalf("prompt texts = %#v, want user prompt plus internal routing", texts)
	}
	if texts[0] != prompt {
		t.Fatalf("user prompt text = %q, want unmodified prompt %q", texts[0], prompt)
	}
	if texts[len(texts)-1] != tuttiMentionRoutingReminder {
		t.Fatalf("routing prompt = %q, want internal mention routing", texts[len(texts)-1])
	}
}

//nolint:unused // Retain the migrated prompt fixture for focused turn tests.
func firstPromptText(t *testing.T, params map[string]any) string {
	t.Helper()
	texts := promptTexts(t, params)
	if len(texts) == 0 {
		t.Fatalf("prompt params = %#v, want prompt text", params)
	}
	return texts[0]
}

func promptTexts(t *testing.T, params map[string]any) []string {
	t.Helper()
	items, ok := params["prompt"].([]any)
	if !ok || len(items) == 0 {
		t.Fatalf("prompt params = %#v, want prompt items", params)
	}
	texts := make([]string, 0, len(items))
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("prompt item = %#v, want map", item)
		}
		text, ok := block["text"].(string)
		if !ok {
			continue
		}
		texts = append(texts, text)
	}
	return texts
}
