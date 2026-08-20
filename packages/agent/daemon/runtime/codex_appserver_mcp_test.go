package agentruntime

import (
	"reflect"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestAppServerMCPToolCallProjectsResultBody(t *testing.T) {
	content := []any{
		map[string]any{"type": "text", "text": "MCP result"},
	}
	structuredContent := map[string]any{
		"items": []any{map[string]any{"id": "item-1"}},
	}
	update, ok := appServerItemToolCallUpdate(map[string]any{
		"id":        "mcp-1",
		"type":      "mcpToolCall",
		"status":    "completed",
		"server":    "example",
		"tool":      "search",
		"arguments": map[string]any{"query": "tutti"},
		"result": map[string]any{
			"content":           content,
			"structuredContent": structuredContent,
			"isError":           false,
			"_meta":             map[string]any{"provider": "discarded"},
		},
	}, true)
	if !ok {
		t.Fatal("expected MCP item to produce an update")
	}
	if !reflect.DeepEqual(update["content"], content) {
		t.Fatalf("content = %#v, want %#v", update["content"], content)
	}
	output := payloadMap(update, "rawOutput")
	if output["isError"] != false || !reflect.DeepEqual(output["structuredContent"], structuredContent) {
		t.Fatalf("rawOutput = %#v, want canonical MCP result", output)
	}
	if output["result"] != nil || output["_meta"] != nil {
		t.Fatalf("rawOutput retained MCP result envelope: %#v", output)
	}

	session := Session{Provider: "codex", AgentSessionID: "agent-1", RoomID: "room-1"}
	event, ok := acpToolCallEventWithID(session, "event-1", "turn-1", update)
	if !ok || event.Type != activityshared.EventCallCompleted {
		t.Fatalf("event = %#v ok=%v, want completed call", event, ok)
	}
	if event.Payload.Output["stdout"] != "MCP result" ||
		event.Payload.Output["isError"] != false ||
		!reflect.DeepEqual(event.Payload.Output["structuredContent"], structuredContent) {
		t.Fatalf("event output = %#v, want canonical MCP result fields", event.Payload.Output)
	}
}

func TestAppServerMCPToolCallPreservesStructuredErrorResult(t *testing.T) {
	update, ok := appServerItemToolCallUpdate(map[string]any{
		"id":     "mcp-2",
		"type":   "mcpToolCall",
		"status": "completed",
		"result": map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "permission denied"},
			},
			"structuredContent": map[string]any{"code": "permission_denied"},
			"isError":           true,
		},
	}, true)
	if !ok {
		t.Fatal("expected MCP item to produce an update")
	}

	session := Session{Provider: "codex", AgentSessionID: "agent-1", RoomID: "room-1"}
	event, ok := acpToolCallEventWithID(session, "event-2", "turn-1", update)
	if !ok || event.Type != activityshared.EventCallFailed {
		t.Fatalf("event = %#v ok=%v, want failed call", event, ok)
	}
	if event.Payload.Error["isError"] != true ||
		event.Payload.Error["stdout"] != "permission denied" ||
		event.Payload.Output["isError"] != true ||
		event.Payload.Output["structuredContent"] == nil {
		t.Fatalf("failed MCP payload = error:%#v output:%#v", event.Payload.Error, event.Payload.Output)
	}
}

func TestCodexAppServerReducerProjectsMCPStartupStatus(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	statusEvents := make(chan activityshared.Event, 16)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		for _, event := range events {
			statusEvents <- event
		}
	})
	appSession := adapter.getSession(session.AgentSessionID)
	if appSession == nil {
		t.Fatal("missing app-server session")
	}

	newCodexAppServerReducer(adapter).ReduceNotification(
		appSession.client,
		session,
		"",
		acpMessage{
			Method: appServerNotifyMCPServerStartupStatusUpdated,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId":      session.ProviderSessionID,
				"name":          "figma",
				"status":        "failed",
				"failureReason": "reauthenticationRequired",
				"error":         "MCP server requires authentication",
			}),
		},
		nil,
		nil,
	)

	statusFound := false
	warningFound := false
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-statusEvents:
			status, ok := event.Payload.Metadata["mcpServerStartupStatus"].(map[string]any)
			if ok {
				if event.Type != EventSessionUpdated || asString(status["name"]) != "figma" ||
					asString(status["status"]) != "failed" ||
					asString(status["failureReason"]) != "reauthenticationRequired" {
					t.Fatalf("MCP status event = %#v", event)
				}
				statusFound = true
			}
			metadata := event.Payload.Metadata
			if asString(metadata["kind"]) == "agent_system_notice" {
				if event.Type != activityshared.EventSessionAudit || event.Payload.TurnID != "" {
					t.Fatalf("turnless MCP warning event = %#v, want session audit without turnId", event)
				}
				if asString(metadata["noticeKind"]) != "warning" ||
					asString(metadata["severity"]) != "warning" ||
					asString(metadata["detail"]) != "MCP server requires authentication" ||
					asString(metadata["code"]) != "mcp_server_startup_failed" {
					t.Fatalf("MCP warning event = %#v", event)
				}
				warningFound = true
			}
			if statusFound && warningFound {
				return
			}
		case <-deadline:
			t.Fatalf("MCP startup status/warning projection missing: status=%t warning=%t", statusFound, warningFound)
		}
	}
}

func TestCodexAppServerStartupWarningKeepsTurnScopedProjection(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	appSession := adapter.getSession(session.AgentSessionID)
	if appSession == nil {
		t.Fatal("missing app-server session")
	}

	event := codexMCPServerStartupWarningEvent(appSession.client, session, "turn-1", map[string]any{
		"name":          "figma",
		"status":        "failed",
		"failureReason": "reauthenticationRequired",
		"error":         "MCP server requires authentication",
	})
	if event.Type != activityshared.EventMessageAppended || event.Payload.TurnID != "turn-1" {
		t.Fatalf("turn-scoped MCP warning event = %#v, want message on turn-1", event)
	}
}
