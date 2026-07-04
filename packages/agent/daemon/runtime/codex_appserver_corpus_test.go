package agentruntime

import "testing"

// Step 0 characterization corpus. These tests capture CURRENT behavior of the
// app-server reducer's pure helpers so the layer refactor (steps 1-9) cannot
// silently change it. See docs/specs/2026-07-01-codex-appserver-bug-corpus.md.

// A completed collab (sub-agent) tool call must surface its result/output into
// the parent card's rawOutput. Step 3 keeps this outcome while switching the
// mechanism from drop-filter to thread routing.
func TestAppServerCollabAgentCompletedCarriesResultOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-subagent-ok-1",
		"tool":   "spawnAgent",
		"status": "completed",
		"prompt": "Generate one random integer.",
		"result": map[string]any{"integer": 7},
		"output": "7\n",
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	// asString trims trailing whitespace, so the stored "7\n" reads back as "7".
	if got := asString(rawOutput["output"]); got != "7" {
		t.Fatalf("rawOutput.output = %q, want \"7\"", got)
	}
	result, ok := rawOutput["result"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput.result = %#v, want map", rawOutput["result"])
	}
	if got, _ := acpInt64Value(result["integer"]); got != 7 {
		t.Fatalf("rawOutput.result.integer = %#v, want 7", result["integer"])
	}
}

// Step 3 routing behavior: linked child threads are preserved under the parent
// session with OwnerThreadID, while unknown foreign threads still drop.
func TestAppServerForeignThreadMismatch(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(nil)
	session := Session{AgentSessionID: "s1", Provider: ProviderCodex, ProviderSessionID: "codex-thread-1"}
	adapter.storeSession(session.AgentSessionID, &codexAppServerSession{threadID: session.ProviderSessionID})

	cases := []struct {
		name   string
		params map[string]any
		want   bool // true == dropped
	}{
		{
			name:   "same thread is not dropped",
			params: map[string]any{"threadId": "codex-thread-1", "item": map[string]any{"id": "i1"}},
			want:   false,
		},
		{
			name:   "foreign thread is dropped",
			params: map[string]any{"threadId": "codex-thread-OTHER", "item": map[string]any{"id": "i2"}},
			want:   true,
		},
		{
			name:   "missing event threadId is not dropped",
			params: map[string]any{"item": map[string]any{"id": "i3"}},
			want:   false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := adapter.appServerNotificationRoute(session, appServerNotifyItemStarted, tc.params).drop
			if got != tc.want {
				t.Fatalf("drop = %v, want %v", got, tc.want)
			}
		})
	}
}
