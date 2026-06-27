package agentsessionstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestResolveAPIPrefixUsesLocalV1ForLoopbackAndGatewayPrefixForRemote(t *testing.T) {
	t.Parallel()

	if got := resolveAPIPrefix("http://127.0.0.1:9000"); got != "/v1" {
		t.Fatalf("loopback prefix = %q, want /v1", got)
	}
	if got := resolveAPIPrefix("https://control.example.test"); got != "/api/desktop/v1" {
		t.Fatalf("remote prefix = %q, want /api/desktop/v1", got)
	}
	if got := resolveSessionAPIPrefix("http://127.0.0.1:9000"); got != "/v1" {
		t.Fatalf("loopback session prefix = %q, want /v1", got)
	}
	if got := resolveSessionAPIPrefix("https://control.example.test"); got != "/api/desktop/v1" {
		t.Fatalf("remote session prefix = %q, want /api/desktop/v1", got)
	}
}

func TestReportActivityPostsSessionStateEndpoint(t *testing.T) {
	var got reportSessionStateRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/state" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	reply, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID:  "session-1",
			Provider:        "codex",
			LifecycleStatus: "active",
			CurrentPhase:    "idle",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.AcceptedTimelineItemCount != 0 || reply.AcceptedStatePatchCount != 1 {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.RequestBodyBytes <= 0 {
		t.Fatalf("reply request body bytes = %d, want > 0", reply.RequestBodyBytes)
	}
	if got.State.CurrentPhase != "idle" || got.State.LifecycleStatus != "active" {
		t.Fatalf("state request = %#v", got)
	}
}

func TestReportActivityDoesNotPostMessageUpdatesToLegacyActivityEndpoint(t *testing.T) {
	var called atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/agents/activity") {
			called.Store(true)
			t.Fatalf("legacy activity endpoint should not be called for message updates")
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	reply, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		MessageUpdates: []WorkspaceAgentMessageUpdate{{
			AgentSessionID:    "session-1",
			MessageID:         "message-1",
			Seq:               42,
			TurnID:            "turn-1",
			Role:              "assistant",
			Kind:              "tool_call",
			Status:            "completed",
			CallID:            "call-1",
			ParentCallID:      "parent-call-1",
			RootCallID:        "root-call-1",
			Title:             "Read file",
			Payload:           map[string]any{"path": "README.md"},
			OccurredAtUnixMS:  1710000000001,
			StartedAtUnixMS:   1710000000002,
			CompletedAtUnixMS: 1710000000003,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.AcceptedMessageUpdateCount != 1 {
		t.Fatalf("accepted message updates = %d, want 1", reply.AcceptedMessageUpdateCount)
	}
	if reply.RequestBodyBytes <= 0 {
		t.Fatalf("reply request body bytes = %d, want > 0", reply.RequestBodyBytes)
	}
	if called.Load() {
		t.Fatal("legacy activity endpoint was called")
	}
}

func TestReportSessionStatePostsNewEndpoint(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/state" {
			t.Fatalf("request = %s %s", r.Method, r.URL.String())
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"lastEventAtUnixMs":"1710000000004"}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	reply, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Connector:      &ConnectorInfo{ID: "desktopd", Version: "1.2.3"},
		Source: EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			AgentID:           "session-1",
			CWD:               "/workspace",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
		},
		State: WorkspaceAgentSessionStateUpdate{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			Model:             "gpt-5",
			CWD:               "/workspace",
			Title:             "Implement protocol",
			LifecycleStatus:   "active",
			CurrentPhase:      "working",
			OccurredAtUnixMS:  1710000000001,
			StartedAtUnixMS:   1710000000002,
			Turn: &WorkspaceAgentTurnStateUpdate{
				TurnID:            "turn-1",
				Phase:             "working",
				Outcome:           "running",
				FileChanges:       map[string]any{"modified": []any{"README.md"}},
				StartedAtUnixMS:   1710000000002,
				CompletedAtUnixMS: 1710000000003,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reply.Accepted || reply.LastEventAtUnixMS != 1710000000004 {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.RequestBodyBytes <= 0 {
		t.Fatalf("reply request body bytes = %d, want > 0", reply.RequestBodyBytes)
	}
	if got["agentSessionId"] != "session-1" || got["sessionOrigin"] != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("request identity = %#v", got)
	}
	state, ok := got["state"].(map[string]any)
	if !ok {
		t.Fatalf("state = %#v, want object", got["state"])
	}
	if state["title"] != "Implement protocol" || state["currentPhase"] != "working" {
		t.Fatalf("state = %#v", state)
	}
	turn, ok := state["turn"].(map[string]any)
	if !ok || turn["turnId"] != "turn-1" {
		t.Fatalf("turn = %#v", state["turn"])
	}
}

func TestReportSessionMessagesPostsNewEndpointWithoutOldMessageIdentity(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("request = %s %s", r.Method, r.URL.String())
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1,"latestVersion":"7"}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	reply, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID:         "message-1",
			TurnID:            "turn-1",
			Role:              "assistant",
			Kind:              "tool_call",
			Status:            "completed",
			Payload:           map[string]any{"path": "README.md"},
			OccurredAtUnixMS:  1710000000001,
			StartedAtUnixMS:   1710000000002,
			CompletedAtUnixMS: 1710000000003,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.AcceptedCount != 1 || reply.LatestVersion != 7 {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.RequestBodyBytes <= 0 {
		t.Fatalf("reply request body bytes = %d, want > 0", reply.RequestBodyBytes)
	}
	if _, ok := got["agentSessionId"]; ok {
		t.Fatalf("request body should not carry top-level agentSessionId field: %#v", got)
	}
	updates, ok := got["updates"].([]any)
	if !ok || len(updates) != 1 {
		t.Fatalf("updates = %#v, want one", got["updates"])
	}
	update, ok := updates[0].(map[string]any)
	if !ok {
		t.Fatalf("update = %#v, want object", updates[0])
	}
	if _, ok := update["agentSessionId"]; ok {
		t.Fatalf("message update should not carry old agentSessionId field: %#v", update)
	}
	if _, ok := update["seq"]; ok {
		t.Fatalf("message update should not carry old seq field: %#v", update)
	}
	if update["messageId"] != "message-1" || update["kind"] != "tool_call" {
		t.Fatalf("update = %#v", update)
	}
}

func TestReportSessionMessagesSanitizesLargeToolPayloadsBeforeUpload(t *testing.T) {
	t.Parallel()

	rawImageData := strings.Repeat("A", 128*1024)
	rawText := strings.Repeat("z", maxUpstreamToolPayloadStringBytes+256)

	var rawBody []byte
	var got reportSessionMessagesRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var err error
		rawBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(rawBody, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"input": map[string]any{
					"type":     "image",
					"mimeType": "image/png",
					"uri":      "/tmp/generated.png",
					"data":     rawImageData,
				},
				"output": map[string]any{"stdout": rawText},
			},
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if len(rawBody) >= len(rawImageData) {
		t.Fatalf("request body size = %d, want sanitization to shrink below raw image data size %d", len(rawBody), len(rawImageData))
	}
	if strings.Contains(string(rawBody), rawImageData) {
		t.Fatal("request body still contains raw image data")
	}

	if len(got.Updates) != 1 {
		t.Fatalf("updates = %#v, want one", got.Updates)
	}
	inputPayload, _ := got.Updates[0].Payload["input"].(map[string]any)
	entityImageData, _ := inputPayload["data"].(string)
	if !strings.Contains(entityImageData, "[omitted image/png bytes;") {
		t.Fatalf("entity image payload = %q", entityImageData)
	}
	outputPayload, _ := got.Updates[0].Payload["output"].(map[string]any)
	entityStdout, _ := outputPayload["stdout"].(string)
	if !strings.Contains(entityStdout, "...[truncated ") {
		t.Fatalf("entity stdout payload = %q", entityStdout)
	}
}

func TestReportSessionMessagesPreservesLargeTextPayloadsBeforeUpload(t *testing.T) {
	t.Parallel()

	rawText := strings.Repeat("x", 260*1024)
	rawMetadataText := strings.Repeat("z", maxUpstreamToolPayloadStringBytes+256)
	var got reportSessionMessagesRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
			Payload: map[string]any{
				"source":   "runtime",
				"content":  rawText,
				"text":     rawText,
				"metadata": map[string]any{"stdout": rawMetadataText},
			},
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if len(got.Updates) != 1 {
		t.Fatalf("updates = %#v, want one", got.Updates)
	}
	content, _ := got.Updates[0].Payload["content"].(string)
	text, _ := got.Updates[0].Payload["text"].(string)
	if content != rawText || text != rawText {
		t.Fatalf(
			"text payload lengths content=%d text=%d, want %d",
			len(content),
			len(text),
			len(rawText),
		)
	}
	if _, ok := got.Updates[0].Payload["truncatedPayloadBytes"]; ok {
		t.Fatalf("payload = %#v, did not expect text payload compaction", got.Updates[0].Payload)
	}
	metadata, _ := got.Updates[0].Payload["metadata"].(map[string]any)
	stdout, _ := metadata["stdout"].(string)
	if !strings.Contains(stdout, "...[truncated ") {
		t.Fatalf("metadata stdout payload = %q, want diagnostic truncation", stdout)
	}
}

func TestReportSessionMessagesCapsSinglePayloadToServerLimit(t *testing.T) {
	t.Parallel()

	const serverMessagePayloadLimitBytes = 256 * 1024

	rawText := strings.Repeat("x", 96*1024)
	var got reportSessionMessagesRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"callId":   "call-1",
				"toolName": "exec_command",
				"name":     "exec_command",
				"input":    map[string]any{"stdout": rawText},
				"output":   map[string]any{"stdout": rawText},
				"error":    map[string]any{"stderr": rawText},
				"metadata": map[string]any{"stdout": rawText},
				"content":  []any{map[string]any{"text": rawText}},
			},
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if len(got.Updates) != 1 {
		t.Fatalf("updates = %#v, want one", got.Updates)
	}
	payloadBody, err := json.Marshal(got.Updates[0].Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(payloadBody) > serverMessagePayloadLimitBytes {
		t.Fatalf("payload bytes = %d, want <= %d", len(payloadBody), serverMessagePayloadLimitBytes)
	}
	if len(payloadBody) <= 64*1024 {
		t.Fatalf("payload bytes = %d, want above legacy 64KiB server limit", len(payloadBody))
	}
	if got.Updates[0].Payload["callId"] != "call-1" || got.Updates[0].Payload["toolName"] != "exec_command" {
		t.Fatalf("payload identity fields = %#v", got.Updates[0].Payload)
	}
	if _, ok := got.Updates[0].Payload["truncatedPayloadBytes"]; ok {
		t.Fatalf("payload = %#v, did not expect compaction under raised server limit", got.Updates[0].Payload)
	}
}

func TestReportSessionMessagesCompactsPayloadAboveClientLimit(t *testing.T) {
	t.Parallel()

	const serverMessagePayloadLimitBytes = 256 * 1024

	largePayload := map[string]any{
		"callId":   "call-1",
		"toolName": "exec_command",
	}
	for i := 0; i < 24; i++ {
		largePayload[fmt.Sprintf("field%d", i)] = strings.Repeat("x", 96*1024)
	}
	var got reportSessionMessagesRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"acceptedCount":1}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	_, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload:   largePayload,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if len(got.Updates) != 1 {
		t.Fatalf("updates = %#v, want one", got.Updates)
	}
	payloadBody, err := json.Marshal(got.Updates[0].Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(payloadBody) > serverMessagePayloadLimitBytes {
		t.Fatalf("payload bytes = %d, want <= %d", len(payloadBody), serverMessagePayloadLimitBytes)
	}
	if got.Updates[0].Payload["callId"] != "call-1" || got.Updates[0].Payload["toolName"] != "exec_command" {
		t.Fatalf("payload identity fields = %#v", got.Updates[0].Payload)
	}
	if _, ok := got.Updates[0].Payload["truncatedPayloadBytes"]; !ok {
		t.Fatalf("payload = %#v, want compaction metadata", got.Updates[0].Payload)
	}
}

func TestReportSessionMessagesSplitsOversizedRequestsIntoMultipleUploads(t *testing.T) {
	t.Parallel()

	const gatewayBodyLimitBytes = 1 << 20

	rawText := strings.Repeat("x", maxUpstreamToolPayloadStringBytes+512)
	var requestCount int
	var acceptedMessageCount int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if len(body) > gatewayBodyLimitBytes {
			http.Error(w, "too large", http.StatusRequestEntityTooLarge)
			return
		}
		var got reportSessionMessagesRequest
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		requestCount++
		acceptedMessageCount += len(got.Updates)
		_, _ = w.Write([]byte(`{"acceptedCount":` + strconv.Itoa(len(got.Updates)) + `}`))
	}))
	defer server.Close()

	updates := make([]WorkspaceAgentSessionMessageUpdate, 0, 80)
	for i := 0; i < 80; i++ {
		updates = append(updates, WorkspaceAgentSessionMessageUpdate{
			MessageID: "message-" + strconv.Itoa(i),
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"input":  map[string]any{"stdout": rawText},
				"output": map[string]any{"stdout": rawText},
			},
		})
	}

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1", HTTPClient: server.Client()})
	reply, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates:        updates,
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if requestCount < 2 {
		t.Fatalf("requestCount = %d, want multiple uploads", requestCount)
	}
	if acceptedMessageCount != len(updates) {
		t.Fatalf("accepted messages = %d, want %d", acceptedMessageCount, len(updates))
	}
	if reply.AcceptedCount != len(updates) {
		t.Fatalf("reply = %#v, want full accepted counts", reply)
	}
}

