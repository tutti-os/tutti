package daemon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewClientUsesStartupFriendlyTimeout(t *testing.T) {
	client, err := NewClient(Endpoint{Addr: "127.0.0.1:1", Token: "token-1"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	if client.httpClient.Timeout < 30*time.Second {
		t.Fatalf("timeout = %s, want at least 30s", client.httpClient.Timeout)
	}
}

func TestInvokeWithTimeoutOverridesDefaultClientBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(40 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"output":{"kind":"json","value":{"ok":true}}}`))
	}))
	defer server.Close()

	client := &Client{
		baseURL: server.URL,
		token:   "token-1",
		httpClient: &http.Client{
			Timeout: 10 * time.Millisecond,
		},
	}
	response, err := client.InvokeWithTimeout(context.Background(), "wait.command", InvokeRequest{}, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("InvokeWithTimeout() error = %v", err)
	}
	if response.Output == nil || response.Output.Value["ok"] != true {
		t.Fatalf("response = %#v", response)
	}
	if client.httpClient.Timeout != 10*time.Millisecond {
		t.Fatalf("shared client timeout mutated to %s", client.httpClient.Timeout)
	}
}

func TestDoJSONReportsTimeoutSeparatelyFromUnreachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"tuttid","status":"ok"}`))
	}))
	defer server.Close()

	client := &Client{
		baseURL: server.URL,
		token:   "token-1",
		httpClient: &http.Client{
			Timeout: 10 * time.Millisecond,
		},
	}

	var result HealthStatus
	err := client.DoJSON(context.Background(), http.MethodGet, healthPath, nil, &result)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "daemon request timed out") {
		t.Fatalf("error = %q, want timeout message", err.Error())
	}
	if strings.Contains(err.Error(), "daemon is not reachable") {
		t.Fatalf("error = %q, should not report daemon as unreachable", err.Error())
	}
	details, ok := RequestErrorDetails(err)
	if !ok || details.ReasonCode != "daemon_request_timed_out" || !details.Retryable {
		t.Fatalf("details = %#v ok=%t", details, ok)
	}
}

func TestDoJSONPreservesStructuredDaemonError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"workspace_not_found","reason":"workspace_agent_session_not_found","retryable":true,"developerMessage":"agent session was not found","correlationId":"corr-1"}}`))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL, token: "token-1", httpClient: server.Client()}
	err := client.DoJSON(context.Background(), http.MethodGet, healthPath, nil, &HealthStatus{})
	details, ok := RequestErrorDetails(err)
	if !ok {
		t.Fatalf("RequestErrorDetails(%v) did not match", err)
	}
	if details.ReasonCode != "workspace_agent_session_not_found" || details.Message != "agent session was not found" ||
		!details.Retryable || details.CorrelationID != "corr-1" || details.StatusCode != http.StatusNotFound {
		t.Fatalf("details = %#v", details)
	}
}

func TestDaemonRequestErrorKeepsPlainUnreachableOutsideAgent(t *testing.T) {
	t.Setenv("TUTTI_AGENT_SESSION_ID", "")
	t.Setenv("TUTTI_AGENT_ROUTING", "")

	err := daemonRequestError(errors.New("dial tcp failed"))

	if got, want := err.Error(), "daemon is not reachable"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}

func TestDaemonRequestErrorHintsLocalDaemonAccessInsideAgent(t *testing.T) {
	t.Setenv("TUTTI_AGENT_SESSION_ID", "session-1")
	t.Setenv("TUTTI_AGENT_ROUTING", "")

	err := daemonRequestError(errors.New("dial tcp failed"))
	message := err.Error()

	for _, expected := range []string{
		"daemon is not reachable from this agent execution environment",
		"execution environment with localhost/IPC access",
		"localhost/IPC",
	} {
		if !strings.Contains(message, expected) {
			t.Fatalf("error = %q, want to contain %q", message, expected)
		}
	}
	if strings.Contains(message, "sandbox_permissions=require_escalated") {
		t.Fatalf("error = %q, should not contain provider-specific Codex escalation syntax", message)
	}
}
