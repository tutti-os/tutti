package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
)

func runDefaultProgram(t *testing.T, args []string, stdout *bytes.Buffer, stderr *bytes.Buffer) int {
	t.Helper()
	return RunWithProgram(t.Context(), "tutti", args, stdout, stderr)
}

func TestCliInvokeContextFromEnvIncludesAgentSessionID(t *testing.T) {
	t.Setenv("TUTTI_APP_ID", " automation-app ")
	t.Setenv("TUTTI_WORKSPACE_ID", " workspace-1 ")
	t.Setenv("TUTTI_APP_CLI_PARENT_COMMAND_ID", " parent-1 ")
	t.Setenv("TUTTI_AGENT_SESSION_ID", " session-1 ")

	context := cliInvokeContextFromEnv()
	if context.AppID != "automation-app" ||
		context.Source != "cli" ||
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
	if code := runDefaultProgram(t, []string{"--help"}, &stdout, &stderr); code != 0 {
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
	if code := runDefaultProgram(t, []string{"--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
}

func TestRunExactLegacyAgentCommandRetriesIntegrationDiscovery(t *testing.T) {
	capabilityRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			capabilityRequests++
			if r.URL.Query().Get("includeIntegration") != "true" {
				_, _ = w.Write([]byte(`{"commands":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.codex.start","path":["codex","start"],"summary":"Legacy start","visibility":"integration","inputSchema":{"type":"object","properties":{"prompt":{"type":"string"}},"required":["prompt"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}]}`))
		case "/v1/cli/commands/agent-context.codex.start/invoke":
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"agentSessionId":"SESSION-1"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "codex", "start", "--prompt", "review"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if capabilityRequests != 2 || !strings.Contains(stdout.String(), "SESSION-1") {
		t.Fatalf("requests = %d, stdout = %q", capabilityRequests, stdout.String())
	}
}

func TestRunLegacySessionSummaryPreservesTopLevelJSONShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			if r.URL.Query().Get("includeIntegration") != "true" {
				_, _ = w.Write([]byte(`{"commands":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.session-summary","path":["agent","session-summary"],"summary":"Deprecated summary","visibility":"integration","inputSchema":{"type":"object","properties":{"session-id":{"type":"string"}},"required":["session-id"]},"output":{"defaultMode":"json","json":true},"source":{"kind":"builtin"}}]}`))
		case "/v1/cli/commands/agent-context.agent.session-summary/invoke":
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"session":{"agentSessionId":"SESSION-1"},"messages":[],"latestVersion":9,"hasMore":false}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "agent", "session-summary", "--session-id", "SESSION-1"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode stdout: %v\n%s", err, stdout.String())
	}
	if output["session"].(map[string]any)["agentSessionId"] != "SESSION-1" || output["latestVersion"] != float64(9) {
		t.Fatalf("output = %#v", output)
	}
	if _, wrapped := output["value"]; wrapped {
		t.Fatalf("legacy JSON was wrapped: %#v", output)
	}
	if _, warned := output["warnings"]; warned || stderr.Len() != 0 {
		t.Fatalf("legacy JSON emitted runtime warning: output=%#v stderr=%q", output, stderr.String())
	}
}

func TestLegacyAgentCompatibilityInvocationIsExactAllowlist(t *testing.T) {
	for _, args := range [][]string{
		{"agent", "providers"},
		{"agent", "cancel", "--session-id", "SESSION-1"},
		{"agent", "session-summary", "--session-id", "SESSION-1"},
		{"codex", "start", "--prompt", "review"},
		{"claude", "start", "--prompt", "review"},
	} {
		if !legacyAgentCompatibilityInvocation(args) {
			t.Fatalf("expected compatibility path for %#v", args)
		}
	}
	for _, args := range [][]string{
		{"agent", "start"},
		{"agent", "tutti-cli-skill-bundle"},
		{"diagnostics", "ping"},
		{"codex"},
	} {
		if legacyAgentCompatibilityInvocation(args) {
			t.Fatalf("unexpected compatibility path for %#v", args)
		}
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
	if code := runDefaultProgram(t, []string{"status", "--json"}, &stdout, &stderr); code != 0 {
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
	if code := runDefaultProgram(t, []string{"status"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "daemon authentication failed") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunStatusJSONAuthFailureIsStructured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"status", "--json"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "unauthorized", "daemon authentication failed")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunStatusJSONDaemonUnavailableIsStructured(t *testing.T) {
	t.Setenv("TUTTID_LISTENER_INFO_PATH", filepath.Join(t.TempDir(), "missing-listener.json"))

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"status", "--json"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "daemon_unavailable", "daemon endpoint is not available")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
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
	if code := runDefaultProgram(t, []string{"issue", "list", "--status", "open"}, &stdout, &stderr); code != 0 {
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
	if code := runDefaultProgram(t, []string{"--json", "issue", "list"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"id": "ISS-1"`) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunWaitCommandRepeatsPendingInvocationsAndPrintsOnlyFinalJSON(t *testing.T) {
	invokeCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"app.workflow.runs.wait","path":["workflow","runs","wait"],"summary":"Wait for run","inputSchema":{"type":"object","properties":{"run-id":{"type":"string"}},"required":["run-id"]},"output":{"defaultMode":"json","json":true},"execution":{"mode":"wait"},"handlerTimeoutMs":30000,"source":{"kind":"app"}}]}`))
		case "/v1/cli/commands/app.workflow.runs.wait/invoke":
			invokeCount++
			var body daemon.InvokeRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body.Input["run-id"] != "RUN-1" {
				t.Fatalf("input = %#v", body.Input)
			}
			if invokeCount < 3 {
				_, _ = fmt.Fprintf(w, `{"ok":true,"output":{"kind":"json","value":{"status":"running","attempt":%d},"continuation":{"state":"pending","retryAfterMs":250}}}`, invokeCount)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"status":"completed","result":"done"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "workflow", "runs", "wait", "--run-id", "RUN-1"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	if invokeCount != 3 {
		t.Fatalf("invokeCount = %d", invokeCount)
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode stdout: %v\n%s", err, stdout.String())
	}
	if output["status"] != "completed" || output["result"] != "done" || strings.Contains(stdout.String(), "attempt") {
		t.Fatalf("output = %#v", output)
	}
}

func TestRunWaitCommandTotalTimeoutReturnsExecutionContinues(t *testing.T) {
	invokeCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"app.workflow.runs.wait","path":["workflow","runs","wait"],"summary":"Wait for run","inputSchema":{"type":"object","properties":{"run-id":{"type":"string"}},"required":["run-id"]},"output":{"defaultMode":"json","json":true},"execution":{"mode":"wait"},"source":{"kind":"app"}}]}`))
		case "/v1/cli/commands/app.workflow.runs.wait/invoke":
			invokeCount++
			var body daemon.InvokeRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if _, leaked := body.Input["timeout-ms"]; leaked {
				t.Fatalf("total timeout leaked into app input: %#v", body.Input)
			}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"run":{"status":"running"}},"continuation":{"state":"pending","retryAfterMs":250}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "workflow", "runs", "wait", "--run-id", "RUN-1", "--timeout-ms", "50"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode stdout: %v\n%s", err, stdout.String())
	}
	if output["reason"] != "wait_timeout" || output["timedOut"] != true || output["executionContinues"] != true {
		t.Fatalf("output = %#v", output)
	}
	last := output["lastResult"].(map[string]any)
	if last["run"].(map[string]any)["status"] != "running" || invokeCount != 1 {
		t.Fatalf("output = %#v invokeCount = %d", output, invokeCount)
	}
}

func TestRunWaitCommandHelpDescribesTotalTimeoutWithoutFollowFlag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/cli/capabilities" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"commands":[{"id":"app.workflow.runs.wait","path":["workflow","runs","wait"],"summary":"Wait for run","output":{"defaultMode":"json","json":true},"execution":{"mode":"wait"},"source":{"kind":"app"}}]}`))
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"workflow", "runs", "wait", "--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "--timeout-ms") || !strings.Contains(stdout.String(), "Maximum total wait") || strings.Contains(stdout.String(), "--follow") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunWaitCommandTotalTimeoutDuringInvokeReturnsObservationNotTransportError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"app.workflow.runs.wait","path":["workflow","runs","wait"],"summary":"Wait for run","output":{"defaultMode":"json","json":true},"execution":{"mode":"wait"},"handlerTimeoutMs":30000,"source":{"kind":"app"}}]}`))
		case "/v1/cli/commands/app.workflow.runs.wait/invoke":
			time.Sleep(150 * time.Millisecond)
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"status":"completed"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "workflow", "runs", "wait", "--timeout-ms=40"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d stderr = %q stdout = %q", code, stderr.String(), stdout.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("decode stdout: %v\n%s", err, stdout.String())
	}
	if output["reason"] != "wait_timeout" || output["executionContinues"] != true {
		t.Fatalf("output = %#v", output)
	}
	if _, hasLastResult := output["lastResult"]; hasLastResult {
		t.Fatalf("output unexpectedly has lastResult: %#v", output)
	}
}

