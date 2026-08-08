package connectormcp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
)

const (
	serverName      = "connector"
	protocolVersion = "2025-06-18"
	defaultTokenTTL = 24 * time.Hour
)

type Config struct {
	Registry *implementationhost.MCPRegistry
	TokenTTL time.Duration
}

type Binding struct {
	Name    string
	Type    string
	URL     string
	Headers map[string]string
}

type authorization struct {
	workspaceID string
	sessionID   string
	allowedKeys map[string]struct{}
	expiresAt   time.Time
	revoked     <-chan struct{}
}

// Server is a loopback-only Streamable HTTP MCP projection over Connector
// routes. User-configured MCP servers never enter this service.
type Server struct {
	registry *implementationhost.MCPRegistry
	tokenTTL time.Duration
	listener net.Listener
	http     *http.Server
	baseURL  string

	mu             sync.RWMutex
	authorizations map[string]authorization
	sessionTokens  map[string]string
	revocations    map[string]chan struct{}
}

func Start(config Config) (*Server, error) {
	if config.Registry == nil {
		return nil, errors.New("connector MCP registry is required")
	}
	if config.TokenTTL <= 0 {
		config.TokenTTL = defaultTokenTTL
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for connector MCP: %w", err)
	}
	server := &Server{registry: config.Registry, tokenTTL: config.TokenTTL, listener: listener,
		baseURL:        "http://" + listener.Addr().String() + "/mcp/connector",
		authorizations: make(map[string]authorization), sessionTokens: make(map[string]string), revocations: make(map[string]chan struct{})}
	server.http = &http.Server{Handler: server, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.http.Serve(listener) }()
	return server, nil
}

func (server *Server) Binding(workspaceID, agentSessionID string, connectorKeys []string) (Binding, error) {
	if server == nil || server.listener == nil {
		return Binding{}, errors.New("connector MCP server is unavailable")
	}
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Binding{}, errors.New("connector MCP binding identity is required")
	}
	var allowed map[string]struct{}
	if connectorKeys != nil {
		allowed = make(map[string]struct{}, len(connectorKeys))
		for _, key := range connectorKeys {
			if key = strings.TrimSpace(key); key != "" {
				allowed[key] = struct{}{}
			}
		}
	}
	token, err := randomID(32)
	if err != nil {
		return Binding{}, err
	}
	server.mu.Lock()
	server.pruneExpiredLocked(time.Now())
	server.revokeLocked(workspaceID, agentSessionID)
	revoked := make(chan struct{})
	server.authorizations[token] = authorization{workspaceID: workspaceID, sessionID: agentSessionID,
		allowedKeys: allowed, expiresAt: time.Now().Add(server.tokenTTL), revoked: revoked}
	server.revocations[token] = revoked
	server.mu.Unlock()
	return Binding{Name: serverName, Type: "http", URL: server.baseURL,
		Headers: map[string]string{"Authorization": "Bearer " + token}}, nil
}

func (server *Server) Revoke(workspaceID, agentSessionID string) {
	if server == nil {
		return
	}
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	server.mu.Lock()
	server.revokeLocked(workspaceID, agentSessionID)
	server.mu.Unlock()
}

func (server *Server) Close(ctx context.Context) error {
	if server == nil || server.http == nil {
		return nil
	}
	return server.http.Shutdown(ctx)
}

