// Package agentgateway provides a VM-boot-scoped Connector MCP endpoint whose
// session bindings survive replacement of the bundle-owned MCP backend.
package agentgateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	connectormcpserver "github.com/tutti-os/tutti/packages/connector/runtime/mcpserver"
)

const connectorMCPPath = "/mcp/connector"

type Backend interface {
	Binding(workspaceID, agentSessionID string) (connectormcpserver.Binding, error)
	Revoke(workspaceID, agentSessionID string)
	RevokeAll()
}

// ScopedBackend accepts the trusted Invocation identity associated with a
// shared-Agent binding. Backend implementations that only implement Backend
// remain compatible for ordinary non-shared Agent Sessions.
type ScopedBackend interface {
	Bind(connectormcpserver.BindingScope) (connectormcpserver.Binding, error)
}

type Config struct {
	Address string
}

type sessionAuthority struct {
	token string
	scope connectormcpserver.BindingScope
}

type cachedBackendBinding struct {
	generation uint64
	binding    connectormcpserver.Binding
}

// Gateway owns the stable listener and Agent-facing bearer authority. The
// replaceable backend owns MCP routing and can restart independently.
type Gateway struct {
	listener net.Listener
	http     *http.Server
	baseURL  string

	mu              sync.RWMutex
	backend         Backend
	backendEpoch    string
	generation      uint64
	authorizations  map[string]sessionAuthority
	backendBindings map[string]cachedBackendBinding
}

func Start(config Config) (*Gateway, error) {
	address := strings.TrimSpace(config.Address)
	if address == "" {
		address = "127.0.0.1:0"
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, errors.New("connector Agent gateway address must be loopback")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen for connector Agent gateway: %w", err)
	}
	gateway := &Gateway{
		listener:        listener,
		baseURL:         "http://" + listener.Addr().String() + connectorMCPPath,
		authorizations:  make(map[string]sessionAuthority),
		backendBindings: make(map[string]cachedBackendBinding),
	}
	gateway.http = &http.Server{Handler: gateway, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = gateway.http.Serve(listener) }()
	return gateway, nil
}

func (gateway *Gateway) SetBackend(epoch string, backend Backend) error {
	if gateway == nil || backend == nil || strings.TrimSpace(epoch) == "" {
		return errors.New("connector Agent gateway backend and epoch are required")
	}
	gateway.mu.Lock()
	previous := gateway.backend
	gateway.backend = backend
	gateway.backendEpoch = strings.TrimSpace(epoch)
	gateway.generation++
	gateway.backendBindings = make(map[string]cachedBackendBinding)
	gateway.mu.Unlock()
	if previous != nil {
		previous.RevokeAll()
	}
	return nil
}

func (gateway *Gateway) ClearBackend(epoch string) {
	if gateway == nil {
		return
	}
	gateway.mu.Lock()
	if strings.TrimSpace(epoch) != "" && gateway.backendEpoch != strings.TrimSpace(epoch) {
		gateway.mu.Unlock()
		return
	}
	previous := gateway.backend
	gateway.backend = nil
	gateway.backendEpoch = ""
	gateway.generation++
	gateway.backendBindings = make(map[string]cachedBackendBinding)
	gateway.mu.Unlock()
	if previous != nil {
		previous.RevokeAll()
	}
}