func TestRunWaitCommandCancellationStopsLocalWaitWithoutBusinessCancel(t *testing.T) {
	invoked := make(chan struct{}, 1)
	var cancelRequests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"app.workflow.runs.wait","path":["workflow","runs","wait"],"summary":"Wait for run","output":{"defaultMode":"json","json":true},"execution":{"mode":"wait"},"source":{"kind":"app"}}]}`))
		case "/v1/cli/commands/app.workflow.runs.wait/invoke":
			invoked <- struct{}{}
			_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"status":"running"},"continuation":{"state":"pending","retryAfterMs":1000}}}`))
		case "/v1/cli/commands/app.workflow.runs.cancel/invoke":
			cancelRequests++
			http.Error(w, "unexpected cancel", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	go func() {
		done <- RunWithProgram(ctx, "tutti", []string{"--json", "workflow", "runs", "wait"}, &stdout, &stderr)
	}()
	select {
	case <-invoked:
		cancel()
	case <-time.After(time.Second):
		t.Fatal("wait invocation did not start")
	}
	select {
	case code := <-done:
		if code == 0 {
			t.Fatalf("code = 0 stdout = %q", stdout.String())
		}
	case <-time.After(time.Second):
		t.Fatal("local wait did not stop after cancellation")
	}
	if cancelRequests != 0 {
		t.Fatalf("business cancel requests = %d", cancelRequests)
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
	code := runDefaultProgram(t, []string{"--json", "issue", "task", "run", "complete", "--issue-id", "ISS-1", "--task-id=TASK-1", "--run-id", "RUN-1", "--status", "completed"}, &stdout, &stderr)
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
	code := runDefaultProgram(t, []string{"app", "open", "--app-id", "docs", "--route", "/files", "--param", "path=/tmp/a", "--param", "mode=preview"}, &stdout, &stderr)
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
	code := runDefaultProgram(t, []string{"agent", "send", "SESSION-1", "--prompt", "look", "--image", "/tmp/a.png", "--image", "/tmp/b.jpg"}, &stdout, &stderr)
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
	code := runDefaultProgram(t, []string{"agent", "send", "SESSION-1", "look", "here", "--image", "/tmp/a.png"}, &stdout, &stderr)
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

func TestRunDynamicAgentSendSplitsPositionalPromptBeforeGuidanceFlag(t *testing.T) {
	var invokedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.send","path":["agent","send"],"summary":"Send input","inputSchema":{"type":"object","required":["session-id","prompt"],"properties":{"session-id":{"type":"string"},"prompt":{"type":"string"},"guidance":{"type":"boolean"},"image":{"type":"array","items":{"type":"string"}}}},"output":{"defaultMode":"json","json":true}}]}`))
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
	code := runDefaultProgram(t, []string{"agent", "send", "SESSION-1", "guide", "current", "turn", "--guidance"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["session-id"] != "SESSION-1" || input["prompt"] != "guide current turn" || input["guidance"] != true {
		t.Fatalf("input = %#v", input)
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
	code := runDefaultProgram(t, []string{"agent", "send", "SESSION-1", "please", "run", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	input := invokedBody["input"].(map[string]any)
	if input["session-id"] != "SESSION-1" || input["prompt"] != "please run --help" {
		t.Fatalf("input = %#v", input)
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
	code := runDefaultProgram(t, []string{"issue", "--help"}, &stdout, &stderr)
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
        {"id":"agent-context.agent.list","path":["agent","list"],"summary":"List available agents","output":{"defaultMode":"table","json":true},"source":{"kind":"builtin"}}
      ]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runDefaultProgram(t, []string{"--help"}, &stdout, &stderr)
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
	code := runDefaultProgram(t, []string{"agent", "session", "messages", "--session-id", "SESSION-1", "--json"}, &stdout, &stderr)
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
	if code := runDefaultProgram(t, []string{"issue", "get", "ISS-1"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), `unexpected argument "ISS-1"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunDynamicJSONRejectsInvalidInputWithStructuredError(t *testing.T) {
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
	if code := runDefaultProgram(t, []string{"--json", "issue", "get", "ISS-1"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "invalid_input", `unexpected argument "ISS-1"`)
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunDynamicJSONPreservesDaemonReasonCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.get","path":["agent","get"],"summary":"Get agent session","output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.get/invoke":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"workspace_not_found","reason":"workspace_agent_session_not_found","developerMessage":"agent session was not found"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "agent", "get"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "workspace_agent_session_not_found", "agent session was not found")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunDynamicJSONMapsDaemonInvalidInputToExitCodeTwo(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.get","path":["agent","get"],"summary":"Get agent session","output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.get/invoke":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_request","reason":"malformed_request","developerMessage":"session id is required"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "agent", "get"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "malformed_request", "session id is required")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunDynamicJSONPreservesUnsupportedPermissionReasonAndOmitsFalseRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cli/capabilities":
			_, _ = w.Write([]byte(`{"commands":[{"id":"agent-context.agent.start","path":["agent","start"],"summary":"Start agent","output":{"defaultMode":"json","json":true}}]}`))
		case "/v1/cli/commands/agent-context.agent.start/invoke":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_request","reason":"unsupported_permission_mode_id","developerMessage":"refresh Composer Options and use an advertised permission id","retryable":false}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "agent", "start"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2; stderr = %s", code, stderr.String())
	}
	assertCLIJSONError(t, stdout.Bytes(), "unsupported_permission_mode_id", "refresh Composer Options")
	var envelope map[string]map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("decode CLI error: %v", err)
	}
	if _, present := envelope["error"]["retryable"]; present {
		t.Fatalf("stdout = %s, want false retryable omitted by JSON contract", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunDynamicJSONUnknownCommandIsStructured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/cli/capabilities" {
			_, _ = w.Write([]byte(`{"commands":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	writeEndpoint(t, server.URL, "token-1")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "unknown", "command"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "command_not_found", "unknown command: unknown command")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunManagedModelJSONInvalidInputIsStructured(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := runDefaultProgram(t, []string{"--json", "managed-model", "unknown"}, &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	assertCLIJSONError(t, stdout.Bytes(), "invalid_input", "expected grant exchange, models, credential, or revoke")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func assertCLIJSONError(t *testing.T, content []byte, reasonCode string, message string) {
	t.Helper()
	var envelope cliErrorEnvelope
	if err := json.Unmarshal(content, &envelope); err != nil {
		t.Fatalf("decode CLI error: %v\n%s", err, content)
	}
	if envelope.Error.ReasonCode != reasonCode || !strings.Contains(envelope.Error.Message, message) {
		t.Fatalf("error = %#v, want reasonCode %q message containing %q", envelope.Error, reasonCode, message)
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
