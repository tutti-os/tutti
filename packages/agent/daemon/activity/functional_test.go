package agentsessionstore_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
)

func TestWorkspaceAgentMessageFunctionalFlow(t *testing.T) {
	t.Parallel()

	var acceptedActivity int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/rooms/ws-1/agents/sessions/codex-1/state":
			var body struct {
				State map[string]any `json:"state"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode state body: %v", err)
			}
			if len(body.State) == 0 {
				t.Fatal("state body is empty")
			}
			acceptedActivity++
			_ = json.NewEncoder(w).Encode(map[string]bool{"accepted": true})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/rooms/ws-1/agents/sessions/codex-1/messages":
			var body struct {
				Updates []map[string]any `json:"updates"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode messages body: %v", err)
			}
			acceptedActivity += len(body.Updates)
			_ = json.NewEncoder(w).Encode(map[string]int{"acceptedCount": len(body.Updates)})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/rooms/ws-1/agents/list":
			_, _ = w.Write([]byte(`{
				"presences":[{"id":1,"roomId":"ws-1","userId":"user-1","provider":"codex","status":"working"}],
				"sessions":[{"id":2,"agentSessionId":"codex-1","presenceId":1,"providerSessionId":"codex-1","cwd":"/workspace/ws-1","effectiveStatus":"working","sessionOrigin":"WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"}]
			}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/rooms/ws-1/agents/sessions/codex-1/messages":
			if r.URL.Query().Get("after_version") != "0" && r.URL.Query().Get("after_version") != "" {
				t.Fatalf("unexpected after_version = %q", r.URL.Query().Get("after_version"))
			}
			if r.URL.Query().Get("session_origin") != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
				t.Fatalf("session_origin = %q", r.URL.Query().Get("session_origin"))
			}
			_, _ = w.Write([]byte(`{
				"messages":[
					{"id":7,"agentSessionId":"agent-session-1","messageId":"msg-1","role":"assistant","kind":"text","payload":{"content":"Done."},"occurredAtUnixMs":1776934803000,"createdAtUnixMs":1776934803100,"version":7},
					{"id":8,"agentSessionId":"agent-session-1","messageId":"act-1","role":"tool","kind":"tool_call","status":"running","payload":{"callId":"call-1","name":"exec_command"},"occurredAtUnixMs":1776934804000,"createdAtUnixMs":1776934804100,"version":8}
				],
				"latestVersion":8
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := agentsessionstore.NewClient(agentsessionstore.Config{BaseURL: server.URL, UserID: "user-1"})

	reply, err := client.ReportActivity(context.Background(), agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-1",
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID:    "codex-1",
			Provider:          "codex",
			ProviderSessionID: "codex-1",
			CWD:               "/workspace/ws-1",
			CurrentPhase:      "working",
			LifecycleStatus:   "active",
			OccurredAtUnixMS:  1776934800000,
		}},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{
			{
				AgentSessionID:   "codex-1",
				MessageID:        "msg-user-1",
				TurnID:           "turn-1",
				Role:             "user",
				Kind:             "text",
				Payload:          map[string]any{"content": "Inspect README."},
				OccurredAtUnixMS: 1776934801000,
			},
			{
				AgentSessionID:   "codex-1",
				MessageID:        "msg-assistant-1",
				TurnID:           "turn-1",
				Role:             "assistant",
				Kind:             "text",
				Payload:          map[string]any{"content": "Done."},
				OccurredAtUnixMS: 1776934803000,
			},
		},
		Source: agentsessionstore.EventSource{
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:      "codex",
		},
	})
	if err != nil {
		t.Fatalf("ReportActivity() error = %v", err)
	}
	acceptedReply := reply.AcceptedStatePatchCount + reply.AcceptedMessageUpdateCount
	if acceptedReply != acceptedActivity || acceptedActivity == 0 {
		t.Fatalf("accepted = reply:%d server:%d want nonzero matching count", acceptedReply, acceptedActivity)
	}

	poller := agentsessionstore.NewPoller(client, agentsessionstore.PollerOptions{Limit: 20})
	result, err := poller.Poll(context.Background(), "ws-1", nil)
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(result.Snapshot.Presences) != 1 || result.Snapshot.Presences[0].Provider != "codex" {
		t.Fatalf("snapshot presences = %#v", result.Snapshot.Presences)
	}
	messages := result.Messages["codex-1"]
	if len(messages.Messages) != 2 {
		t.Fatalf("messages = %#v", messages.Messages)
	}
	if messages.Messages[0].Kind != "text" ||
		messages.Messages[0].Role != "assistant" ||
		messages.Messages[0].Payload["content"] != "Done." ||
		messages.Messages[0].OccurredAtUnixMS != 1776934803000 ||
		messages.Messages[0].CreatedAtUnixMS != 1776934803100 {
		t.Fatalf("message entry = %#v", messages.Messages[0])
	}
	if messages.Messages[1].Kind != "tool_call" ||
		messages.Messages[1].Role != "tool" ||
		messages.Messages[1].Payload["callId"] != "call-1" ||
		messages.Messages[1].Payload["name"] != "exec_command" ||
		messages.Messages[1].OccurredAtUnixMS != 1776934804000 ||
		messages.Messages[1].CreatedAtUnixMS != 1776934804100 {
		t.Fatalf("tool message entry = %#v", messages.Messages[1])
	}
	if result.Cursors["codex-1"].AfterVersion != 8 {
		t.Fatalf("cursor = %#v", result.Cursors["codex-1"])
	}
}