func TestListSessionMessagesUsesAfterVersion(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("request = %s %s", r.Method, r.URL.String())
		}
		if got := r.URL.Query().Get("after_version"); got != "9" {
			t.Fatalf("after_version = %q, want 9", got)
		}
		if got := r.URL.Query().Get("limit"); got != "20" {
			t.Fatalf("limit = %q, want 20", got)
		}
		if got := r.URL.Query().Get("session_origin"); got != WorkspaceAgentSessionOriginRuntime {
			t.Fatalf("session_origin = %q, want runtime enum", got)
		}
		_, _ = w.Write([]byte(`{
			"messages":[{
				"id":"11",
				"agentSessionId":"session-1",
				"messageId":"message-1",
				"turnId":"turn-1",
				"role":"assistant",
				"kind":"text",
				"status":"completed",
				"payload":{"text":"hello"},
				"occurredAtUnixMs":"1710000000001",
				"startedAtUnixMs":"1710000000002",
				"completedAtUnixMs":"1710000000003",
				"createdAtUnixMs":"1710000000004",
				"updatedAtUnixMs":"1710000000005",
				"version":"10"
			}],
			"latestVersion":"10",
			"hasMore":true
		}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	reply, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    " ws-1 ",
		AgentSessionID: " session-1 ",
		AfterVersion:   9,
		Limit:          20,
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.LatestVersion != 10 || !reply.HasMore {
		t.Fatalf("reply = %#v", reply)
	}
	if len(reply.Messages) != 1 {
		t.Fatalf("messages = %#v, want one", reply.Messages)
	}
	message := reply.Messages[0]
	if message.ID != 11 || message.Version != 10 || message.MessageID != "message-1" {
		t.Fatalf("message identity = %#v", message)
	}
	if message.OccurredAtUnixMS != 1710000000001 ||
		message.StartedAtUnixMS != 1710000000002 ||
		message.CompletedAtUnixMS != 1710000000003 ||
		message.CreatedAtUnixMS != 1710000000004 ||
		message.UpdatedAtUnixMS != 1710000000005 {
		t.Fatalf("message timestamps = %#v", message)
	}
}

func TestListSessionMessagesDecodesSnakeCaseResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/rooms/ws-1/agents/sessions/session-1/messages" {
			t.Fatalf("request = %s %s", r.Method, r.URL.String())
		}
		_, _ = w.Write([]byte(`{
			"messages":[{
				"id":"12",
				"agent_session_id":"session-1",
				"message_id":"message-2",
				"turn_id":"turn-2",
				"role":"assistant",
				"kind":"text",
				"status":"completed",
				"payload":{"text":"hello"},
				"occurred_at_unix_ms":"1710000000001",
				"started_at_unix_ms":"1710000000002",
				"completed_at_unix_ms":"1710000000003",
				"created_at_unix_ms":"1710000000004",
				"updated_at_unix_ms":"1710000000005",
				"version":"11"
			}],
			"latest_version":"11",
			"has_more":true
		}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	reply, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.LatestVersion != 11 || !reply.HasMore {
		t.Fatalf("reply = %#v", reply)
	}
	if len(reply.Messages) != 1 {
		t.Fatalf("messages = %#v, want one", reply.Messages)
	}
	message := reply.Messages[0]
	if message.ID != 12 ||
		message.AgentSessionID != "session-1" ||
		message.MessageID != "message-2" ||
		message.TurnID != "turn-2" ||
		message.Version != 11 {
		t.Fatalf("message identity = %#v", message)
	}
	if message.OccurredAtUnixMS != 1710000000001 ||
		message.StartedAtUnixMS != 1710000000002 ||
		message.CompletedAtUnixMS != 1710000000003 ||
		message.CreatedAtUnixMS != 1710000000004 ||
		message.UpdatedAtUnixMS != 1710000000005 {
		t.Fatalf("message timestamps = %#v", message)
	}
}

func TestListSessionMessagesValidatesPathFieldsBeforeRequest(t *testing.T) {
	t.Parallel()

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if _, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "   ",
		AgentSessionID: "session-1",
	}); err == nil {
		t.Fatal("ListSessionMessages() error = nil, want workspace id validation error")
	}
	if _, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "   ",
	}); err == nil {
		t.Fatal("ListSessionMessages() error = nil, want agent session id validation error")
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want 0", requests)
	}
}

