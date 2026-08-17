package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestModernStreamableHTTPClientSendsRequiredMetadataAndToolHeaders(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.Header.Get("MCP-Protocol-Version") != ModernProtocolVersion ||
			request.Header.Get("Mcp-Method") != "tools/call" || request.Header.Get("Tutti-Connector-Version") != "1.2.3" {
			t.Errorf("request metadata = %s %#v", request.Method, request.Header)
		}
		if request.Header.Get("Mcp-Name") != "document.search" || request.Header.Get("Mcp-Param-Region") != "ap-singapore" {
			t.Errorf("tool metadata = %#v", request.Header)
		}
		var envelope struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&envelope); err != nil {
			t.Error(err)
			return
		}
		meta, _ := envelope.Params["_meta"].(map[string]any)
		if meta["io.modelcontextprotocol/protocolVersion"] != ModernProtocolVersion || meta["sh.tutti/connectorVersion"] != "1.2.3" {
			t.Errorf("request _meta = %#v", meta)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"jsonrpc": "2.0", "id": envelope.ID, "result": map[string]any{"resultType": "complete"}})
	}))
	defer server.Close()

	client := newModernTestClient(t, server, "1.2.3")
	if err := client.RegisterTool("document.search", map[string]any{
		"type": "object", "properties": map[string]any{
			"region": map[string]any{"type": "string", "x-mcp-header": "Region"},
			"query":  map[string]any{"type": "string"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := client.Call(context.Background(), "tools/call", map[string]any{
		"name": "document.search", "arguments": map[string]any{"region": "ap-singapore", "query": "plan"},
	})
	if err != nil || !strings.Contains(string(result), `"resultType":"complete"`) {
		t.Fatalf("result=%s err=%v", result, err)
	}
}

func TestModernStreamableHTTPClientEncodesUnsafeMCPNameAndReadsSSEIncrementally(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Mcp-Name") != "=?base64?5paH5qGjLuaQnOe0og==?=" {
			t.Errorf("Mcp-Name = %q", request.Header.Get("Mcp-Name"))
		}
		var envelope struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.NewDecoder(request.Body).Decode(&envelope)
		response.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := response.(http.Flusher)
		_, _ = io.WriteString(response, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(response, `data: {"jsonrpc":"2.0","id":`+string(envelope.ID)+`,"result":{"resultType":"complete","content":[]}}`+"\n\n")
		flusher.Flush()
	}))
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	if err := client.RegisterTool("文档.搜索", map[string]any{"type": "object"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Call(context.Background(), "tools/call", map[string]any{"name": "文档.搜索", "arguments": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
}

func TestModernStreamableHTTPClientPreservesJSONRPCErrorOnHTTPFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var envelope struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.NewDecoder(request.Body).Decode(&envelope)
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusPreconditionRequired)
		_ = json.NewEncoder(response).Encode(map[string]any{"jsonrpc": "2.0", "id": envelope.ID, "error": map[string]any{"code": -33001, "message": "authorization required"}})
	}))
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	_, err := client.Call(context.Background(), "tools/list", map[string]any{})
	var httpErr *ModernHTTPError
	var rpcErr *RPCError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusPreconditionRequired ||
		!errors.As(err, &rpcErr) || rpcErr.Code != -33001 {
		t.Fatalf("error = %#v", err)
	}
}

func TestModernStreamableHTTPClientPreservesHTTPFailureBeforeContentTypeValidation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		response.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(response, "Connector is not installed for this release\n")
	}))
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	_, err := client.Call(context.Background(), "tools/list", map[string]any{})
	var httpErr *ModernHTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusConflict ||
		string(httpErr.Body) != "Connector is not installed for this release\n" {
		t.Fatalf("error = %#v", err)
	}
}

func TestModernStreamableHTTPClientRejectsInvalidToolHeaderAnnotation(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	if err := client.RegisterTool("unsafe", map[string]any{
		"type": "object", "items": map[string]any{"type": "string", "x-mcp-header": "Bad"},
	}); err == nil {
		t.Fatal("invalid x-mcp-header annotation was accepted")
	}
}

func TestModernStreamableHTTPClientReplacesDynamicToolMetadata(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	if err := client.RegisterTool("removed", map[string]any{"type": "object"}); err != nil {
		t.Fatal(err)
	}
	if err := client.ReplaceTools(map[string]map[string]any{"current": {
		"type": "object", "properties": map[string]any{"region": map[string]any{"type": "string", "x-mcp-header": "Region"}},
	}}); err != nil {
		t.Fatal(err)
	}
	client.mu.RLock()
	_, removed := client.toolHeaders["removed"]
	current := client.toolHeaders["current"]
	client.mu.RUnlock()
	if removed || len(current) != 1 || current[0].name != "Region" {
		t.Fatalf("tool headers = %#v", client.toolHeaders)
	}
}

func TestModernStreamableHTTPClientCloseDoesNotSendDelete(t *testing.T) {
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	defer server.Close()
	client := newModernTestClient(t, server, "1.0.0")
	if err := client.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("close made %d HTTP calls", calls)
	}
}

func newModernTestClient(t *testing.T, server *httptest.Server, connectorVersion string) *ModernStreamableHTTPClient {
	t.Helper()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	client, err := NewModernStreamableHTTPClient(ModernStreamableHTTPClientConfig{
		Endpoint: endpoint, AllowedHosts: []string{"example.com"}, ConnectorVersion: connectorVersion,
		HTTPClient: &http.Client{Transport: transport}, Timeout: 5 * time.Second, MaxResponseBytes: 1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}
