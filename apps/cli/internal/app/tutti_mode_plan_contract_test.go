package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const tuttiModePlanCapabilitiesFixture = `{"commands":[
  {"id":"tutti-mode-plan.plan.propose","path":["plan","propose"],"summary":"Propose a Tutti Mode plan","inputSchema":{"type":"object","required":["file","request-id"],"properties":{"file":{"type":"string","description":"Markdown proposal file."},"request-id":{"type":"string"}}},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
  {"id":"tutti-mode-plan.plan.revise","path":["plan","revise"],"summary":"Revise a Tutti Mode plan","inputSchema":{"type":"object","required":["workflow-id","file","request-id"],"properties":{"workflow-id":{"type":"string"},"file":{"type":"string"},"request-id":{"type":"string"}}},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
  {"id":"tutti-mode-plan.plan.get","path":["plan","get"],"summary":"Get a Tutti Mode plan","inputSchema":{"type":"object","required":["workflow-id"],"properties":{"workflow-id":{"type":"string"}}},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
  {"id":"tutti-mode-plan.plan.wait","path":["plan","wait"],"summary":"Wait for a Tutti Mode plan checkpoint","inputSchema":{"type":"object","required":["workflow-id","checkpoint-id"],"properties":{"workflow-id":{"type":"string"},"checkpoint-id":{"type":"string"},"timeout-ms":{"type":"integer","default":30000,"minimum":0,"maximum":60000}}},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}
]}`

func TestRunTuttiModePlanCommandsUseDynamicDaemonCapabilityProtocol(t *testing.T) {
	tests := []struct {
		name      string
		commandID string
		args      []string
		wantInput map[string]any
	}{
		{
			name:      "propose",
			commandID: "tutti-mode-plan.plan.propose",
			args:      []string{"plan", "propose", "--file", "/tmp/proposal.md", "--request-id", "proposal-request-1"},
			wantInput: map[string]any{"file": "/tmp/proposal.md", "request-id": "proposal-request-1"},
		},
		{
			name:      "revise",
			commandID: "tutti-mode-plan.plan.revise",
			args:      []string{"plan", "revise", "--workflow-id", "WF-1", "--file", "/tmp/revision.md", "--request-id", "revision-request-1"},
			wantInput: map[string]any{"workflow-id": "WF-1", "file": "/tmp/revision.md", "request-id": "revision-request-1"},
		},
		{
			name:      "get",
			commandID: "tutti-mode-plan.plan.get",
			args:      []string{"plan", "get", "--workflow-id", "WF-1"},
			wantInput: map[string]any{"workflow-id": "WF-1"},
		},
		{
			name:      "wait",
			commandID: "tutti-mode-plan.plan.wait",
			args:      []string{"plan", "wait", "--workflow-id", "WF-1", "--checkpoint-id", "CP-1", "--timeout-ms", "30000"},
			wantInput: map[string]any{"workflow-id": "WF-1", "checkpoint-id": "CP-1", "timeout-ms": "30000"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var invokedBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/cli/capabilities":
					_, _ = w.Write([]byte(tuttiModePlanCapabilitiesFixture))
				case "/v1/cli/commands/" + tt.commandID + "/invoke":
					if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
						t.Fatalf("decode body: %v", err)
					}
					_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"workflowId":"WF-1","checkpoint":{"id":"CP-1","status":"pending"}}}}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			writeEndpoint(t, server.URL, "token-1")
			t.Setenv("TUTTI_WORKSPACE_ID", "workspace-1")
			t.Setenv("TUTTI_AGENT_SESSION_ID", "session-1")
			t.Setenv("TUTTI_APP_CLI_PARENT_COMMAND_ID", "tool-call-1")

			var stdout bytes.Buffer
			var stderr bytes.Buffer
			if code := runDefaultProgram(t, tt.args, &stdout, &stderr); code != 0 {
				t.Fatalf("code = %d, stderr = %s", code, stderr.String())
			}

			input, ok := invokedBody["input"].(map[string]any)
			if !ok {
				t.Fatalf("input = %#v", invokedBody["input"])
			}
			if encoded, _ := json.Marshal(input); string(encoded) != mustJSON(t, tt.wantInput) {
				t.Fatalf("input = %s, want %s", encoded, mustJSON(t, tt.wantInput))
			}
			contextValue, ok := invokedBody["context"].(map[string]any)
			if !ok || contextValue["source"] != "cli" || contextValue["workspaceID"] != "workspace-1" || contextValue["agentSessionId"] != "session-1" || contextValue["parentCommandId"] != "tool-call-1" {
				t.Fatalf("context = %#v", invokedBody["context"])
			}
			if !strings.Contains(stdout.String(), `"workflowId": "WF-1"`) {
				t.Fatalf("stdout = %q", stdout.String())
			}
		})
	}
}

func TestRunTuttiModePlanHelpAdvertisesWaitButNotDecisionMutation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(tuttiModePlanCapabilitiesFixture))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"plan", "--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}

	output := stdout.String()
	for _, expected := range []string{"propose", "revise", "get", "wait"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("help is missing %q:\n%s", expected, output)
		}
	}
	if strings.Contains(output, "decide") {
		t.Fatalf("agent-facing CLI must not advertise checkpoint decisions:\n%s", output)
	}
}

func TestRunTuttiModePlanWaitHelpDocumentsBoundedLongPoll(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(tuttiModePlanCapabilitiesFixture))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"plan", "wait", "--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}

	output := stdout.String()
	for _, expected := range []string{
		"--workflow-id <value>",
		"--checkpoint-id <value>",
		"[--timeout-ms <value>]",
		"Default: 30000",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("wait help is missing %q:\n%s", expected, output)
		}
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal value: %v", err)
	}
	return string(encoded)
}
