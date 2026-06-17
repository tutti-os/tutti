package daemon

import (
	"context"
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
}
