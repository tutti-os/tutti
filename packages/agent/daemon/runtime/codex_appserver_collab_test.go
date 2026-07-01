package agentruntime

import "testing"

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
