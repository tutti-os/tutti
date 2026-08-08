package connectormcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
)

func TestServerIssuesSessionScopedBindingAndServesEmptyNativeToolList(t *testing.T) {
	registry := implementationhost.NewMCPRegistry()
	server, err := Start(Config{Registry: registry, TokenTTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Close(ctx)
	})
	binding, err := server.Binding("workspace-1", "session-1", nil)
	if err != nil || binding.Name != "connector" || binding.Type != "http" || !strings.HasPrefix(binding.URL, "http://127.0.0.1:") {
		t.Fatalf("binding = %#v, err = %v", binding, err)
	}
	if response := postRPC(t, binding.URL, "", "", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}); response.StatusCode != http.StatusUnauthorized {
		response.Body.Close()
		t.Fatalf("unauthorized status = %d", response.StatusCode)
	}
	initialize := postRPC(t, binding.URL, binding.Headers["Authorization"], "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{},
	})
	defer initialize.Body.Close()
	if initialize.StatusCode != http.StatusOK || initialize.Header.Get("Mcp-Session-Id") == "" {
		t.Fatalf("initialize status=%d session=%q", initialize.StatusCode, initialize.Header.Get("Mcp-Session-Id"))
	}
	var initialized map[string]any
	if err := json.NewDecoder(initialize.Body).Decode(&initialized); err != nil {
		t.Fatal(err)
	}
	sessionID := initialize.Header.Get("Mcp-Session-Id")
	initializedNotification := postRPC(t, binding.URL, binding.Headers["Authorization"], sessionID, map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized",
	})
	initializedNotification.Body.Close()
	if initializedNotification.StatusCode != http.StatusAccepted {
		t.Fatalf("initialized notification status=%d", initializedNotification.StatusCode)
	}
	listing := postRPC(t, binding.URL, binding.Headers["Authorization"], sessionID, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	defer listing.Body.Close()
	var payload struct {
		Result struct {
			Tools []implementationhost.MCPTool `json:"tools"`
		} `json:"result"`
	}
	if listing.StatusCode != http.StatusOK || json.NewDecoder(listing.Body).Decode(&payload) != nil || len(payload.Result.Tools) != 0 {
		t.Fatalf("tools/list status=%d payload=%#v", listing.StatusCode, payload)
	}
	server.Revoke("workspace-1", "session-1")
	if response := postRPC(t, binding.URL, binding.Headers["Authorization"], sessionID, map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/list",
	}); response.StatusCode != http.StatusUnauthorized {
		response.Body.Close()
		t.Fatalf("revoked status = %d", response.StatusCode)
	}
}

func TestBindingReplacementRevokesPreviousSessionToken(t *testing.T) {
	server, err := Start(Config{Registry: implementationhost.NewMCPRegistry(), TokenTTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	first, err := server.Binding("workspace-1", "session-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.Binding("workspace-1", "session-1", []string{})
	if err != nil {
		t.Fatal(err)
	}
	response := postRPC(t, first.URL, first.Headers["Authorization"], "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
	})
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replaced token status=%d", response.StatusCode)
	}
	response = postRPC(t, second.URL, second.Headers["Authorization"], "", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "initialize",
	})
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("replacement token status=%d", response.StatusCode)
	}
}

func postRPC(t *testing.T, endpoint, authorization, sessionID string, payload map[string]any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if sessionID != "" {
		request.Header.Set("Mcp-Session-Id", sessionID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
