package agentgateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	connectormcpserver "github.com/tutti-os/tutti/packages/connector/runtime/mcpserver"
)

type backendStub struct {
	server *httptest.Server
	token  string

	mu         sync.Mutex
	revokeAlls int
}

type scopedBackendStub struct {
	*backendStub
	mu     sync.Mutex
	scopes []connectormcpserver.BindingScope
}

func (backend *scopedBackendStub) Bind(scope connectormcpserver.BindingScope) (connectormcpserver.Binding, error) {
	backend.mu.Lock()
	backend.scopes = append(backend.scopes, scope)
	backend.mu.Unlock()
	return backend.Binding(scope.WorkspaceID, scope.AgentSessionID)
}

func newBackendStub(t *testing.T, token, response string) *backendStub {
	t.Helper()
	backend := &backendStub{token: token}
	backend.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != connectorMCPPath {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer "+token {
			http.Error(writer, "invalid backend authorization", http.StatusUnauthorized)
			return
		}
		_, _ = writer.Write([]byte(response))
	}))
	t.Cleanup(backend.server.Close)
	return backend
}

func (backend *backendStub) Binding(string, string) (connectormcpserver.Binding, error) {
	return connectormcpserver.Binding{Name: "connector", Type: "http",
		URL:     backend.server.URL + connectorMCPPath,
		Headers: map[string]string{"Authorization": "Bearer " + backend.token}}, nil
}
func (*backendStub) Revoke(string, string) {}
func (backend *backendStub) RevokeAll() {
	backend.mu.Lock()
	backend.revokeAlls++
	backend.mu.Unlock()
}

func TestGatewayKeepsAgentBindingAcrossBackendReplacement(t *testing.T) {
	gateway, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close(context.Background()) })
	first := newBackendStub(t, "backend-one", "one")
	if err := gateway.SetBackend("runtime-1", first); err != nil {
		t.Fatal(err)
	}
	binding, err := gateway.Binding("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if got := callGateway(t, binding); got != "one" {
		t.Fatalf("first response = %q", got)
	}
	second := newBackendStub(t, "backend-two", "two")
	if err := gateway.SetBackend("runtime-2", second); err != nil {
		t.Fatal(err)
	}
	if got := callGateway(t, binding); got != "two" {
		t.Fatalf("replacement response = %q", got)
	}
	first.mu.Lock()
	revoked := first.revokeAlls
	first.mu.Unlock()
	if revoked != 1 {
		t.Fatalf("previous backend revoke-all count = %d", revoked)
	}
}

func TestGatewayHotRebindKeepsAgentBearerOnlyWithinInvocationScope(t *testing.T) {
	gateway, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close(context.Background()) })
	backend := &scopedBackendStub{backendStub: newBackendStub(t, "backend", "ready")}
	if err := gateway.SetBackend("runtime-1", backend); err != nil {
		t.Fatal(err)
	}
	binding, err := gateway.Bind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := callGateway(t, binding); got != "ready" {
		t.Fatalf("initial response = %q", got)
	}
	if err := gateway.Rebind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if got := callGateway(t, binding); got != "ready" {
		t.Fatalf("rebound response = %q", got)
	}
	backend.mu.Lock()
	scopes := append([]connectormcpserver.BindingScope(nil), backend.scopes...)
	backend.mu.Unlock()
	if len(scopes) != 2 || scopes[0].InvocationID != "invocation-1" || scopes[0].InvocationGeneration != 1 ||
		scopes[1] != scopes[0] {
		t.Fatalf("backend scopes = %#v", scopes)
	}
	if err := gateway.Rebind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-2", InvocationGeneration: 2,
	}); err == nil {
		t.Fatal("Rebind moved a stable Agent bearer across Invocation scopes")
	}
}

func TestGatewayRotateBindingRevokesPreviousInvocationBearer(t *testing.T) {
	gateway, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close(context.Background()) })
	backend := &scopedBackendStub{backendStub: newBackendStub(t, "backend", "ready")}
	if err := gateway.SetBackend("runtime-1", backend); err != nil {
		t.Fatal(err)
	}
	first, err := gateway.Bind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := gateway.RotateBinding(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-2", InvocationGeneration: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodPost, first.URL, strings.NewReader(`{"jsonrpc":"2.0"}`))
	request.Header.Set("Authorization", first.Headers["Authorization"])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("previous Invocation bearer status = %d", response.StatusCode)
	}
	if got := callGateway(t, second); got != "ready" {
		t.Fatalf("rotated response = %q", got)
	}
}

func TestGatewayRequiresScopedBackendForInvocationBinding(t *testing.T) {
	gateway, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close(context.Background()) })
	if err := gateway.SetBackend("runtime-1", newBackendStub(t, "backend", "ready")); err != nil {
		t.Fatal(err)
	}
	binding, err := gateway.Bind(connectormcpserver.BindingScope{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		InvocationID: "invocation-1", InvocationGeneration: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodPost, binding.URL, strings.NewReader(`{"jsonrpc":"2.0"}`))
	request.Header.Set("Authorization", binding.Headers["Authorization"])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unscoped backend status = %d", response.StatusCode)
	}
}

func callGateway(t *testing.T, binding connectormcpserver.Binding) string {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, binding.URL, strings.NewReader(`{"jsonrpc":"2.0"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", binding.Headers["Authorization"])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("gateway status = %d body=%q", response.StatusCode, body)
	}
	return string(body)
}
