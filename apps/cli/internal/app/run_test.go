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

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
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

func TestWriteDynamicJSONKeepsCommandWarningsOutOfAppValue(t *testing.T) {
	output := daemon.CommandOutput{
		Kind: "json",
		Value: map[string]any{
			"ok":       true,
			"warnings": "app-defined",
		},
		Warnings: []daemon.CommandWarning{{
			Code:    "unknown_input_ignored",
			Message: "Unknown input ignored.",
		}},
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := writeCommandOutput(&stdout, &stderr, output); code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	var envelope map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("decode stdout: %v\n%s", err, stdout.String())
	}
	value := envelope["value"].(map[string]any)
	if value["warnings"] != "app-defined" {
		t.Fatalf("app warnings field was clobbered: %#v", value["warnings"])
	}
	warnings := envelope["warnings"].([]any)
	if len(warnings) != 1 || warnings[0].(map[string]any)["code"] != "unknown_input_ignored" {
		t.Fatalf("warnings = %#v", envelope["warnings"])
	}
}

func TestRunHelpIncludesIntegrationCapabilitiesInsideAppRuntime(t *testing.T) {
	var sawCapabilitiesRequest bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/cli/capabilities" {
			http.NotFound(w, r)
			return
		}
		sawCapabilitiesRequest = true
		if r.URL.Query().Get("workspaceID") != "ws-1" {
			t.Fatalf("workspaceID query = %q", r.URL.RawQuery)
		}
		if r.URL.Query().Get("includeIntegration") != "true" {
			t.Fatalf("includeIntegration query = %q", r.URL.RawQuery)
		}
		if r.URL.Query().Get("includeHidden") != "" {
			t.Fatalf("includeHidden query = %q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"commands":[{"id":"workspace-apps.app.open","path":["app","open"],"summary":"Open app","visibility":"integration","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}]}`))
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	t.Setenv("TUTTI_APP_ID", "automation-app")
	t.Setenv("TUTTI_CLI", "/tmp/tutti")
	t.Setenv("TUTTI_WORKSPACE_ID", "ws-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !sawCapabilitiesRequest {
		t.Fatal("capabilities request was not sent")
	}
	if !strings.Contains(stdout.String(), "integration-only") || !strings.Contains(stdout.String(), "Do not expose or forward") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunHelpDoesNotIncludeIntegrationCapabilitiesWithoutAppCLIContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/cli/capabilities" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("includeIntegration") != "" {
			t.Fatalf("includeIntegration query = %q", r.URL.RawQuery)
		}
		if r.URL.Query().Get("includeHidden") != "" {
			t.Fatalf("includeHidden query = %q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"commands":[]}`))
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	t.Setenv("TUTTI_APP_ID", "draft-app")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(t.Context(), []string{"--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
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

func TestRunDynamicCommandAggregatesRepeatedFlags(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"workspace-apps.app.open","path":["app","open"],"summary":"Open app","inputSchema":{"type":"object","required":["app-id"],"properties":{"app-id":{"type":"string"},"param":{"type":"string"},"route":{"type":"string"}}},"output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/workspace-apps.app.open/invoke":
			if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"app", "open", "--app-id", "docs", "--route", "/files", "--param", "path=/tmp/a", "--param", "mode=preview"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	params, ok := input["param"].([]any)
	if !ok || len(params) != 2 || params[0] != "path=/tmp/a" || params[1] != "mode=preview" {
		t.Fatalf("param input = %#v", input["param"])
	}
}

func TestRunDynamicAgentSendAggregatesRepeatedImageFlags(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.send","path":["agent","send"],"summary":"Send input","inputSchema":{"type":"object","required":["session-id","prompt"],"properties":{"session-id":{"type":"string"},"prompt":{"type":"string"},"image":{"type":"array","items":{"type":"string"}}}},"output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.send/invoke":
			if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"agent", "send", "SESSION-1", "--prompt", "look", "--image", "/tmp/a.png", "--image", "/tmp/b.jpg"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["session-id"] != "SESSION-1" || input["prompt"] != "look" {
		t.Fatalf("input = %#v", input)
	}
	images, ok := input["image"].([]any)
	if !ok || len(images) != 2 || images[0] != "/tmp/a.png" || images[1] != "/tmp/b.jpg" {
		t.Fatalf("image input = %#v", input["image"])
	}
}

func TestRunDynamicAgentSendSplitsPositionalPromptBeforeImageFlags(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.send","path":["agent","send"],"summary":"Send input","inputSchema":{"type":"object","required":["session-id","prompt"],"properties":{"session-id":{"type":"string"},"prompt":{"type":"string"},"image":{"type":"array","items":{"type":"string"}}}},"output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.send/invoke":
			if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"agent", "send", "SESSION-1", "look", "here", "--image", "/tmp/a.png"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["session-id"] != "SESSION-1" || input["prompt"] != "look here" {
		t.Fatalf("input = %#v", input)
	}
	images, ok := input["image"].([]any)
	if !ok || len(images) != 1 || images[0] != "/tmp/a.png" {
		t.Fatalf("image input = %#v", input["image"])
	}
}

func TestRunDynamicAgentSendKeepsFlagLikeTokensInPositionalPrompt(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.send","path":["agent","send"],"summary":"Send input","inputSchema":{"type":"object","required":["session-id","prompt"],"properties":{"session-id":{"type":"string"},"prompt":{"type":"string"},"image":{"type":"array","items":{"type":"string"}}}},"output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.send/invoke":
			if err := json.NewDecoder(r.Body).Decode(&invokedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"agent", "send", "SESSION-1", "please", "run", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["session-id"] != "SESSION-1" || input["prompt"] != "please run --help" {
		t.Fatalf("input = %#v", input)
	}
}

func TestRunDynamicCommandHelpRendersInputSchema(t *testing.T) {
	invoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"issue-manager.issue.task.create","path":["issue","task","create"],"summary":"Create an issue task","description":"Create a task under an issue.","inputSchema":{"type":"object","properties":{"issue-id":{"type":"string","description":"Issue that owns the task."},"task-id":{"type":"string","description":"Stable task id to create; generated when omitted."},"title":{"type":"string","description":"Task title."},"content":{"type":"string","description":"Task instructions or notes."},"priority":{"type":"string","description":"Task priority.","enum":["high","medium","low"],"default":"medium"},"enabled":{"type":"boolean","description":"Whether the task is enabled.","default":true},"due-at-unix":{"type":"integer","description":"Due time as a Unix timestamp in seconds.","default":1893456000}},"required":["issue-id","title"]},"output":{"defaultMode":"json","json":true}}]}`))
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
		"--enabled",
		"--priority",
		"--task-id",
		"required",
		"Task title.",
		"Task priority.",
		"Values: high, medium, low",
		"Default: medium",
		"Default: true",
		"Default: 1893456000",
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
        {"id":"app.automation.automation.run","path":["automation","run"],"summary":"Run an automation","inputSchema":{"type":"object","properties":{"automation-id":{"type":"string","description":"Automation id."},"name":{"type":"string","description":"Exact automation name."}},"required":["automation-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"app","appId":"automation","appName":"Automation","documentationFile":"COMMANDS.md","documentationPath":"/tmp/tutti/apps/automation/COMMANDS.md"}},
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
		"run   Run an automation  required: --automation-id <value>",
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

func TestRunDynamicScopeHelpShowsRequiredFlagsForBuiltinCommands(t *testing.T) {
	invoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[
        {"id":"issue-manager.issue.run.create","path":["issue","run","create"],"summary":"Create issue run","inputSchema":{"type":"object","properties":{"issue-id":{"type":"string"},"agent-provider":{"type":"string"},"agent-session-id":{"type":"string"}},"required":["agent-provider","agent-session-id","issue-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.run.complete","path":["issue","run","complete"],"summary":"Complete issue run","inputSchema":{"type":"object","properties":{"issue-id":{"type":"string"},"run-id":{"type":"string"},"status":{"type":"string"}},"required":["issue-id","run-id","status"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.topic.list","path":["issue","topic","list"],"summary":"List issue topics","output":{"defaultMode":"table","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.topic.create","path":["issue","topic","create"],"summary":"Create issue topic","inputSchema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.topic.delete","path":["issue","topic","delete"],"summary":"Delete issue topic","inputSchema":{"type":"object","properties":{"topic-id":{"type":"string"}},"required":["topic-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.topic.update","path":["issue","topic","update"],"summary":"Update issue topic","inputSchema":{"type":"object","properties":{"topic-id":{"type":"string"}},"required":["topic-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.list","path":["issue","list"],"summary":"List issues","inputSchema":{"type":"object","properties":{"topic-id":{"type":"string","description":"Required topic id."},"status":{"type":"string","description":"Issue status."}},"required":["topic-id"]},"output":{"defaultMode":"table","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.get","path":["issue","get"],"summary":"Get issue detail","inputSchema":{"type":"object","properties":{"issue-id":{"type":"string","description":"Issue id."}},"required":["issue-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}
      ]}`))
		case "/v1/cli/commands/issue-manager.issue.list/invoke":
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
	code := Run(t.Context(), []string{"issue", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if invoked {
		t.Fatal("command was invoked")
	}
	output := stdout.String()
	for _, expected := range []string{
		"Usage: tutti issue <command> [--json]",
		"get    Get issue detail  required: --issue-id <value>",
		"list   List issues  required: --topic-id <value>",
		"run    2 commands",
		"create    Create issue run  required: --agent-provider <value> --agent-session-id <value> --issue-id <value>",
		"complete  Complete issue run  required: --issue-id <value> --run-id <value> --status <value>",
		"topic  4 commands",
		"create  Create issue topic  required: --title <value>",
		"delete  Delete issue topic  required: --topic-id <value>",
		"list    List issue topics",
		"update  Update issue topic  required: --topic-id <value>",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
}

func TestRunDynamicCommandGroupWithoutSubcommandShowsPrefixHelp(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(`{"commands":[
        {"id":"issue-manager.issue.topic.list","path":["issue","topic","list"],"summary":"List issue topics","output":{"defaultMode":"table","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.topic.create","path":["issue","topic","create"],"summary":"Create issue topic","inputSchema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}
      ]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"issue", "topic"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if stderr.String() != "" {
		t.Fatalf("stderr = %q, want empty when prefix help is shown", stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{
		"Usage: tutti issue topic <command> [--json]",
		"create  Create issue topic  required: --title <value>",
		"list    List issue topics",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
}

func TestRunDynamicScopeHelpLimitsGroupedCommandPreview(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(`{"commands":[
        {"id":"issue-manager.issue.task.a","path":["issue","task","a"],"summary":"A","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.task.b","path":["issue","task","b"],"summary":"B","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.task.c","path":["issue","task","c"],"summary":"C","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.task.d","path":["issue","task","d"],"summary":"D","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.task.e","path":["issue","task","e"],"summary":"E","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}},
        {"id":"issue-manager.issue.task.f","path":["issue","task","f"],"summary":"F","output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}
      ]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"issue", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{
		"task  6 commands",
		"a  A",
		"e  E",
		"...   1 more commands",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("stdout missing %q:\n%s", expected, output)
		}
	}
	if strings.Contains(output, "f  F") {
		t.Fatalf("stdout includes command beyond preview limit:\n%s", output)
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
