package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunHelpUsesDefaultCommandName(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Usage: tutti [--json] <command>") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunWithProgramUsesDevCommandName(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := RunWithProgram(t.Context(), "/repo/apps/cli/build/dev/tutti", []string{"help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Usage: tutti-dev [--json] <command>") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunWithProgramUsesDevCommandNameForRelativeDevBuild(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := RunWithProgram(t.Context(), "./build/dev/tutti", []string{"help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Usage: tutti-dev [--json] <command>") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunWithProgramUsesCommandNameInSubcommandUsage(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := RunWithProgram(t.Context(), "tutti-dev", []string{"status", "extra"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "usage: tutti-dev status [--json]") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestCliInvokeContextFromEnvIncludesAgentSessionID(t *testing.T) {
	t.Setenv("TUTTI_WORKSPACE_ID", " workspace-1 ")
	t.Setenv("TUTTI_APP_CLI_PARENT_COMMAND_ID", " parent-1 ")
	t.Setenv("TUTTI_AGENT_SESSION_ID", " session-1 ")

	context := cliInvokeContextFromEnv()
	if context.Source != "cli" ||
		context.WorkspaceID != "workspace-1" ||
		context.ParentCommandID != "parent-1" ||
		context.AgentSessionID != "session-1" {
		t.Fatalf("context = %#v", context)
	}
}

func TestRunStatusJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer token-1" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"tuttid","status":"ok"}`))
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"status", "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}

	var payload struct {
		Service string `json:"service"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal stdout: %v\n%s", err, stdout.String())
	}
	if payload.Service != "tuttid" || payload.Status != "ok" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestRunStatusAuthFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"status"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "daemon authentication failed") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunDynamicCommandRendersTable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue.list","path":["issue","list"],"summary":"List issues","output":{"defaultMode":"table","json":true,"table":{"columns":[{"key":"id","label":"ID"},{"key":"title","label":"Title"}]}}}]}`))
		case "/v1/cli/commands/issue.list/invoke":
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"table","columns":[{"key":"id","label":"ID"},{"key":"title","label":"Title"}],"rows":[{"id":"ISS-1","title":"Fix startup"}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"issue", "list", "--status", "open"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "ISS-1") || !strings.Contains(stdout.String(), "Fix startup") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunDynamicCommandRendersJSONRows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue.list","path":["issue","list"],"summary":"List issues","output":{"defaultMode":"table","json":true}}]}`))
		case "/v1/cli/commands/issue.list/invoke":
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"table","rows":[{"id":"ISS-1"}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"--json", "issue", "list"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"id": "ISS-1"`) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunDynamicCommandMatchesMultiSegmentPath(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue-manager.issue.task.run.complete","path":["issue","task","run","complete"],"summary":"Complete run","output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/issue-manager.issue.task.run.complete/invoke":
			if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"run":{"runId":"RUN-1"}}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"--json", "issue", "task", "run", "complete", "--issue-id", "ISS-1", "--task-id=TASK-1", "--run-id", "RUN-1", "--status", "completed"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["issue-id"] != "ISS-1" || input["task-id"] != "TASK-1" || input["status"] != "completed" {
		t.Fatalf("input = %#v", input)
	}
	if !strings.Contains(stdout.String(), `"runId": "RUN-1"`) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunDynamicCommandHelpRendersInputSchema(t *testing.T) {
	invoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue-manager.issue.task.create","path":["issue","task","create"],"summary":"Create an issue task","description":"Create a task under an issue.","inputSchema":{"type":"object","properties":{"issue-id":{"type":"string","description":"Issue that owns the task."},"task-id":{"type":"string","description":"Stable task id to create; generated when omitted."},"title":{"type":"string","description":"Task title."},"content":{"type":"string","description":"Task instructions or notes."},"priority":{"type":"string","description":"Task priority: high, medium, or low."},"due-at-unix":{"type":"string","description":"Due time as a Unix timestamp in seconds."}},"required":["issue-id","title"]},"output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/issue-manager.issue.task.create/invoke":
			invoked = true
			http.Error(w, "unexpected invoke", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"issue", "task", "create", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if invoked {
		t.Fatal("command was invoked")
	}
	output := stdout.String()
	for _, expected := range []string{
		"Usage: tutti issue task create [--json] --issue-id <value> --title <value>",
		"--issue-id",
		"--title",
		"--content",
		"--due-at-unix",
		"--priority",
		"--task-id",
		"required",
		"Task title.",
		"Task priority: high, medium, or low.",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
}

func TestRunDynamicScopeHelpListsCommandsAndDocumentation(t *testing.T) {
	invoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[
        {"id":"app.automation.automation.list","path":["automation","list"],"summary":"List automations","output":{"defaultMode":"table","json":true},"source":{"kind":"app","appId":"automation","appName":"Automation","documentationFile":"COMMANDS.md","documentationPath":"/tmp/tutti/apps/automation/COMMANDS.md"}},
        {"id":"app.automation.automation.run","path":["automation","run"],"summary":"Run an automation","output":{"defaultMode":"json","json":true},"source":{"kind":"app","appId":"automation","appName":"Automation","documentationFile":"COMMANDS.md","documentationPath":"/tmp/tutti/apps/automation/COMMANDS.md"}},
        {"id":"app.automation.automation.runs","path":["automation","runs"],"summary":"List automation runs","output":{"defaultMode":"table","json":true},"source":{"kind":"app","appId":"automation","appName":"Automation","documentationFile":"COMMANDS.md","documentationPath":"/tmp/tutti/apps/automation/COMMANDS.md"}}
      ]}`))
		case "/v1/cli/commands/app.automation.automation.list/invoke":
			invoked = true
			http.Error(w, "unexpected invoke", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"automation", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if invoked {
		t.Fatal("command was invoked")
	}
	output := stdout.String()
	for _, expected := range []string{
		"Usage: tutti automation <command> [--json]",
		"list  List automations",
		"run   Run an automation",
		"runs  List automation runs",
		`Use "tutti automation <command> --help" for command details.`,
		"More documentation:",
		"/tmp/tutti/apps/automation/COMMANDS.md",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
}

func TestRunRootHelpListsDynamicCommandScopes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(`{"commands":[
        {"id":"app.automation.automation.list","path":["automation","list"],"summary":"List automations","description":"List automation definitions.","output":{"defaultMode":"table","json":true},"source":{"kind":"app","appId":"automation","appName":"Automation","cliDescription":"Manage automations.","appDescription":"Create and run automations."}},
        {"id":"agent-context.agent.providers","path":["agent","providers"],"summary":"List agent providers","output":{"defaultMode":"table","json":true},"source":{"kind":"builtin"}}
      ]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{
		"status      Show local tuttid status",
		"agent       1 commands",
		"automation  Manage automations.  1 commands",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
}

func TestRunDynamicCommandPrefersLongestMatchingPath(t *testing.T) {
	var invokedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent","path":["agent"],"summary":"Agent","output":{"defaultMode":"json","json":true}},{"id":"agent-context.agent.session.messages","path":["agent","session","messages"],"summary":"Messages","output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent/invoke", "/v1/cli/commands/agent-context.agent.session.messages/invoke":
			invokedPath = r.URL.Path
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"agent", "session", "messages", "--session-id", "SESSION-1", "--json"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if invokedPath != "/v1/cli/commands/agent-context.agent.session.messages/invoke" {
		t.Fatalf("invokedPath = %q", invokedPath)
	}
}

func TestRunDynamicCommandRejectsUnexpectedPositionalArgument(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue-manager.issue.get","path":["issue","get"],"summary":"Get issue","output":{"defaultMode":"json","json":true}}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"issue", "get", "ISS-1"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), `unexpected argument "ISS-1"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func writeEndpoint(t *testing.T, addr string, token string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tuttid.listener.json")
	body := `{"version":1,"addr":` + quoteJSON(addr) + `,"auth":{"scheme":"bearer","token":` + quoteJSON(token) + `}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write endpoint: %v", err)
	}
	t.Setenv("TUTTID_LISTENER_INFO_PATH", path)
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
