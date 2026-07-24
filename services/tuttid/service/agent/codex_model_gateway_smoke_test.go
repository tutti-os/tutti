package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelgatewayservice "github.com/tutti-os/tutti/services/tuttid/service/modelgateway"
)

// TestCodexModelPlanGatewayCLISmoke is an opt-in real Codex CLI smoke test.
// It resolves a WorkspaceAgent's immutable Model Plan, registers the gateway
// through the agent service, prepares the actual session Codex home, drives
// two persisted turns, and makes the first turn execute exec_command. The
// Chat-only upstream is deterministic so the test does not consume a
// developer credential or model quota.
func TestCodexModelPlanGatewayCLISmoke(t *testing.T) {
	if os.Getenv("TUTTI_CODEX_MODEL_GATEWAY_SMOKE") != "1" {
		t.Skip("set TUTTI_CODEX_MODEL_GATEWAY_SMOKE=1 to run the real Codex CLI smoke test")
	}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatalf("find codex CLI: %v", err)
	}

	var mu sync.Mutex
	requestCount := 0
	sawToolOutput := false
	sawDeveloperRole := false
	sawSystemPastHead := false
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var chat map[string]any
		if err := json.NewDecoder(request.Body).Decode(&chat); err != nil {
			http.Error(writer, "invalid Chat request", http.StatusBadRequest)
			return
		}
		messages, _ := chat["messages"].([]any)
		requestSawToolOutput := false
		requestSawDeveloperRole := false
		requestSawSystemPastHead := false
		for index, encoded := range messages {
			message, _ := encoded.(map[string]any)
			if message["role"] == "tool" {
				requestSawToolOutput = true
			}
			if message["role"] == "developer" {
				requestSawDeveloperRole = true
			}
			if index > 0 && message["role"] == "system" {
				requestSawSystemPastHead = true
			}
		}
		mu.Lock()
		if requestSawToolOutput {
			sawToolOutput = true
		}
		if requestSawDeveloperRole {
			sawDeveloperRole = true
		}
		if requestSawSystemPastHead {
			sawSystemPastHead = true
		}
		requestCount++
		current := requestCount
		paths = append(paths, request.URL.Path)
		mu.Unlock()

		writer.Header().Set("Content-Type", "text/event-stream")
		flusher := writer.(http.Flusher)
		writeChunk := func(payload string) {
			_, _ = io.WriteString(writer, "data: "+payload+"\n\n")
			flusher.Flush()
		}
		switch current {
		case 1:
			writeChunk(`{"id":"chat-smoke-1","model":"smoke-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_smoke","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"printf codex-gateway-tool-ok\"}"}}]}}]}`)
			writeChunk(`{"id":"chat-smoke-1","model":"smoke-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)
		case 2:
			writeChunk(`{"id":"chat-smoke-2","model":"smoke-model","choices":[{"index":0,"delta":{"content":"FIRST_TURN_OK"},"finish_reason":"stop"}]}`)
		default:
			writeChunk(`{"id":"chat-smoke-3","model":"smoke-model","choices":[{"index":0,"delta":{"content":"SECOND_TURN_OK"},"finish_reason":"stop"}]}`)
		}
		writeChunk(`{"id":"chat-smoke-usage","model":"smoke-model","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`)
		_, _ = io.WriteString(writer, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	var gatewayLogs bytes.Buffer
	gateway, err := modelgatewayservice.New(modelgatewayservice.Config{
		Logger: slog.New(slog.NewJSONHandler(&gatewayLogs, &slog.HandlerOptions{
			Level: slog.LevelDebug,
		})),
	})
	if err != nil {
		t.Fatalf("start model gateway: %v", err)
	}
	defer func() {
		if err := gateway.Close(); err != nil {
			t.Errorf("close model gateway: %v", err)
		}
	}()
	// Keep installed plugins out of the smoke while retaining Codex's default
	// hosted tool registrations. The gateway must filter those registrations
	// without a version-specific Codex config override.
	t.Setenv("HOME", t.TempDir())
	preparer := runtimeprep.NewDefaultPreparer(t.TempDir())
	preparer.CommandCatalog = modelGatewaySmokeCommandCatalog{}
	service := &Service{
		RuntimePreparer: preparer,
		ModelGateway:    gateway,
	}
	plan := modelplanbiz.Plan{
		ID:           "model-plan-smoke",
		WorkspaceID:  "smoke-workspace",
		Revision:     1,
		Name:         "Chat-only smoke plan",
		TemplateKind: modelplanbiz.TemplateCustom,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		APIKey:       "smoke-upstream-key",
		BaseURL:      upstream.URL,
		Models:       []modelplanbiz.Model{{ID: "smoke-model", Name: "Smoke Model"}},
		DefaultModel: "smoke-model",
		Enabled:      true,
	}
	resolution, err := resolveProvidedModelPlan(
		"codex",
		"workspace-agent:smoke",
		plan,
		"smoke-model",
		"smoke-model",
	)
	if err != nil {
		t.Fatalf("resolve Model Plan: %v", err)
	}
	workdir := t.TempDir()
	prepared, err := service.prepareRuntimeWithModelEndpoint(
		context.Background(),
		"smoke-workspace",
		workdir,
		CreateSessionInput{
			AgentSessionID: "smoke-session",
			AgentTargetID:  "workspace-agent:smoke",
			Provider:       "codex",
			Model:          stringPointer("smoke-model"),
		},
		resolution.Endpoint,
	)
	if err != nil {
		t.Fatalf("prepare custom Agent runtime: %v", err)
	}
	if strings.Contains(strings.Join(prepared.Env, "\n"), plan.APIKey) {
		t.Fatal("prepared Codex environment contains the upstream Model Plan credential")
	}
	gatewayBaseURL, gatewayToken := preparedGatewayEndpoint(t, prepared.Env)

	firstOutput := filepath.Join(t.TempDir(), "first-output.txt")
	firstStdout := runModelGatewayCodexCommand(
		t,
		codexPath,
		workdir,
		prepared.Env,
		"exec", "--json", "--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox", "-C", workdir, "-o", firstOutput,
		"Run the requested tool, then return the upstream final answer exactly.",
	)
	threadID := modelGatewaySmokeThreadID(t, firstStdout)
	firstMessage, err := os.ReadFile(firstOutput)
	if err != nil {
		t.Fatalf("read first Codex output: %v", err)
	}
	if !strings.Contains(string(firstMessage), "FIRST_TURN_OK") {
		t.Fatalf("first output = %q\nstdout:\n%s", firstMessage, firstStdout)
	}

	secondOutput := filepath.Join(t.TempDir(), "second-output.txt")
	secondStdout := runModelGatewayCodexCommand(
		t,
		codexPath,
		workdir,
		prepared.Env,
		"exec", "resume", "--json", "--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox", "-o", secondOutput, threadID,
		"Return the upstream second-turn answer exactly.",
	)
	secondMessage, err := os.ReadFile(secondOutput)
	if err != nil {
		t.Fatalf("read second Codex output: %v", err)
	}
	if !strings.Contains(string(secondMessage), "SECOND_TURN_OK") {
		t.Fatalf("second output = %q\nstdout:\n%s", secondMessage, secondStdout)
	}

	mu.Lock()
	if requestCount < 3 || !sawToolOutput || sawDeveloperRole || sawSystemPastHead {
		t.Fatalf(
			"upstream requests = %d, saw tool output = %v, saw developer role = %v, saw system past head = %v",
			requestCount,
			sawToolOutput,
			sawDeveloperRole,
			sawSystemPastHead,
		)
	}
	for _, path := range paths {
		if path != "/v1/chat/completions" {
			t.Fatalf("upstream paths = %#v", paths)
		}
	}
	mu.Unlock()
	if logs := gatewayLogs.String(); !strings.Contains(logs, `"event":"model_gateway.tools.filtered"`) ||
		!strings.Contains(logs, "web_search") {
		t.Fatalf("gateway did not record filtering Codex's hosted web_search registration:\n%s", logs)
	}

	if err := service.cleanupRuntime(context.Background(), "smoke-workspace", "smoke-session"); err != nil {
		t.Fatalf("cleanup custom Agent runtime: %v", err)
	}
	assertPreparedGatewayTokenRevoked(t, gatewayBaseURL, gatewayToken)
}

type modelGatewaySmokeCommandCatalog struct{}

func (modelGatewaySmokeCommandCatalog) Capabilities(
	context.Context,
	runtimeprep.CommandContext,
) []runtimeprep.CommandCapability {
	return nil
}

func runModelGatewayCodexCommand(
	t *testing.T,
	codexPath string,
	workdir string,
	runtimeEnv []string,
	args ...string,
) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, codexPath, args...)
	command.Dir = workdir
	command.Env = mergeModelGatewaySmokeEnv(os.Environ(), runtimeEnv)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("codex %s failed: %v\nstdout:\n%s\nstderr:\n%s", strings.Join(args, " "), err, stdout.String(), stderr.String())
	}
	return stdout.String()
}

