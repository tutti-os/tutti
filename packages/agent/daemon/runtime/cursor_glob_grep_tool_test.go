package agentruntime

import (
	"encoding/json"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Cursor ACP streams Glob/Grep as kind=search with descriptive titles
// (e.g. Find `dir` `*.go`, grep "x") and rawInput {pattern}, then completes
// with only rawOutput (no title/rawInput). Historically that collapsed to
// Bash and blanked the tool card.
func TestCursorGlobAndGrepToolCallsPreserveIdentityAndInput(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	config := standardACPConfig{provider: ProviderCursor}
	globID := "call-101a078b-dcbb-48a5-a057-a5e587c5ebc1-2\nfc_fc5bef37-7335-9865-b75f-744301ebeb0b_2"
	grepID := "call-22cabf29-f06e-469c-aef8-0cce229823cb-5\nfc_a254225c-3128-9b17-b3ad-f7c48240c797_1"
	globTitle := "Find `/tmp/session-x` `**/*vibe-design*`"

	started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": `+jsonString(globID)+`,
			"title": `+jsonString(globTitle)+`,
			"kind": "search",
			"status": "pending",
			"rawInput": {"pattern": "**/*vibe-design*"},
			"locations": [{"path": "/tmp/session-x"}]
		}
	}`), normalizer)
	var startedCall activityshared.Event
	for _, ev := range started {
		if ev.Type == EventCallStarted {
			startedCall = ev
		}
	}
	if asString(startedCall.Payload.Metadata["toolName"]) != "Glob" {
		t.Fatalf("started toolName = %#v, want Glob (metadata=%#v)", startedCall.Payload.Metadata["toolName"], startedCall.Payload.Metadata)
	}
	if input := payloadMap(startedCall.Payload.Metadata, "input"); asString(input["pattern"]) != "**/*vibe-design*" {
		t.Fatalf("started input = %#v, want pattern", input)
	}

	completed := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": `+jsonString(globID)+`,
			"status": "completed",
			"rawOutput": {"totalFiles": 0, "truncated": false},
			"content": [{"type": "content", "content": {"type": "text", "text": "0 files found"}}]
		}
	}`), normalizer)
	var completedCall activityshared.Event
	for _, ev := range completed {
		if ev.Type == EventCallCompleted {
			completedCall = ev
		}
	}
	if asString(completedCall.Payload.Metadata["toolName"]) != "Glob" {
		t.Fatalf("completed toolName = %#v, want Glob (metadata=%#v)", completedCall.Payload.Metadata["toolName"], completedCall.Payload.Metadata)
	}
	if input := payloadMap(completedCall.Payload.Metadata, "input"); asString(input["pattern"]) != "**/*vibe-design*" {
		t.Fatalf("completed input = %#v, want pattern preserved across empty update", input)
	}

	normalizer2 := newACPTurnNormalizer()
	_ = standardACPUpdateEvents(config, session, "turn-2", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": `+jsonString(grepID)+`,
			"title": "grep \"vibe-design\"",
			"kind": "search",
			"status": "pending",
			"rawInput": {"pattern": "vibe-design", "path": "/Users/niuma/.codex/skills"}
		}
	}`), normalizer2)
	completedGrep := standardACPUpdateEvents(config, session, "turn-2", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": `+jsonString(grepID)+`,
			"status": "completed",
			"rawOutput": {"totalMatches": 0, "truncated": false}
		}
	}`), normalizer2)
	var cg activityshared.Event
	for _, ev := range completedGrep {
		if ev.Type == EventCallCompleted {
			cg = ev
		}
	}
	if asString(cg.Payload.Metadata["toolName"]) != "Grep" {
		t.Fatalf("grep toolName = %#v, want Grep", cg.Payload.Metadata["toolName"])
	}
	if input := payloadMap(cg.Payload.Metadata, "input"); asString(input["pattern"]) != "vibe-design" {
		t.Fatalf("grep input = %#v, want pattern preserved", input)
	}

	updates := reportActivityInput(session, []activityshared.Event{startedCall, completedCall}).MessageUpdates
	if len(updates) < 2 {
		t.Fatalf("message updates = %#v, want start+complete", updates)
	}
	if updates[1].Payload["toolName"] != "Glob" {
		t.Fatalf("completed message toolName = %#v, want Glob", updates[1].Payload["toolName"])
	}
	if input, _ := updates[1].Payload["input"].(map[string]any); asString(input["pattern"]) != "**/*vibe-design*" {
		t.Fatalf("completed message input = %#v, want pattern", updates[1].Payload["input"])
	}
}

func TestAcpToolNameRecognizesCursorSearchTitlesAndInput(t *testing.T) {
	t.Parallel()

	cases := []struct {
		title string
		kind  string
		input map[string]any
		out   map[string]any
		want  string
	}{
		{title: "Find `/tmp` `*.go`", kind: "search", input: map[string]any{"pattern": "*.go"}, want: "Glob"},
		{title: "grep \"vibe-design\"", kind: "search", input: map[string]any{"pattern": "vibe-design", "path": "/tmp"}, want: "Grep"},
		{title: "", kind: "search", input: map[string]any{"pattern": "*.ts"}, want: "Glob"},
		{title: "", kind: "search", input: map[string]any{"pattern": "foo", "path": "/tmp"}, want: "Grep"},
		{title: "call-abc\nfc_x", kind: "search", out: map[string]any{"totalFiles": 0}, want: "Glob"},
		{title: "call-abc\nfc_x", kind: "search", out: map[string]any{"totalMatches": 3}, want: "Grep"},
		{title: "Read /tmp/a.md", kind: "read", input: map[string]any{"path": "/tmp/a.md"}, want: "Read"},
		{title: "`ls -la`", kind: "execute", input: map[string]any{"command": "ls -la"}, want: "Bash"},
	}
	for _, tc := range cases {
		got := acpToolNameWithOutput("call-id", tc.title, tc.kind, tc.input, tc.out)
		if got != tc.want {
			t.Fatalf("acpToolNameWithOutput(title=%q kind=%q input=%v out=%v) = %q, want %q",
				tc.title, tc.kind, tc.input, tc.out, got, tc.want)
		}
	}
}