func (gateway *Gateway) Binding(workspaceID, agentSessionID string) (connectormcpserver.Binding, error) {
	return gateway.Bind(connectormcpserver.BindingScope{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
}

// Bind creates a new Agent-facing bearer for an exact Session or Invocation
// scope. Binding remains the compatibility entry point for ordinary Sessions.
func (gateway *Gateway) Bind(scope connectormcpserver.BindingScope) (connectormcpserver.Binding, error) {
	if gateway == nil || gateway.listener == nil {
		return connectormcpserver.Binding{}, errors.New("connector Agent gateway is unavailable")
	}
	scope = normalizeBindingScope(scope)
	if !validBindingScope(scope) {
		return connectormcpserver.Binding{}, errors.New("connector Agent gateway binding identity is required")
	}
	token, err := randomToken(32)
	if err != nil {
		return connectormcpserver.Binding{}, err
	}
	gateway.mu.Lock()
	gateway.revokeLocked(scope.WorkspaceID, scope.AgentSessionID)
	gateway.authorizations[token] = sessionAuthority{token: token, scope: scope}
	gateway.mu.Unlock()
	return connectormcpserver.Binding{Name: "connector", Type: "http", URL: gateway.baseURL,
		Headers: map[string]string{"Authorization": "Bearer " + token}}, nil
}

// Rebind refreshes the backend binding for the same trusted Invocation scope
// while retaining the Agent-facing bearer. It must never move a bearer across
// Invocation scopes: a delayed request carrying that bearer would otherwise
// be reinterpreted as belonging to a newer Invocation.
func (gateway *Gateway) Rebind(scope connectormcpserver.BindingScope) error {
	if gateway == nil {
		return errors.New("connector Agent gateway is unavailable")
	}
	scope = normalizeBindingScope(scope)
	if !validBindingScope(scope) {
		return errors.New("connector Agent gateway binding identity is required")
	}
	gateway.mu.Lock()
	token := ""
	for candidateToken, authority := range gateway.authorizations {
		if authority.scope.WorkspaceID == scope.WorkspaceID && authority.scope.AgentSessionID == scope.AgentSessionID {
			if authority.scope != scope {
				gateway.mu.Unlock()
				return errors.New("connector Agent gateway Rebind cannot change Invocation scope")
			}
			token = candidateToken
		}
	}
	backend := gateway.backend
	gateway.mu.Unlock()
	if token == "" {
		return errors.New("connector Agent gateway binding was not found")
	}
	if backend != nil {
		backend.Revoke(scope.WorkspaceID, scope.AgentSessionID)
	}
	gateway.mu.Lock()
	current, exists := gateway.authorizations[token]
	if !exists || current.scope != scope || gateway.backend != backend {
		gateway.mu.Unlock()
		return errors.New("connector Agent gateway binding changed while rebinding")
	}
	gateway.deleteBackendBindingsLocked(scope.WorkspaceID, scope.AgentSessionID)
	gateway.mu.Unlock()
	return nil
}

// RotateBinding issues a new Agent-facing bearer and revokes the previous
// bearer for the Session. Cross-Invocation transitions must use this API and
// reprepare the provider-visible MCP configuration before execution proceeds.
func (gateway *Gateway) RotateBinding(scope connectormcpserver.BindingScope) (connectormcpserver.Binding, error) {
	scope = normalizeBindingScope(scope)
	if !validBindingScope(scope) {
		return connectormcpserver.Binding{}, errors.New("connector Agent gateway binding identity is required")
	}
	gateway.Revoke(scope.WorkspaceID, scope.AgentSessionID)
	return gateway.Bind(scope)
}

func (gateway *Gateway) Revoke(workspaceID, agentSessionID string) {
	if gateway == nil {
		return
	}
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	gateway.mu.Lock()
	backend := gateway.backend
	gateway.revokeLocked(workspaceID, agentSessionID)
	gateway.mu.Unlock()
	if backend != nil {
		backend.Revoke(workspaceID, agentSessionID)
	}
}

func (gateway *Gateway) RevokeAll() {
	if gateway == nil {
		return
	}
	gateway.mu.Lock()
	backend := gateway.backend
	gateway.authorizations = make(map[string]sessionAuthority)
	gateway.backendBindings = make(map[string]cachedBackendBinding)
	gateway.mu.Unlock()
	if backend != nil {
		backend.RevokeAll()
	}
}

func (gateway *Gateway) Close(ctx context.Context) error {
	if gateway == nil || gateway.http == nil {
		return nil
	}
	gateway.RevokeAll()
	return gateway.http.Shutdown(ctx)
}

func (gateway *Gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != connectorMCPPath || !loopbackHost(request.Host) {
		http.NotFound(writer, request)
		return
	}
	authority, ok := gateway.authorize(request.Header.Get("Authorization"))
	if !ok {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(writer, "connector Agent gateway authentication is required", http.StatusUnauthorized)
		return
	}
	binding, err := gateway.backendBinding(authority)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusServiceUnavailable)
		return
	}
	target, err := url.Parse(binding.URL)
	if err != nil || target.Scheme != "http" || !loopbackHostname(target.Hostname()) || target.Path != connectorMCPPath {
		http.Error(writer, "connector MCP backend binding is invalid", http.StatusServiceUnavailable)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(outbound *http.Request) {
		originalDirector(outbound)
		// NewSingleHostReverseProxy joins target.Path with the inbound path.
		// Both bindings deliberately expose the same fixed MCP path, so the
		// default join would forward /mcp/connector/mcp/connector.
		outbound.URL.Path = target.Path
		outbound.URL.RawPath = target.RawPath
		outbound.Host = target.Host
		outbound.Header.Del("Authorization")
		if authorization := strings.TrimSpace(binding.Headers["Authorization"]); authorization != "" {
			outbound.Header.Set("Authorization", authorization)
		}
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(response, "connector MCP backend is unavailable", http.StatusServiceUnavailable)
	}
	proxy.ServeHTTP(writer, request)
}

func (gateway *Gateway) backendBinding(authority sessionAuthority) (connectormcpserver.Binding, error) {
	key := bindingScopeKey(authority.scope)
	gateway.mu.RLock()
	backend, generation := gateway.backend, gateway.generation
	if cached, ok := gateway.backendBindings[key]; ok && cached.generation == generation {
		gateway.mu.RUnlock()
		return cached.binding, nil
	}
	gateway.mu.RUnlock()
	if backend == nil {
		return connectormcpserver.Binding{}, errors.New("connector MCP backend is starting")
	}
	var binding connectormcpserver.Binding
	var err error
	if scoped, ok := backend.(ScopedBackend); ok {
		binding, err = scoped.Bind(authority.scope)
	} else if authority.scope.InvocationID == "" && authority.scope.InvocationGeneration == 0 {
		binding, err = backend.Binding(authority.scope.WorkspaceID, authority.scope.AgentSessionID)
	} else {
		return connectormcpserver.Binding{}, errors.New("connector MCP backend does not support Invocation scope")
	}
	if err != nil {
		return connectormcpserver.Binding{}, err
	}
	gateway.mu.Lock()
	current, currentExists := gateway.authorizations[authority.token]
	if gateway.backend != backend || gateway.generation != generation || !currentExists || current.scope != authority.scope {
		gateway.mu.Unlock()
		backend.Revoke(authority.scope.WorkspaceID, authority.scope.AgentSessionID)
		return connectormcpserver.Binding{}, errors.New("connector MCP backend changed while binding")
	}
	gateway.backendBindings[key] = cachedBackendBinding{generation: generation, binding: binding}
	gateway.mu.Unlock()
	return binding, nil
}

func (gateway *Gateway) authorize(header string) (sessionAuthority, bool) {
	token, ok := strings.CutPrefix(strings.TrimSpace(header), "Bearer ")
	if !ok || token == "" {
		return sessionAuthority{}, false
	}
	gateway.mu.RLock()
	authority, exists := gateway.authorizations[token]
	gateway.mu.RUnlock()
	return authority, exists
}

func (gateway *Gateway) revokeLocked(workspaceID, agentSessionID string) {
	for token, authority := range gateway.authorizations {
		if authority.scope.WorkspaceID == workspaceID && authority.scope.AgentSessionID == agentSessionID {
			delete(gateway.authorizations, token)
		}
	}
	gateway.deleteBackendBindingsLocked(workspaceID, agentSessionID)
}

func (gateway *Gateway) deleteBackendBindingsLocked(workspaceID, agentSessionID string) {
	prefix := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID) + "\x00"
	for key := range gateway.backendBindings {
		if strings.HasPrefix(key, prefix) {
			delete(gateway.backendBindings, key)
		}
	}
}