func mergeModelGatewaySmokeEnv(base []string, overlay []string) []string {
	overridden := make(map[string]struct{}, len(overlay))
	for _, entry := range overlay {
		key, _, found := strings.Cut(entry, "=")
		if found {
			overridden[key] = struct{}{}
		}
	}
	result := make([]string, 0, len(base)+len(overlay))
	for _, entry := range base {
		key, _, found := strings.Cut(entry, "=")
		if found {
			if _, exists := overridden[key]; exists {
				continue
			}
		}
		result = append(result, entry)
	}
	return append(result, overlay...)
}

func modelGatewaySmokeThreadID(t *testing.T, output string) string {
	t.Helper()
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		var event map[string]any
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		if event["type"] == "thread.started" {
			threadID, _ := event["thread_id"].(string)
			if threadID != "" {
				return threadID
			}
		}
	}
	t.Fatalf("thread.started missing from Codex output:\n%s", output)
	return ""
}

func preparedGatewayEndpoint(t *testing.T, runtimeEnv []string) (string, string) {
	t.Helper()
	var baseURL string
	var token string
	for _, entry := range runtimeEnv {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		switch key {
		case "CODEX_HOME":
			config, err := os.ReadFile(filepath.Join(value, "config.toml"))
			if err == nil {
				for _, line := range strings.Split(string(config), "\n") {
					trimmedLine := strings.TrimSpace(line)
					if strings.HasPrefix(trimmedLine, "base_url = ") {
						baseURL = strings.Trim(strings.TrimPrefix(trimmedLine, "base_url = "), `"`)
					}
				}
			}
		case "TUTTI_MODEL_PLAN_API_KEY":
			token = value
		}
	}
	if baseURL == "" || token == "" {
		t.Fatalf("prepared gateway endpoint missing from runtime environment")
	}
	return baseURL, token
}

func assertPreparedGatewayTokenRevoked(t *testing.T, baseURL string, token string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+"/responses", strings.NewReader(`{"model":"smoke-model","input":"x"}`))
	if err != nil {
		t.Fatalf("create revoked-token request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("call gateway with revoked token: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked gateway token status = %d, want 401", response.StatusCode)
	}
}
