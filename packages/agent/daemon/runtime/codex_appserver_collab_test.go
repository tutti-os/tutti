package agentruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAppServerCollabAgentFailedCarriesErrorOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-subagent-1",
		"tool":   "spawnAgent",
		"status": "failed",
		"prompt": "Generate one random integer.",
		"error":  "collab spawn failed: agent thread limit reached",
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	if got := asString(update["status"]); got != messageStreamStateFailed {
		t.Fatalf("status = %q, want failed", got)
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["message"]); got != "collab spawn failed: agent thread limit reached" {
		t.Fatalf("rawOutput.message = %q", got)
	}
}

func TestAppServerCollabAgentFailedUsesRolloutOutputFallback(t *testing.T) {
	t.Parallel()

	codexHome := t.TempDir()
	sessionDir := filepath.Join(codexHome, "sessions", "2026", "07", "01")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("mkdir session dir: %v", err)
	}
	rolloutPath := filepath.Join(sessionDir, "rollout-2026-07-01T18-03-27-thread-1.jsonl")
	if err := os.WriteFile(rolloutPath, []byte(
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-spawn-1","output":"collab spawn failed: agent thread limit reached"}}`+"\n",
	), 0o644); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
	adapter := &CodexAppServerAdapter{
		sessions: map[string]*codexAppServerSession{
			"agent-session-1": {serverInfo: map[string]any{"codexHome": codexHome}},
		},
	}
	item := map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-spawn-1",
		"tool":   "spawnAgent",
		"status": "failed",
		"prompt": "Generate one random integer.",
	}
	update, ok := appServerItemToolCallUpdate(item, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	if _, ok := update["rawOutput"]; ok {
		t.Fatalf("rawOutput before fallback = %#v, want absent", update["rawOutput"])
	}
	adapter.completeAppServerCollabAgentToolOutput(Session{
		AgentSessionID:    "agent-session-1",
		ProviderSessionID: "thread-1",
	}, item, update)

	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["message"]); got != "collab spawn failed: agent thread limit reached" {
		t.Fatalf("rawOutput.message = %q", got)
	}
	if got := asString(rawOutput["output"]); got != "collab spawn failed: agent thread limit reached" {
		t.Fatalf("rawOutput.output = %q", got)
	}
}

func TestAppServerCloseAgentIsControlTool(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-close-1",
		"tool":   "closeAgent",
		"status": "completed",
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	if got := asString(update["title"]); got != "closeAgent" {
		t.Fatalf("title = %q, want closeAgent", got)
	}
	if got := asString(update["kind"]); got != "other" {
		t.Fatalf("kind = %q, want other", got)
	}
}

func TestAppServerWaitIsControlTool(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-wait-1",
		"tool":   "wait",
		"status": "completed",
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	if got := asString(update["title"]); got != "wait" {
		t.Fatalf("title = %q, want wait", got)
	}
	if got := asString(update["kind"]); got != "other" {
		t.Fatalf("kind = %q, want other", got)
	}
	if got := acpToolName("call-wait-1", asString(update["title"]), asString(update["kind"]), update["rawInput"]); got != "Wait" {
		t.Fatalf("acpToolName = %q, want Wait", got)
	}
}

func TestAppServerCollabAgentSpawnCarriesStartedAgentOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "call-spawn-1",
		"tool":              "spawnAgent",
		"status":            "completed",
		"prompt":            "Generate one random integer.",
		"receiverThreadIds": []any{"agent-1"},
		"agentsStates": map[string]any{
			"agent-1": map[string]any{"status": "pendingInit"},
		},
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["agent_id"]); got != "agent-1" {
		t.Fatalf("rawOutput.agent_id = %q, want agent-1", got)
	}
	if got := asString(rawOutput["output"]); got != "agent-1" {
		t.Fatalf("rawOutput.output = %q", got)
	}
}

func TestAppServerCollabAgentWaitCarriesCompletedAgentOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "call-wait-1",
		"tool":              "wait",
		"status":            "completed",
		"receiverThreadIds": []any{"agent-1"},
		"agentsStates": map[string]any{
			"agent-1": map[string]any{"status": "completed", "message": "7"},
		},
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["output"]); got != "7" {
		t.Fatalf("rawOutput.output = %q, want 7", got)
	}
	statuses, ok := rawOutput["status"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput.status = %#v, want map", rawOutput["status"])
	}
	agentStatus, ok := statuses["agent-1"].(map[string]any)
	if !ok {
		t.Fatalf("status[agent-1] = %#v, want map", statuses["agent-1"])
	}
	if got := asString(agentStatus["completed"]); got != "7" {
		t.Fatalf("status[agent-1].completed = %q, want 7", got)
	}
}

func TestAppServerCollabAgentCloseCarriesPreviousStatusOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "call-close-1",
		"tool":              "closeAgent",
		"status":            "completed",
		"receiverThreadIds": []any{"agent-1"},
		"agentsStates": map[string]any{
			"agent-1": map[string]any{"status": "completed", "message": "done"},
		},
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["output"]); got != "done" {
		t.Fatalf("rawOutput.output = %q, want done", got)
	}
	previous, ok := rawOutput["previous_status"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput.previous_status = %#v, want map", rawOutput["previous_status"])
	}
	if got := asString(previous["completed"]); got != "done" {
		t.Fatalf("previous_status.completed = %q, want done", got)
	}
}