func TestReportActivityUsesResolvedRemoteAPIPrefix(t *testing.T) {
	t.Parallel()

	paths := make([]string, 0, 2)
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			paths = append(paths, req.URL.Path)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"acceptedTimelineItemCount":1,"acceptedStatePatchCount":1}`)),
				Request:    req,
			}, nil
		})},
	})

	if _, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			CurrentPhase:   "idle",
		}},
	}); err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if _, err := client.ReportActivityJSON(
		context.Background(),
		"ws-1",
		json.RawMessage(`{"statePatches":[{"agentSessionId":"session-1","currentPhase":"idle"}]}`),
	); err != nil {
		t.Fatalf("ReportActivityJSON() error = %v", err)
	}

	want := "/api/desktop/v1/rooms/ws-1/agents/sessions/session-1/state"
	if len(paths) != 2 || paths[0] != want || paths[1] != want {
		t.Fatalf("paths = %#v, want both %q", paths, want)
	}
}

func TestSessionUpdateMethodsUseRemoteDesktopPrefix(t *testing.T) {
	t.Parallel()

	paths := make([]string, 0, 3)
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			paths = append(paths, req.URL.Path)
			body := `{"accepted":true}`
			if strings.HasSuffix(req.URL.Path, "/messages") {
				body = `{"acceptedCount":1,"latestVersion":"1","messages":[]}`
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    req,
			}, nil
		})},
	})

	if _, err := client.ReportSessionState(context.Background(), ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: WorkspaceAgentSessionStateUpdate{
			CurrentPhase: "idle",
		},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if _, err := client.ReportSessionMessages(context.Background(), ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if _, err := client.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Limit:          20,
	}); err != nil {
		t.Fatalf("ListSessionMessages() error = %v", err)
	}

	want := "/api/desktop/v1/rooms/ws-1/agents/sessions/session-1"
	wantPaths := []string{want + "/state", want + "/messages", want + "/messages"}
	if len(paths) != len(wantPaths) {
		t.Fatalf("paths = %#v, want %#v", paths, wantPaths)
	}
	for index := range wantPaths {
		if paths[index] != wantPaths[index] {
			t.Fatalf("paths = %#v, want %#v", paths, wantPaths)
		}
	}
}

func TestReportActivityRetriesTransientRemoteEOFUpToThirdAttempt(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if got := req.URL.Path; got != "/api/desktop/v1/rooms/ws-1/agents/sessions/session-1/state" {
				t.Fatalf("path = %q", got)
			}
			if attempts.Add(1) < 3 {
				return nil, io.EOF
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"accepted":true}`)),
				Request:    req,
			}, nil
		})},
	})

	reply, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			CurrentPhase:   "idle",
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", attempts.Load())
	}
	if reply.AcceptedTimelineItemCount != 0 || reply.AcceptedStatePatchCount != 1 {
		t.Fatalf("reply = %#v", reply)
	}
}

