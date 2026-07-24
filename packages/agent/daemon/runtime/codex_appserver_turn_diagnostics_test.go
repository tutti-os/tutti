package agentruntime

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type codexAppServerDiagnosticRecord struct {
	event  string
	fields map[string]any
}

type codexAppServerDiagnosticSink struct {
	records []codexAppServerDiagnosticRecord
}

func (s *codexAppServerDiagnosticSink) Log(event string, fields map[string]any) {
	s.records = append(s.records, codexAppServerDiagnosticRecord{event: event, fields: fields})
}

func TestCodexAppServerTurnDiagnosticsRecordsBoundedToolLifecycle(t *testing.T) {
	startedAt := time.Date(2026, 7, 24, 7, 0, 0, 0, time.UTC)
	now := startedAt
	sink := &codexAppServerDiagnosticSink{}
	diagnostics := newCodexAppServerTurnDiagnostics(sink, "turn-1")
	diagnostics.startedAt = startedAt
	diagnostics.now = func() time.Time { return now }

	now = startedAt.Add(time.Second)
	command := map[string]any{
		"id":      "command-1",
		"type":    "commandExecution",
		"command": "curl https://secret.example/?token=do-not-log",
		"cwd":     "/secret/workspace",
		"status":  "inProgress",
	}
	diagnostics.ObserveNotification(appServerNotifyItemStarted, map[string]any{"item": command})
	diagnostics.ObserveNotification(appServerNotifyItemStarted, map[string]any{"item": command})

	now = startedAt.Add(3250 * time.Millisecond)
	command["status"] = "completed"
	command["exitCode"] = 7
	command["aggregatedOutput"] = "secret command output"
	diagnostics.ObserveNotification(appServerNotifyItemCompleted, map[string]any{"item": command})
	diagnostics.ObserveNotification(appServerNotifyItemCompleted, map[string]any{"item": command})

	now = startedAt.Add(4 * time.Second)
	diagnostics.ObserveNotification(appServerNotifyItemStarted, map[string]any{
		"item": map[string]any{
			"id":        "mcp-1",
			"type":      "mcpToolCall",
			"server":    "documents",
			"tool":      "search",
			"arguments": map[string]any{"query": "secret query"},
		},
	})
	diagnostics.ObserveNotification(appServerNotifyAgentMessageDelta, map[string]any{
		"delta": "secret assistant content",
	})

	now = startedAt.Add(10 * time.Second)
	diagnostics.Finish("completed", "provider-turn-1")
	diagnostics.Finish("failed", "provider-turn-1")

	if got, want := len(sink.records), 4; got != want {
		t.Fatalf("record count = %d, want %d: %#v", got, want, sink.records)
	}
	wantEvents := []string{
		"turn.tool.started",
		"turn.tool.completed",
		"turn.tool.started",
		"turn.completed",
	}
	for index, want := range wantEvents {
		if got := sink.records[index].event; got != want {
			t.Fatalf("record[%d].event = %q, want %q", index, got, want)
		}
	}

	completed := sink.records[1].fields
	if got := completed["duration_ms"]; got != int64(2250) {
		t.Fatalf("command duration_ms = %#v, want 2250", got)
	}
	if got := completed["outcome"]; got != "failed" {
		t.Fatalf("command outcome = %#v, want failed", got)
	}
	if got := completed["exit_code"]; got != 7 {
		t.Fatalf("command exit_code = %#v, want 7", got)
	}

	summary := sink.records[3].fields
	for key, want := range map[string]any{
		"duration_ms":            int64(10000),
		"tool_started_count":     2,
		"tool_completed_count":   1,
		"tool_failed_count":      1,
		"open_tool_count":        1,
		"max_tool_duration_ms":   int64(2250),
		"max_tool_item_type":     "commandExecution",
		"longest_open_tool_ms":   int64(6000),
		"longest_open_item_type": "mcpToolCall",
		"provider_turn_id":       "provider-turn-1",
		"turn_id":                "turn-1",
		"outcome":                "completed",
	} {
		if got := summary[key]; got != want {
			t.Fatalf("summary[%q] = %#v, want %#v", key, got, want)
		}
	}

	serializedRecords := make([]map[string]any, 0, len(sink.records))
	for _, record := range sink.records {
		serializedRecords = append(serializedRecords, map[string]any{
			"event":  record.event,
			"fields": record.fields,
		})
	}
	encoded, err := json.Marshal(serializedRecords)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"do-not-log",
		"/secret/workspace",
		"secret command output",
		"secret query",
		"secret assistant content",
	} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("diagnostic records leaked %q: %s", secret, encoded)
		}
	}
}

