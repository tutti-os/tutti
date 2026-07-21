package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBrowserNodeBackendCallsAuthenticatedDesktopHost(t *testing.T) {
	var gotAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		gotAuthorization = request.Header.Get("Authorization")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"result": map[string]any{"text": "pages"},
		})
	}))
	defer server.Close()

	listenerInfoPath := writeBrowserNodeListenerInfo(t, strings.TrimPrefix(server.URL, "http://"), "secret")
	backend := newBrowserNodeHTTPBackend(listenerInfoPath)
	result, err := backend.Call(context.Background(), "workspace-1", "agent-1", "list_pages", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "pages" || gotAuthorization != "Bearer secret" {
		t.Fatalf("result = %#v, authorization = %q", result, gotAuthorization)
	}
}

func TestBrowserNodeBackendWritesScreenshotToRequestedPath(t *testing.T) {
	png := []byte("png-data")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{
			"result": map[string]any{
				"screenshotData": base64.StdEncoding.EncodeToString(png),
				"text":           "captured",
			},
		})
	}))
	defer server.Close()

	backend := newBrowserNodeHTTPBackend(writeBrowserNodeListenerInfo(t, strings.TrimPrefix(server.URL, "http://"), "secret"))
	screenshotPath := filepath.Join(t.TempDir(), "screenshot.png")
	if _, err := backend.Call(context.Background(), "workspace-1", "agent-1", "take_screenshot", map[string]any{"filePath": screenshotPath}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(screenshotPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(png) {
		t.Fatalf("screenshot = %q, want %q", got, png)
	}
}

func TestBrowserNodeBackendReleasesAgentLease(t *testing.T) {
	var gotPath string
	var gotAgentSessionID string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		var payload struct {
			AgentSessionID string `json:"agentSessionId"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		gotAgentSessionID = payload.AgentSessionID
		_ = json.NewEncoder(response).Encode(map[string]any{
			"result": map[string]any{"text": "released"},
		})
	}))
	defer server.Close()

	backend := newBrowserNodeHTTPBackend(writeBrowserNodeListenerInfo(t, strings.TrimPrefix(server.URL, "http://"), "secret"))
	if err := backend.ReleaseAgent(context.Background(), "agent-1"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/release-agent" || gotAgentSessionID != "agent-1" {
		t.Fatalf("path = %q, agentSessionId = %q", gotPath, gotAgentSessionID)
	}
}

func TestBrowserNodeBackendRejectsNonLoopbackListener(t *testing.T) {
	backend := newBrowserNodeHTTPBackend(writeBrowserNodeListenerInfo(t, "10.0.0.1:1234", "secret"))
	_, err := backend.Call(context.Background(), "workspace-1", "agent-1", "list_pages", nil)
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("err = %v, want loopback rejection", err)
	}
}

func writeBrowserNodeListenerInfo(t *testing.T, address, token string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "listener.json")
	body, err := json.Marshal(browserNodeListenerInfo{Address: address, Token: token, Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
