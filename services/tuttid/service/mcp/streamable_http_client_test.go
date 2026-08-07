package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestStreamableHTTPClientCarriesHostSessionAndMCPTransportSession(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "session_id=user-session" {
			t.Errorf("Cookie = %q", request.Header.Get("Cookie"))
		}
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if request.Method == http.MethodDelete {
			if request.Header.Get("Mcp-Session-Id") != "mcp-session-1" {
				t.Errorf("delete session = %q", request.Header.Get("Mcp-Session-Id"))
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		methods = append(methods, message.Method)
		mu.Unlock()
		if message.Method == "notifications/initialized" {
			if request.Header.Get("Mcp-Session-Id") != "mcp-session-1" {
				t.Errorf("notification session = %q", request.Header.Get("Mcp-Session-Id"))
			}
			response.WriteHeader(http.StatusAccepted)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Mcp-Session-Id", "mcp-session-1")
		_, _ = fmt.Fprintf(response, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18"}}`, message.ID)
	}))
	defer server.Close()

	client, err := NewStreamableHTTPClient(StreamableHTTPClientConfig{
		Endpoint: server.URL, AllowedHosts: []string{"127.0.0.1"},
		HTTPClient: server.Client(), Timeout: time.Second, MaxResponseBytes: 4096,
		AuthorizeRequest: func(request *http.Request) error {
			request.Header.Set("Cookie", "session_id=user-session")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Call(context.Background(), "initialize", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := client.Notify(context.Background(), "notifications/initialized", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(methods) != 2 || methods[0] != "initialize" || methods[1] != "notifications/initialized" {
		t.Fatalf("methods = %#v", methods)
	}
}

func TestStreamableHTTPClientReadsMatchingSSEMessageAndRejectsRedirects(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = response.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n"))
		_, _ = response.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n"))
	}))
	defer server.Close()
	client, err := NewStreamableHTTPClient(StreamableHTTPClientConfig{
		Endpoint: server.URL, AllowedHosts: []string{"127.0.0.1"}, HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Call(context.Background(), "tools/list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"tools":[]}` {
		t.Fatalf("result = %s", result)
	}

	redirectTarget := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("redirect target must not be reached")
	}))
	defer redirectTarget.Close()
	redirector := httptest.NewTLSServer(http.RedirectHandler(redirectTarget.URL, http.StatusTemporaryRedirect))
	defer redirector.Close()
	redirectClient, err := NewStreamableHTTPClient(StreamableHTTPClientConfig{
		Endpoint: redirector.URL, AllowedHosts: []string{"127.0.0.1"}, HTTPClient: redirector.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := redirectClient.Call(context.Background(), "tools/list", map[string]any{}); err == nil {
		t.Fatal("expected redirect to fail")
	}
}