func TestCodexAppServerTurnDiagnosticsCompletesToolWithoutStart(t *testing.T) {
	sink := &codexAppServerDiagnosticSink{}
	diagnostics := newCodexAppServerTurnDiagnostics(sink, "turn-2")
	diagnostics.ObserveNotification(appServerNotifyItemCompleted, map[string]any{
		"item": map[string]any{
			"id":      "tool-1",
			"type":    "dynamicToolCall",
			"tool":    "render",
			"status":  "completed",
			"success": true,
		},
	})

	if got, want := len(sink.records), 1; got != want {
		t.Fatalf("record count = %d, want %d", got, want)
	}
	fields := sink.records[0].fields
	if got := fields["start_observed"]; got != false {
		t.Fatalf("start_observed = %#v, want false", got)
	}
	if _, ok := fields["duration_ms"]; ok {
		t.Fatalf("duration_ms should be absent when item/started was not observed: %#v", fields)
	}
}

func TestCodexAppServerReducerRecordsOnlyAcceptedToolNotifications(t *testing.T) {
	adapter := NewCodexAppServerAdapter(nil)
	session := Session{
		AgentSessionID:    "agent-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "thread-1",
	}
	normalizer := newACPTurnNormalizer()
	sink := &codexAppServerDiagnosticSink{}
	activeTurn := &codexAppServerActiveTurn{
		turnID:      "turn-1",
		normalizer:  normalizer,
		diagnostics: newCodexAppServerTurnDiagnostics(sink, "turn-1"),
		phase:       codexAppServerTurnPhaseRunning,
	}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{
		threadID:   session.ProviderSessionID,
		activeTurn: activeTurn,
	})
	reducer := newCodexAppServerReducer(adapter)

	reducer.ReduceNotification(nil, session, activeTurn.turnID, acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "provider-turn-1",
			"item": map[string]any{
				"id":      "command-1",
				"type":    "commandExecution",
				"command": "do-not-log this command",
			},
		}),
	}, normalizer, nil)
	reducer.ReduceNotification(nil, session, activeTurn.turnID, acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": "foreign-thread",
			"turnId":   "foreign-turn",
			"item": map[string]any{
				"id":      "foreign-command",
				"type":    "commandExecution",
				"command": "foreign command",
			},
		}),
	}, normalizer, nil)

	if got, want := len(sink.records), 1; got != want {
		t.Fatalf("record count = %d, want %d: %#v", got, want, sink.records)
	}
	if got := sink.records[0].fields["item_id"]; got != "command-1" {
		t.Fatalf("item_id = %#v, want command-1", got)
	}
}

func TestCodexAppServerToolDiagnosticFieldsRecognizeOnlyTools(t *testing.T) {
	toolTypes := []string{
		"commandExecution",
		"fileChange",
		"mcpToolCall",
		"webSearch",
		"dynamicToolCall",
		"collabAgentToolCall",
		"imageGeneration",
		"imageView",
	}
	for _, itemType := range toolTypes {
		t.Run(itemType, func(t *testing.T) {
			_, gotType, _, ok := codexAppServerToolDiagnosticFields(map[string]any{
				"id":   "item-1",
				"type": itemType,
			})
			if !ok || gotType != itemType {
				t.Fatalf("recognized = %v, type = %q", ok, gotType)
			}
		})
	}
	for _, itemType := range []string{"agentMessage", "reasoning", "plan", "userMessage"} {
		t.Run(itemType, func(t *testing.T) {
			if _, _, _, ok := codexAppServerToolDiagnosticFields(map[string]any{
				"id":   "item-1",
				"type": itemType,
			}); ok {
				t.Fatalf("non-tool item %q was recognized as a tool", itemType)
			}
		})
	}
}