func TestReportActivityStopsAfterThirdTransientRemoteEOF(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			attempts.Add(1)
			return nil, io.EOF
		})},
	})

	_, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			CurrentPhase:   "idle",
		}},
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("ReportActivity() error = %v, want EOF", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", attempts.Load())
	}
}

func TestReportActivityRetriesTransientRemoteTLSHandshakeTimeout(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempt := attempts.Add(1)
			if attempt == 1 {
				return nil, errors.New("net/http: TLS handshake timeout")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"acceptedCount":1}`)),
				Request:    req,
			}, nil
		})},
	})

	_, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		MessageUpdates: []WorkspaceAgentMessageUpdate{{
			AgentSessionID: "session-1",
			MessageID:      "message-1",
			TurnID:         "turn-1",
			Role:           "assistant",
			Kind:           "text",
			Payload:        map[string]any{"text": "hello"},
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	if attempts.Load() != 2 {
		t.Fatalf("attempts = %d, want 2", attempts.Load())
	}
}

func TestReportActivityDoesNotRetryPermanentRemoteHTTPError(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempts.Add(1)
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"error":"bad request"}`)),
				Request:    req,
			}, nil
		})},
	})

	_, err := client.ReportActivity(context.Background(), ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			CurrentPhase:   "idle",
		}},
	})
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("ReportActivity() error = %T %v, want HTTPError", err, err)
	}
	bodyBytes, ok := RequestBodyBytesFromError(err)
	if !ok || bodyBytes <= 0 {
		t.Fatalf("RequestBodyBytesFromError(%v) = (%d, %v), want (>0, true)", err, bodyBytes, ok)
	}
	if attempts.Load() != 1 {
		t.Fatalf("attempts = %d, want 1", attempts.Load())
	}
}

