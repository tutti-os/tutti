package agentruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestCursorAskUserQuestionMCPBlocksUntilInteractiveAnswer(t *testing.T) {
	t.Parallel()

	adapter := newCursorAdapterWithHostMetadata(nil, LegacyHostMetadata(), nil)
	bridge, ok := adapter.config.localToolBridge.(*cursorACPQuestionMCPBridge)
	if !ok || bridge == nil {
		t.Fatal("Cursor local tool bridge is unavailable")
	}
	session := standardTestSession(ProviderCursor)
	adapter.storeSession(session.AgentSessionID, &standardACPSession{
		providerSessionID: "cursor-session-question-mcp",
		pendingApprovals:  make(map[string]*pendingACPApproval),
	})
	binding, release, err := bridge.Bind(context.Background(), session)
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	defer release()

	requested := make(chan string, 1)
	var emitted []activityshared.Event
	deactivate := bridge.ActivateTurn(session, "turn-question-mcp", func(events []activityshared.Event) {
		emitted = append(emitted, events...)
		for _, event := range events {
			if event.Type == activityshared.EventInteractionRequested && event.Payload.Interaction != nil {
				select {
				case requested <- event.Payload.Interaction.RequestID:
				default:
				}
			}
		}
	})
	defer deactivate()

	client := &http.Client{Timeout: 5 * time.Second}
	initialize := cursorQuestionMCPCall(t, client, binding, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "cursor-agent", "version": "test"},
		},
	})
	if result := payloadMap(initialize, "result"); result["protocolVersion"] != cursorACPQuestionMCPVersion {
		t.Fatalf("initialize response = %#v", initialize)
	}
	unauthorizedBinding := binding
	unauthorizedBinding.Headers = map[string]string{"Authorization": "Bearer wrong-session-token"}
	unauthorized := cursorQuestionMCPCall(t, client, unauthorizedBinding, map[string]any{
		"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": map[string]any{},
	})
	if rpcError := payloadMap(unauthorized, "error"); rpcError["code"] != float64(-32001) {
		t.Fatalf("unauthorized response = %#v", unauthorized)
	}
	listed := cursorQuestionMCPCall(t, client, binding, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	tools, _ := payloadMap(listed, "result")["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools/list response = %#v", listed)
	}
	tool, _ := tools[0].(map[string]any)
	if asString(tool["name"]) != cursorACPQuestionMCPToolName {
		t.Fatalf("tools/list response = %#v", listed)
	}

	callDone := make(chan map[string]any, 1)
	go func() {
		callDone <- cursorQuestionMCPCall(t, client, binding, map[string]any{
			"jsonrpc": "2.0", "id": 3, "method": "tools/call",
			"params": map[string]any{
				"name": cursorACPQuestionMCPToolName,
				"arguments": map[string]any{
					"title": "Confirmation",
					"questions": []any{map[string]any{
						"id": "continue", "question": "Continue?",
						"options": []any{
							map[string]any{"id": "yes", "label": "Yes"},
							map[string]any{"id": "no", "label": "No"},
						},
					}},
				},
			},
		})
	}()

	var requestID string
	select {
	case requestID = <-requested:
	case <-time.After(5 * time.Second):
		t.Fatal("AskUserQuestion did not publish an interaction")
	}
	snapshot := adapter.SessionState(session)
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.RequestID != requestID ||
		snapshot.PendingInteractive.ToolName != cursorACPQuestionMCPToolName {
		t.Fatalf("pending interaction = %#v", snapshot.PendingInteractive)
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RoomID: session.RoomID, AgentSessionID: session.AgentSessionID,
		TurnID: "turn-question-mcp", RequestID: requestID, Action: "submit",
		Payload: map[string]any{
			"answers": []any{"Yes"}, "answersByQuestionId": map[string]any{"continue": "Yes"},
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}

	var response map[string]any
	select {
	case response = <-callDone:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP tools/call did not resume after the answer")
	}
	content, _ := payloadMap(response, "result")["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("tools/call response = %#v", response)
	}
	contentBlock, _ := content[0].(map[string]any)
	if !strings.Contains(asString(contentBlock["text"]), `"continue":"Yes"`) {
		t.Fatalf("tools/call response = %#v", response)
	}
	if disposition := adapter.InteractiveDisposition(session, "turn-question-mcp", requestID); disposition != InteractiveDispositionAnswered {
		t.Fatalf("interactive disposition = %q, want answered", disposition)
	}
	if len(eventsOfType(emitted, activityshared.EventInteractionRequested)) != 1 ||
		len(eventsOfType(emitted, activityshared.EventCallCompleted)) != 1 {
		t.Fatalf("interaction events = %#v", emitted)
	}
}

func TestCursorAskUserQuestionMCPPermissionDecisionIsNarrow(t *testing.T) {
	t.Parallel()

	for _, matching := range []json.RawMessage{
		json.RawMessage(`{"toolCall":{"title":"tutti-interaction: AskUserQuestion","kind":"other"}}`),
		json.RawMessage(`{"toolCall":{"title":"tutti-interaction-AskUserQuestion: AskUserQuestion","kind":"other"}}`),
	} {
		if got := cursorACPQuestionMCPPermissionDecision(matching); got != "approved" {
			t.Fatalf("matching decision for %s = %q, want approved", matching, got)
		}
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"toolCall":{"title":"other: AskUserQuestion","kind":"other"}}`),
		json.RawMessage(`{"toolCall":{"title":"tutti-interaction: AskUserQuestion","kind":"execute"}}`),
		json.RawMessage(`{"toolCall":{"title":"tutti-interaction: Shell","kind":"other"}}`),
		json.RawMessage(`{}`),
	} {
		if got := cursorACPQuestionMCPPermissionDecision(raw); got != "" {
			t.Fatalf("decision for %s = %q, want prompt", raw, got)
		}
	}
}

func cursorQuestionMCPCall(t *testing.T, client *http.Client, binding MCPServerBinding, payload map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, binding.URL, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for name, value := range binding.Headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Errorf("MCP request: %v", err)
		return nil
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Errorf("read MCP response: %v", err)
		return nil
	}
	var decoded map[string]any
	if json.Unmarshal(body, &decoded) != nil {
		t.Errorf("decode MCP response status=%d body=%q", response.StatusCode, body)
	}
	return decoded
}