func normalizeBindingScope(scope connectormcpserver.BindingScope) connectormcpserver.BindingScope {
	scope.WorkspaceID = strings.TrimSpace(scope.WorkspaceID)
	scope.AgentSessionID = strings.TrimSpace(scope.AgentSessionID)
	scope.InvocationID = strings.TrimSpace(scope.InvocationID)
	return scope
}

func validBindingScope(scope connectormcpserver.BindingScope) bool {
	if scope.WorkspaceID == "" || scope.AgentSessionID == "" ||
		strings.ContainsAny(scope.WorkspaceID+scope.AgentSessionID+scope.InvocationID, "\x00\r\n") {
		return false
	}
	return (scope.InvocationID == "") == (scope.InvocationGeneration == 0)
}

func bindingScopeKey(scope connectormcpserver.BindingScope) string {
	return scope.WorkspaceID + "\x00" + scope.AgentSessionID + "\x00" + scope.InvocationID + "\x00" + fmt.Sprint(scope.InvocationGeneration)
}

func loopbackHost(value string) bool {
	host, _, err := net.SplitHostPort(value)
	return err == nil && loopbackHostname(host)
}

func loopbackHostname(value string) bool {
	ip := net.ParseIP(strings.Trim(value, "[]"))
	return ip != nil && ip.IsLoopback()
}

func randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}