func TestListAgentsWithFilterRetriesTransientRemoteEOFUpToThirdAttempt(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "https://control.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if got := req.URL.Path; got != "/api/desktop/v1/rooms/ws-1/agents/list" {
				t.Fatalf("path = %q", got)
			}
			if attempts.Add(1) < 3 {
				return nil, io.EOF
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"presences":[],"sessions":[]}`)),
				Request:    req,
			}, nil
		})},
	})

	if _, err := client.ListAgentsWithFilter(context.Background(), ListAgentsInput{
		WorkspaceID: "ws-1",
	}); err != nil {
		t.Fatalf("ListAgentsWithFilter() error = %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", attempts.Load())
	}
}

func TestListAgentsWithFilterDoesNotRetryTransientEOFAgainstLoopback(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	client := NewClient(Config{
		BaseURL: "http://127.0.0.1:9999",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			attempts.Add(1)
			return nil, io.EOF
		})},
	})

	_, err := client.ListAgentsWithFilter(context.Background(), ListAgentsInput{
		WorkspaceID: "ws-1",
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("ListAgentsWithFilter() error = %v, want EOF", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("attempts = %d, want 1", attempts.Load())
	}
}

func TestClientProxiesWorkspaceAgentEndpoints(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/rooms/ws-1/agents/list":
			_, _ = w.Write([]byte(`{
				"presences":[{"id":1,"roomId":"ws-1","userId":"user-1","provider":"codex","status":"working"}],
				"sessions":[{"id":2,"agentId":"agent-session-1","presenceId":1,"providerSessionId":"raw-session","cwd":"/workspace/ws-1","effectiveStatus":"working"}]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1"})

	agents, err := client.ListAgents(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("ListAgents() error = %v", err)
	}
	if len(agents.Presences) != 1 || agents.Presences[0].UserID != "user-1" {
		t.Fatalf("presences = %#v", agents.Presences)
	}
	if len(agents.Sessions) != 1 || agents.Sessions[0].AgentSessionID != "agent-session-1" {
		t.Fatalf("sessions = %#v", agents.Sessions)
	}
	if agents.Sessions[0].EffectiveStatus != "working" {
		t.Fatalf("session effective status = %q", agents.Sessions[0].EffectiveStatus)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestClientProxiesRuntimeOriginWorkspaceAgentEndpoints(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/rooms/ws-1/agents/list":
			if r.URL.Query().Get("session_origin") != WorkspaceAgentSessionOriginRuntime {
				t.Fatalf("session_origin = %q", r.URL.Query().Get("session_origin"))
			}
			_, _ = w.Write([]byte(`{"presences":[],"sessions":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1"})
	if _, err := client.ListAgentsWithOrigin(context.Background(), "ws-1", WorkspaceAgentSessionOriginRuntime); err != nil {
		t.Fatalf("ListAgentsWithOrigin() error = %v", err)
	}
}

func TestClientProxiesWorkspaceAgentFilterAndDelete(t *testing.T) {
	t.Parallel()

	var sawList atomic.Bool
	var sawDelete atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/rooms/ws-1/agents/list":
			sawList.Store(true)
			if got := r.URL.Query().Get("user_id"); got != "user-1" {
				t.Fatalf("user_id = %q", got)
			}
			if got := r.URL.Query().Get("session_origin"); got != WorkspaceAgentSessionOriginRuntime {
				t.Fatalf("session_origin = %q", got)
			}
			_, _ = w.Write([]byte(`{"presences":[],"sessions":[]}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/rooms/ws-1/agents/agent-session-1":
			sawDelete.Store(true)
			if got := r.URL.Query().Get("session_origin"); got != WorkspaceAgentSessionOriginRuntime {
				t.Fatalf("session_origin = %q", got)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1"})
	if _, err := client.ListAgentsWithFilter(context.Background(), ListAgentsInput{
		WorkspaceID:   "ws-1",
		SessionOrigin: WorkspaceAgentSessionOriginRuntime,
		UserID:        "user-1",
	}); err != nil {
		t.Fatalf("ListAgentsWithFilter() error = %v", err)
	}
	if err := client.DeleteAgentSession(context.Background(), DeleteAgentSessionInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "agent-session-1",
		SessionOrigin:  WorkspaceAgentSessionOriginRuntime,
	}); err != nil {
		t.Fatalf("DeleteAgentSession() error = %v", err)
	}
	if !sawList.Load() || !sawDelete.Load() {
		t.Fatalf("saw list/delete = %v/%v", sawList.Load(), sawDelete.Load())
	}
}

func TestClientDecodesProtoJSONIntegerStrings(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/rooms/ws-1/agents/list":
			_, _ = w.Write([]byte(`{
				"presences":[{"id":"1","roomId":"ws-1","userId":"user-1","provider":"codex","status":"working","lastHeartbeatUnixMs":"1710000000100","leaseExpiresUnixMs":"1710000060100","createdAtUnixMs":"1710000000000","updatedAtUnixMs":"1710000000200"}],
				"sessions":[{"id":"2","agentSessionId":"agent-session-1","presenceId":"1","providerSessionId":"raw-session","cwd":"/workspace/ws-1","effectiveStatus":"working","createdAtUnixMs":"1710000001000","updatedAtUnixMs":"1710000002000"}]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, UserID: "user-1"})
	agents, err := client.ListAgents(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("ListAgents() error = %v", err)
	}
	if agents.Presences[0].ID != 1 || agents.Sessions[0].ID != 2 || agents.Sessions[0].PresenceID != 1 {
		t.Fatalf("decoded agents = %#v", agents)
	}
	if agents.Presences[0].LastHeartbeatUnixMS != 1710000000100 ||
		agents.Presences[0].LeaseExpiresUnixMS != 1710000060100 ||
		agents.Presences[0].CreatedAtUnixMS != 1710000000000 ||
		agents.Presences[0].UpdatedAtUnixMS != 1710000000200 {
		t.Fatalf("decoded presence timestamps = %#v", agents.Presences[0])
	}
	if agents.Sessions[0].EffectiveStatus != "working" {
		t.Fatalf("decoded session effective status = %q", agents.Sessions[0].EffectiveStatus)
	}
}

func TestWorkspaceAgentSessionUnmarshalContextBackedSession(t *testing.T) {
	t.Parallel()

	var snapshot WorkspaceAgentSnapshot
	if err := json.Unmarshal([]byte(`{
		"sessions": [{
			"agentId": "agent-session-1",
			"provider": "codex",
			"userId": "user-1",
			"providerSessionId": "codex-session-1",
			"sessionOrigin": "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
			"cwd": "/workspace",
			"title": "Implement feature",
			"turnPhase": "started",
			"effectiveStatus": "working",
			"startedAtUnixMs": "1710000000000",
			"createdAtUnixMs": "1710000001000",
			"updatedAtUnixMs": "1710000002000"
		}]
	}`), &snapshot); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if len(snapshot.Sessions) != 1 {
		t.Fatalf("sessions = %#v", snapshot.Sessions)
	}
	session := snapshot.Sessions[0]
	if got := session.AgentSessionID; got != "agent-session-1" {
		t.Fatalf("AgentSessionID = %q", got)
	}
	if got := session.Provider; got != "codex" {
		t.Fatalf("Provider = %q", got)
	}
	if got := session.SessionOrigin; got != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("SessionOrigin = %q", got)
	}
	if got := session.UserID; got != "user-1" {
		t.Fatalf("UserID = %q", got)
	}
	if got := session.StartedAtUnixMS; got != 1710000000000 {
		t.Fatalf("StartedAtUnixMS = %d", got)
	}
	if got := session.CreatedAtUnixMS; got != 1710000001000 {
		t.Fatalf("CreatedAtUnixMS = %d", got)
	}
	if got := session.UpdatedAtUnixMS; got != 1710000002000 {
		t.Fatalf("UpdatedAtUnixMS = %d", got)
	}
}

func TestWorkspaceAgentSessionUnmarshalProtoSessionStatusFallback(t *testing.T) {
	t.Parallel()

	var snapshot WorkspaceAgentSnapshot
	if err := json.Unmarshal([]byte(`{
		"sessions": [{
			"agent_id": "agent-session-1",
			"provider": "claude-code",
			"user_id": "user-1",
			"provider_session_id": "provider-session-1",
			"session_origin": "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
			"cwd": "/workspace",
			"title": "Look around",
			"status": "working",
			"started_at_unix_ms": "1710000000000",
			"created_at_unix_ms": "1710000001000",
			"updated_at_unix_ms": "1710000002000"
		}]
	}`), &snapshot); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if len(snapshot.Sessions) != 1 {
		t.Fatalf("sessions = %#v", snapshot.Sessions)
	}
	session := snapshot.Sessions[0]
	if got := session.AgentSessionID; got != "agent-session-1" {
		t.Fatalf("AgentSessionID = %q", got)
	}
	if got := session.ProviderSessionID; got != "provider-session-1" {
		t.Fatalf("ProviderSessionID = %q", got)
	}
	if got := session.SessionOrigin; got != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("SessionOrigin = %q", got)
	}
	if got := session.Status; got != "working" {
		t.Fatalf("Status = %q", got)
	}
	if got := session.EffectiveStatus; got != "working" {
		t.Fatalf("EffectiveStatus = %q", got)
	}
	if got := session.StartedAtUnixMS; got != 1710000000000 {
		t.Fatalf("StartedAtUnixMS = %d", got)
	}
	if got := session.CreatedAtUnixMS; got != 1710000001000 {
		t.Fatalf("CreatedAtUnixMS = %d", got)
	}
	if got := session.UpdatedAtUnixMS; got != 1710000002000 {
		t.Fatalf("UpdatedAtUnixMS = %d", got)
	}
}