func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/mcp/connector" || !validLoopbackRequest(request) {
		http.NotFound(writer, request)
		return
	}
	token, auth, ok := server.authorize(request)
	if !ok {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch request.Method {
	case http.MethodPost:
		server.handlePost(writer, request, token, auth)
	case http.MethodGet:
		server.handleEvents(writer, request, token, auth)
	case http.MethodDelete:
		server.handleDelete(writer, request, token)
	default:
		writer.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
	}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func (server *Server) handlePost(writer http.ResponseWriter, request *http.Request, token string, auth authorization) {
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 2<<20))
	decoder.DisallowUnknownFields()
	var rpc rpcRequest
	if err := decoder.Decode(&rpc); err != nil || rpc.JSONRPC != "2.0" || strings.TrimSpace(rpc.Method) == "" {
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: nullID(rpc.ID), Error: &rpcError{Code: -32600, Message: "invalid request"}})
		return
	}
	if len(rpc.ID) == 0 {
		if rpc.Method != "notifications/initialized" || !server.validMCPSession(request, token) {
			http.Error(writer, "MCP session not found", http.StatusNotFound)
			return
		}
		writer.WriteHeader(http.StatusAccepted)
		return
	}
	switch rpc.Method {
	case "initialize":
		sessionID, err := randomID(24)
		if err != nil {
			writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Error: &rpcError{Code: -32603, Message: "initialize failed"}})
			return
		}
		server.mu.Lock()
		if _, active := server.authorizations[token]; !active {
			server.mu.Unlock()
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		server.sessionTokens[sessionID] = token
		server.mu.Unlock()
		writer.Header().Set("Mcp-Session-Id", sessionID)
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": true}},
			"serverInfo":      map[string]any{"name": serverName, "version": "1"},
		}})
	case "tools/list":
		if !server.validMCPSession(request, token) {
			http.Error(writer, "MCP session not found", http.StatusNotFound)
			return
		}
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{
			"tools": server.registry.Tools(auth.allowedKeys),
		}})
	case "tools/call":
		if !server.validMCPSession(request, token) {
			http.Error(writer, "MCP session not found", http.StatusNotFound)
			return
		}
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.Unmarshal(rpc.Params, &params) != nil || strings.TrimSpace(params.Name) == "" {
			writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Error: &rpcError{Code: -32602, Message: "invalid tool arguments"}})
			return
		}
		if params.Arguments == nil {
			params.Arguments = map[string]any{}
		}
		raw, err := server.registry.Call(request.Context(), auth.allowedKeys, params.Name, params.Arguments)
		if err != nil {
			writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Error: &rpcError{Code: -32000, Message: err.Error()}})
			return
		}
		var result any
		if json.Unmarshal(raw, &result) != nil {
			writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Error: &rpcError{Code: -32603, Message: "invalid upstream tool result"}})
			return
		}
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: result})
	default:
		writeRPC(writer, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Error: &rpcError{Code: -32601, Message: "method not found"}})
	}
}

func (server *Server) handleEvents(writer http.ResponseWriter, request *http.Request, token string, auth authorization) {
	if !server.validMCPSession(request, token) {
		http.Error(writer, "MCP session not found", http.StatusNotFound)
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		http.Error(writer, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	updates, unsubscribe := server.registry.Subscribe()
	defer unsubscribe()
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Connection", "keep-alive")
	_, _ = writer.Write([]byte(": connector MCP event stream\n\n"))
	flusher.Flush()
	for {
		select {
		case _, open := <-updates:
			if !open {
				return
			}
			payload := `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`
			_, _ = fmt.Fprintf(writer, "event: message\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-request.Context().Done():
			return
		case <-auth.revoked:
			return
		}
	}
}

func (server *Server) handleDelete(writer http.ResponseWriter, request *http.Request, token string) {
	sessionID := strings.TrimSpace(request.Header.Get("Mcp-Session-Id"))
	server.mu.Lock()
	if current := server.sessionTokens[sessionID]; sessionID != "" && secureEqual(current, token) {
		delete(server.sessionTokens, sessionID)
	}
	server.mu.Unlock()
	writer.WriteHeader(http.StatusNoContent)
}

func (server *Server) authorize(request *http.Request) (string, authorization, bool) {
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Bearer ") {
		return "", authorization{}, false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	server.mu.RLock()
	auth, ok := server.authorizations[token]
	server.mu.RUnlock()
	if !ok || time.Now().After(auth.expiresAt) {
		return "", authorization{}, false
	}
	return token, auth, true
}

func (server *Server) validMCPSession(request *http.Request, token string) bool {
	sessionID := strings.TrimSpace(request.Header.Get("Mcp-Session-Id"))
	server.mu.RLock()
	current, ok := server.sessionTokens[sessionID]
	server.mu.RUnlock()
	return sessionID != "" && ok && secureEqual(current, token)
}

func (server *Server) pruneExpiredLocked(now time.Time) {
	for token, auth := range server.authorizations {
		if now.After(auth.expiresAt) {
			server.revokeTokenLocked(token)
		}
	}
}

func (server *Server) revokeLocked(workspaceID, agentSessionID string) {
	for token, auth := range server.authorizations {
		if auth.workspaceID != workspaceID || auth.sessionID != agentSessionID {
			continue
		}
		server.revokeTokenLocked(token)
	}
}

func (server *Server) revokeTokenLocked(token string) {
	delete(server.authorizations, token)
	if revoked := server.revocations[token]; revoked != nil {
		close(revoked)
		delete(server.revocations, token)
	}
	for sessionID, sessionToken := range server.sessionTokens {
		if sessionToken == token {
			delete(server.sessionTokens, sessionID)
		}
	}
}

func writeRPC(writer http.ResponseWriter, response rpcResponse) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(response)
}

func nullID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func randomID(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate connector MCP secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func secureEqual(left, right string) bool {
	if len(left) == 0 || len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func validLoopbackRequest(request *http.Request) bool {
	host := request.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" || origin == "null" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	originHost := strings.Trim(strings.ToLower(parsed.Hostname()), "[]")
	return originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1"
}
