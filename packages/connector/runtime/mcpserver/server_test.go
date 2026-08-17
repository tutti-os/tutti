package mcpserver_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	connectormcpserver "github.com/tutti-os/tutti/packages/connector/runtime/mcpserver"
)

const protocolVersion = "2026-07-28"

type scopedRouterStub struct {
	toolsScope connectormcpserver.RequestScope
	callScope  connectormcpserver.RequestScope
	contextOK  bool
}

func (router *scopedRouterStub) Tools(ctx context.Context, scope connectormcpserver.RequestScope) ([]implementationhost.MCPTool, error) {
	router.toolsScope = scope
	contextScope, ok := connectormcpserver.RequestScopeFromContext(ctx)
	router.contextOK = ok && contextScope == scope
	return []implementationhost.MCPTool{{
		Name: "documents_search", InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
	}}, nil
}

func (router *scopedRouterStub) CallValidated(
	ctx context.Context,
	scope connectormcpserver.RequestScope,
	_ string,
	_ map[string]any,
	validate func(implementationhost.MCPTool) error,
) (json.RawMessage, error) {
	router.callScope = scope
	contextScope, ok := connectormcpserver.RequestScopeFromContext(ctx)
	router.contextOK = router.contextOK && ok && contextScope == scope
	tool := implementationhost.MCPTool{Name: "documents_search", InputSchema: map[string]any{"type": "object", "properties": map[string]any{}}}
	if validate != nil {
		if err := validate(tool); err != nil {
			return nil, err
		}
	}
	return json.RawMessage(`{"resultType":"complete","content":[]}`), nil
}

func (*scopedRouterStub) Subscribe(connectormcpserver.RequestScope) (<-chan struct{}, func()) {
	updates := make(chan struct{})
	return updates, func() { close(updates) }
}

func TestSessionRouterReceivesBearerDerivedScope(t *testing.T) {
	router := &scopedRouterStub{}
	server, err := connectormcpserver.Start(connectormcpserver.Config{SessionRouter: router})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	binding, err := server.Bind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 7,
	})
	if err != nil {
		t.Fatal(err)
	}
	listing := postModernRPC(t, binding.URL, binding.Headers["Authorization"], 1, "tools/list", map[string]any{})
	listing.Body.Close()
	wantScope := connectormcpserver.RequestScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 7,
	}
	if listing.StatusCode != http.StatusOK || router.toolsScope != wantScope || !router.contextOK {
		t.Fatalf("tools scope=%#v contextOK=%v status=%d", router.toolsScope, router.contextOK, listing.StatusCode)
	}
	call := postModernRPC(t, binding.URL, binding.Headers["Authorization"], 2, "tools/call", map[string]any{
		"name": "documents_search", "arguments": map[string]any{},
	})
	call.Body.Close()
	if call.StatusCode != http.StatusOK || router.callScope != router.toolsScope || !router.contextOK {
		t.Fatalf("call scope=%#v contextOK=%v status=%d", router.callScope, router.contextOK, call.StatusCode)
	}
}

func TestServerServesProviderNativeMCP(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	binding, err := server.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	initialized := postProviderRPC(t, binding.URL, binding.Headers["Authorization"], 1, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "codex", "version": "1"},
	})
	defer initialized.Body.Close()
	var initializePayload struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if initialized.StatusCode != http.StatusOK || json.NewDecoder(initialized.Body).Decode(&initializePayload) != nil ||
		initializePayload.Result.ProtocolVersion != "2025-06-18" || initializePayload.Result.ServerInfo.Name != "connector" {
		t.Fatalf("initialize status=%d payload=%#v", initialized.StatusCode, initializePayload)
	}

	listing := postProviderRPC(t, binding.URL, binding.Headers["Authorization"], 2, "tools/list", map[string]any{})
	defer listing.Body.Close()
	var listPayload struct {
		Result struct {
			Tools []implementationhost.MCPTool `json:"tools"`
		} `json:"result"`
	}
	if listing.StatusCode != http.StatusOK || json.NewDecoder(listing.Body).Decode(&listPayload) != nil || listPayload.Result.Tools == nil {
		t.Fatalf("tools/list status=%d payload=%#v", listing.StatusCode, listPayload)
	}

	resources := postProviderRPC(t, binding.URL, binding.Headers["Authorization"], 3, "resources/list", map[string]any{})
	defer resources.Body.Close()
	var resourcesPayload struct {
		Result struct {
			Resources []any `json:"resources"`
		} `json:"result"`
	}
	if resources.StatusCode != http.StatusOK || json.NewDecoder(resources.Body).Decode(&resourcesPayload) != nil || resourcesPayload.Result.Resources == nil {
		t.Fatalf("resources/list status=%d payload=%#v", resources.StatusCode, resourcesPayload)
	}
}

func TestBindRejectsPartialInvocationScopeAndLegacyBindingRemainsCompatible(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	invalid := []connectormcpserver.BindingScope{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", InvocationID: "invocation-1"},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", InvocationGeneration: 1},
	}
	for _, scope := range invalid {
		if _, err := server.Bind(scope); err == nil {
			t.Fatalf("partial Invocation scope was accepted: %#v", scope)
		}
	}
	if _, err := server.Binding("workspace-1", "session-1"); err != nil {
		t.Fatalf("legacy Session binding failed: %v", err)
	}
}

func TestServerIssuesSessionScopedBindingAndServesModernMCP(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Close(ctx)
	})
	binding, err := server.Binding("workspace-1", "session-1")
	if err != nil || binding.Name != "connector" || binding.Type != "http" || !strings.HasPrefix(binding.URL, "http://127.0.0.1:") {
		t.Fatalf("binding = %#v, err = %v", binding, err)
	}
	if response := postModernRPC(t, binding.URL, "", 1, "server/discover", map[string]any{}); response.StatusCode != http.StatusUnauthorized {
		response.Body.Close()
		t.Fatalf("unauthorized status = %d", response.StatusCode)
	}
	discover := postModernRPC(t, binding.URL, binding.Headers["Authorization"], 2, "server/discover", map[string]any{})
	defer discover.Body.Close()
	var discovered struct {
		Result struct {
			ResultType        string   `json:"resultType"`
			SupportedVersions []string `json:"supportedVersions"`
		} `json:"result"`
	}
	if discover.StatusCode != http.StatusOK || json.NewDecoder(discover.Body).Decode(&discovered) != nil ||
		discovered.Result.ResultType != "complete" || len(discovered.Result.SupportedVersions) != 1 || discovered.Result.SupportedVersions[0] != protocolVersion {
		t.Fatalf("server/discover status=%d payload=%#v", discover.StatusCode, discovered)
	}
	listing := postModernRPC(t, binding.URL, binding.Headers["Authorization"], 3, "tools/list", map[string]any{})
	defer listing.Body.Close()
	var payload struct {
		Result struct {
			ResultType string                       `json:"resultType"`
			Tools      []implementationhost.MCPTool `json:"tools"`
		} `json:"result"`
	}
	if listing.StatusCode != http.StatusOK || json.NewDecoder(listing.Body).Decode(&payload) != nil ||
		payload.Result.ResultType != "complete" || len(payload.Result.Tools) != 0 {
		t.Fatalf("tools/list status=%d payload=%#v", listing.StatusCode, payload)
	}
	server.Revoke("workspace-1", "session-1")
	if response := postModernRPC(t, binding.URL, binding.Headers["Authorization"], 4, "tools/list", map[string]any{}); response.StatusCode != http.StatusUnauthorized {
		response.Body.Close()
		t.Fatalf("revoked status = %d", response.StatusCode)
	}
}

func TestBindingReplacementAndRevokeAllInvalidateTokens(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	first, err := server.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	response := postModernRPC(t, first.URL, first.Headers["Authorization"], 1, "tools/list", map[string]any{})
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replaced token status=%d", response.StatusCode)
	}
	response = postModernRPC(t, second.URL, second.Headers["Authorization"], 2, "tools/list", map[string]any{})
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("replacement token status=%d", response.StatusCode)
	}
	server.RevokeAll()
	response = postModernRPC(t, second.URL, second.Headers["Authorization"], 3, "tools/list", map[string]any{})
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoke-all token status=%d", response.StatusCode)
	}
}

func TestServerRejectsLegacyMethodsInvalidOriginAndHeaderMismatch(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	binding, err := server.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, binding.URL, nil)
	request.Header.Set("Authorization", binding.Headers["Authorization"])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", response.StatusCode)
	}

	request = modernRPCRequest(t, binding.URL, binding.Headers["Authorization"], 1, "tools/list", map[string]any{})
	request.Header.Set("Origin", "https://attacker.example")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("invalid-origin status=%d", response.StatusCode)
	}

	request = modernRPCRequest(t, binding.URL, binding.Headers["Authorization"], 2, "tools/list", map[string]any{})
	request.Header.Set("Mcp-Method", "tools/call")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("header-mismatch status=%d", response.StatusCode)
	}
}

func TestSubscriptionIsAcknowledgedAndCompletesOnBindingRevocation(t *testing.T) {
	server, err := connectormcpserver.Start(connectormcpserver.Config{Registry: implementationhost.NewMCPRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	binding, err := server.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	request := modernRPCRequest(t, binding.URL, binding.Headers["Authorization"], 7, "subscriptions/listen", map[string]any{
		"notifications": map[string]any{"toolsListChanged": true},
	})
	requestContext, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	response, err := http.DefaultClient.Do(request.WithContext(requestContext))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("subscription response status=%d content-type=%q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	acknowledged := readSSEPayload(t, reader)
	if acknowledged["method"] != "notifications/subscriptions/acknowledged" {
		t.Fatalf("subscription acknowledgement = %#v", acknowledged)
	}

	server.Revoke("workspace-1", "session-1")
	completed := readSSEPayload(t, reader)
	result, _ := completed["result"].(map[string]any)
	if completed["id"] != float64(7) || result["resultType"] != "complete" {
		t.Fatalf("subscription completion = %#v", completed)
	}
}

func readSSEPayload(t *testing.T, reader *bufio.Reader) map[string]any {
	t.Helper()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE payload: %v", err)
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data: "))), &payload); err != nil {
			t.Fatalf("decode SSE payload: %v", err)
		}
		return payload
	}
}

func postModernRPC(t *testing.T, endpoint, authorization string, id int, method string, params map[string]any) *http.Response {
	t.Helper()
	request := modernRPCRequest(t, endpoint, authorization, id, method, params)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func postProviderRPC(t *testing.T, endpoint, authorization string, id int, method string, params map[string]any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func modernRPCRequest(t *testing.T, endpoint, authorization string, id int, method string, params map[string]any) *http.Request {
	t.Helper()
	if params == nil {
		params = map[string]any{}
	}
	params["_meta"] = map[string]any{
		"io.modelcontextprotocol/protocolVersion": protocolVersion,
		"io.modelcontextprotocol/clientInfo": map[string]any{
			"name": "connector-mcp-test", "version": "1",
		},
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	}
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", protocolVersion)
	request.Header.Set("Mcp-Method", method)
	if name, _ := params["name"].(string); name != "" {
		request.Header.Set("Mcp-Name", name)
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	return request
}
