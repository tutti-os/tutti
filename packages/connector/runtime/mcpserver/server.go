// Package mcpserver exposes active Connector MCP routes through a loopback-only,
// session-bound Streamable HTTP server. Hosts own when bindings are issued and
// revoked; the server owns transport validation and bearer isolation.
package mcpserver

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	connectorruntimemcp "github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

const (
	serverName              = "connector"
	protocolVersion         = "2026-07-28"
	providerProtocolVersion = "2025-06-18"
	maxRequestBytes         = 2 << 20
)

type Config struct {
	Registry      *implementationhost.MCPRegistry
	SessionRouter SessionRouter
}

// RequestScope is derived only from the bearer minted by Binding. It is never
// decoded from Agent-supplied headers or MCP arguments.
type RequestScope struct {
	WorkspaceID          string
	AgentSessionID       string
	InvocationID         string
	InvocationGeneration uint64
}

// BindingScope is the trusted identity captured in an Agent-facing bearer.
// Invocation identity is optional for ordinary local Agent Sessions, but an
// InvocationID and InvocationGeneration must always be supplied together.
type BindingScope struct {
	WorkspaceID          string
	AgentSessionID       string
	InvocationID         string
	InvocationGeneration uint64
}

type requestScopeContextKey struct{}

func normalizeBindingScope(scope BindingScope) BindingScope {
	scope.WorkspaceID = strings.TrimSpace(scope.WorkspaceID)
	scope.AgentSessionID = strings.TrimSpace(scope.AgentSessionID)
	scope.InvocationID = strings.TrimSpace(scope.InvocationID)
	return scope
}

func validBindingScope(scope BindingScope) bool {
	if scope.WorkspaceID == "" || scope.AgentSessionID == "" ||
		strings.ContainsAny(scope.WorkspaceID+scope.AgentSessionID+scope.InvocationID, "\x00\r\n") {
		return false
	}
	return (scope.InvocationID == "") == (scope.InvocationGeneration == 0)
}

func requestScope(scope BindingScope) RequestScope {
	return RequestScope(scope)
}

func validRequestScope(scope RequestScope) bool {
	return validBindingScope(BindingScope(scope))
}

// RequestScopeFromContext returns the authenticated Agent Session scope for
// the current Connector MCP request.
func RequestScopeFromContext(ctx context.Context) (RequestScope, bool) {
	if ctx == nil {
		return RequestScope{}, false
	}
	scope, ok := ctx.Value(requestScopeContextKey{}).(RequestScope)
	if !ok || !validRequestScope(scope) {
		return RequestScope{}, false
	}
	return scope, true
}

// SessionRouter lets a product project and route Connector tools for one
// authenticated Agent Session. Implementations must treat scope as trusted
// transport identity and must not accept a replacement scope from tool input.
type SessionRouter interface {
	Tools(context.Context, RequestScope) ([]implementationhost.MCPTool, error)
	CallValidated(context.Context, RequestScope, string, map[string]any, func(implementationhost.MCPTool) error) (json.RawMessage, error)
	Subscribe(RequestScope) (<-chan struct{}, func())
}

type Binding struct {
	Name    string
	Type    string
	URL     string
	Headers map[string]string
}

type authorization struct {
	scope   RequestScope
	revoked <-chan struct{}
}

// Server is a loopback-only, stateless Streamable HTTP MCP projection over
// Connector routes. User-configured MCP servers never enter this service.
type Server struct {
	router   SessionRouter
	listener net.Listener
	http     *http.Server
	baseURL  string

	mu             sync.RWMutex
	authorizations map[string]authorization
	revocations    map[string]chan struct{}
}

func Start(config Config) (*Server, error) {
	router := config.SessionRouter
	if router == nil && config.Registry != nil {
		router = registrySessionRouter{registry: config.Registry}
	}
	if router == nil {
		return nil, errors.New("connector MCP registry is required")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for connector MCP: %w", err)
	}
	server := &Server{
		router:         router,
		listener:       listener,
		baseURL:        "http://" + listener.Addr().String() + "/mcp/connector",
		authorizations: make(map[string]authorization),
		revocations:    make(map[string]chan struct{}),
	}
	server.http = &http.Server{Handler: server, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.http.Serve(listener) }()
	return server, nil
}

func (server *Server) Binding(workspaceID, agentSessionID string) (Binding, error) {
	return server.Bind(BindingScope{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
}

// Bind issues a bearer for an exact trusted Session or Invocation scope. The
// legacy Binding method remains the compatibility entry point for ordinary
// non-shared Agent Sessions.
func (server *Server) Bind(bindingScope BindingScope) (Binding, error) {
	if server == nil || server.listener == nil {
		return Binding{}, errors.New("connector MCP server is unavailable")
	}
	scope := normalizeBindingScope(bindingScope)
	if !validBindingScope(scope) {
		return Binding{}, errors.New("connector MCP binding identity is required")
	}
	token, err := randomID(32)
	if err != nil {
		return Binding{}, err
	}
	server.mu.Lock()
	server.revokeLocked(scope.WorkspaceID, scope.AgentSessionID)
	revoked := make(chan struct{})
	server.authorizations[token] = authorization{scope: requestScope(scope), revoked: revoked}
	server.revocations[token] = revoked
	server.mu.Unlock()
	return Binding{
		Name: serverName,
		Type: "http",
		URL:  server.baseURL,
		Headers: map[string]string{
			"Authorization": "Bearer " + token,
		},
	}, nil
}

func (server *Server) Revoke(workspaceID, agentSessionID string) {
	if server == nil {
		return
	}
	server.mu.Lock()
	server.revokeLocked(strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	server.mu.Unlock()
}

func (server *Server) RevokeAll() {
	if server == nil {
		return
	}
	server.mu.Lock()
	for token := range server.authorizations {
		server.revokeTokenLocked(token)
	}
	server.mu.Unlock()
}

func (server *Server) Close(ctx context.Context) error {
	if server == nil || server.http == nil {
		return nil
	}
	server.RevokeAll()
	return server.http.Shutdown(ctx)
}

func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/mcp/connector" || !validLoopbackHost(request.Host) {
		http.NotFound(writer, request)
		return
	}
	if !validLoopbackOrigin(request.Header.Get("Origin")) {
		writeRPCError(writer, http.StatusForbidden, nil, -32020, "Origin is not allowed", nil)
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeRPCError(writer, http.StatusMethodNotAllowed, nil, -32600, "Connector MCP only accepts POST", nil)
		return
	}
	token, auth, ok := server.authorize(request)
	if !ok {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		writeRPCError(writer, http.StatusUnauthorized, nil, -32001, "Connector MCP authentication is required", nil)
		return
	}
	server.handlePost(writer, request, token, auth)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type requestMetadata struct {
	ProtocolVersion    string         `json:"io.modelcontextprotocol/protocolVersion"`
	ClientInfo         implementation `json:"io.modelcontextprotocol/clientInfo"`
	ClientCapabilities map[string]any `json:"io.modelcontextprotocol/clientCapabilities"`
}

type implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (server *Server) handlePost(writer http.ResponseWriter, request *http.Request, token string, auth authorization) {
	scope := auth.scope
	request = request.WithContext(context.WithValue(request.Context(), requestScopeContextKey{}, scope))
	writer.Header().Set("Cache-Control", "private, no-store")
	if !mediaTypeContains(request.Header.Get("Content-Type"), "application/json") ||
		!mediaTypeContains(request.Header.Get("Accept"), "application/json") ||
		!mediaTypeContains(request.Header.Get("Accept"), "text/event-stream") {
		writeRPCError(writer, http.StatusBadRequest, nil, -32600, "MCP HTTP content negotiation is invalid", nil)
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, maxRequestBytes))
	decoder.DisallowUnknownFields()
	var rpc rpcRequest
	if err := decoder.Decode(&rpc); err != nil || decoder.Decode(&struct{}{}) != io.EOF || rpc.JSONRPC != "2.0" ||
		strings.TrimSpace(rpc.Method) == "" {
		writeRPCError(writer, http.StatusBadRequest, nullID(rpc.ID), -32600, "Invalid MCP request", nil)
		return
	}
	if isProviderNativeMethod(request, rpc.Method) {
		server.handleProviderNativePost(writer, request, token, auth, rpc)
		return
	}
	if len(rpc.ID) == 0 {
		writeRPCError(writer, http.StatusBadRequest, nil, -32600, "Invalid MCP request", nil)
		return
	}
	params, metadata, err := decodeRequestParams(rpc.Params)
	if err != nil {
		writeRPCError(writer, http.StatusBadRequest, rpc.ID, -32602, "MCP request metadata is required", nil)
		return
	}
	if validation := validateRequestHeaders(request, rpc.Method, params, metadata); validation != nil {
		writeRPCError(writer, validation.status, rpc.ID, validation.code, validation.message, validation.data)
		return
	}

	switch rpc.Method {
	case "server/discover":
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{
			"resultType":        "complete",
			"supportedVersions": []string{protocolVersion},
			"capabilities":      map[string]any{"tools": map[string]any{"listChanged": true}},
			"_meta": map[string]any{"io.modelcontextprotocol/serverInfo": map[string]any{
				"name": serverName, "version": "1",
			}},
			"ttlMs": 300000, "cacheScope": "private",
		}})
	case "tools/list":
		tools, err := server.router.Tools(request.Context(), scope)
		if err != nil {
			writeRegistryError(writer, rpc.ID, err)
			return
		}
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{
			"resultType": "complete", "tools": tools, "ttlMs": 0, "cacheScope": "private",
		}})
	case "tools/call":
		server.handleToolCall(writer, request, scope, rpc.ID, params, true)
	case "subscriptions/listen":
		server.handleSubscription(writer, request, token, auth, scope, rpc.ID, params)
	default:
		writeRPCError(writer, http.StatusNotFound, rpc.ID, -32601, "Method not found", nil)
	}
}

func isProviderNativeMethod(request *http.Request, method string) bool {
	switch method {
	case "initialize", "notifications/initialized", "notifications/cancelled", "ping",
		"resources/list", "resources/templates/list":
		return true
	case "tools/list", "tools/call":
		// The modern protocol always carries the method in its integrity header.
		// Provider-native MCP clients do not.
		return strings.TrimSpace(request.Header.Get("Mcp-Method")) == ""
	default:
		return false
	}
}

func (server *Server) handleProviderNativePost(
	writer http.ResponseWriter,
	request *http.Request,
	token string,
	auth authorization,
	rpc rpcRequest,
) {
	_ = token
	scope := auth.scope
	switch rpc.Method {
	case "initialize":
		if len(rpc.ID) == 0 {
			writeRPCError(writer, http.StatusBadRequest, nil, -32600, "Initialize request ID is required", nil)
			return
		}
		var params struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
			ClientInfo      implementation `json:"clientInfo"`
		}
		if json.Unmarshal(rpc.Params, &params) != nil || strings.TrimSpace(params.ProtocolVersion) == "" ||
			strings.TrimSpace(params.ClientInfo.Name) == "" || strings.TrimSpace(params.ClientInfo.Version) == "" {
			writeRPCError(writer, http.StatusBadRequest, rpc.ID, -32602, "Invalid initialize parameters", nil)
			return
		}
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{
			"protocolVersion": providerProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": serverName, "version": "1"},
		}})
	case "notifications/initialized", "notifications/cancelled":
		writer.WriteHeader(http.StatusAccepted)
	case "ping":
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{}})
	case "resources/list":
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{"resources": []any{}}})
	case "resources/templates/list":
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{"resourceTemplates": []any{}}})
	case "tools/list":
		tools, err := server.router.Tools(request.Context(), scope)
		if err != nil {
			writeRegistryError(writer, rpc.ID, err)
			return
		}
		writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: rpc.ID, Result: map[string]any{"tools": tools}})
	case "tools/call":
		var params map[string]json.RawMessage
		if len(rpc.ID) == 0 || json.Unmarshal(rpc.Params, &params) != nil {
			writeRPCError(writer, http.StatusBadRequest, nullID(rpc.ID), -32602, "Invalid tool arguments", nil)
			return
		}
		server.handleToolCall(writer, request, scope, rpc.ID, params, false)
	default:
		writeRPCError(writer, http.StatusOK, nullID(rpc.ID), -32601, "Method not found", nil)
	}
}

func (server *Server) handleToolCall(
	writer http.ResponseWriter,
	request *http.Request,
	scope RequestScope,
	id json.RawMessage,
	params map[string]json.RawMessage,
	modern bool,
) {
	var name string
	var arguments map[string]any
	if json.Unmarshal(params["name"], &name) != nil || strings.TrimSpace(name) == "" ||
		(len(params["arguments"]) != 0 && json.Unmarshal(params["arguments"], &arguments) != nil) {
		writeRPCError(writer, http.StatusBadRequest, id, -32602, "Invalid tool arguments", nil)
		return
	}
	if arguments == nil {
		arguments = map[string]any{}
	}
	var parameterValidation error
	var validate func(implementationhost.MCPTool) error
	if modern {
		validate = func(tool implementationhost.MCPTool) error {
			parameterValidation = validateToolParameterHeaders(request.Header, []implementationhost.MCPTool{tool}, name, params["arguments"])
			return parameterValidation
		}
	}
	raw, err := server.router.CallValidated(request.Context(), scope, name, arguments, validate)
	if err != nil {
		if parameterValidation != nil {
			writeRPCError(writer, http.StatusBadRequest, id, -32020, parameterValidation.Error(), nil)
			return
		}
		writeRegistryError(writer, id, err)
		return
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil {
		writeRPCError(writer, http.StatusInternalServerError, id, -32603, "Invalid upstream tool result", nil)
		return
	}
	if modern {
		if _, exists := result["resultType"]; !exists {
			result["resultType"] = "complete"
		}
	} else {
		delete(result, "resultType")
		delete(result, "ttlMs")
		delete(result, "cacheScope")
	}
	writeRPC(writer, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func writeRegistryError(writer http.ResponseWriter, id json.RawMessage, err error) {
	var rpcErr *connectorruntimemcp.RPCError
	if errors.As(err, &rpcErr) && (rpcErr.Code == -33001 || rpcErr.Code == -33002) {
		writeRPCError(writer, http.StatusOK, id, rpcErr.Code, rpcErr.Message, nil)
		return
	}
	writeRPCError(writer, http.StatusOK, id, -32000, err.Error(), nil)
}

func (server *Server) handleSubscription(writer http.ResponseWriter, request *http.Request, token string, auth authorization, scope RequestScope, id json.RawMessage, params map[string]json.RawMessage) {
	var notifications struct {
		ToolsListChanged bool `json:"toolsListChanged"`
	}
	if len(params["notifications"]) != 0 && json.Unmarshal(params["notifications"], &notifications) != nil {
		writeRPCError(writer, http.StatusBadRequest, id, -32602, "Invalid subscription filter", nil)
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeRPCError(writer, http.StatusInternalServerError, id, -32603, "Streaming is unavailable", nil)
		return
	}
	updates, unsubscribe := server.router.Subscribe(scope)
	defer unsubscribe()
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	acknowledged := map[string]any{}
	if notifications.ToolsListChanged {
		acknowledged["toolsListChanged"] = true
	}
	subscriptionID := cloneRawJSON(id)
	writeSSE(writer, map[string]any{
		"jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged",
		"params": map[string]any{
			"_meta":         map[string]any{"io.modelcontextprotocol/subscriptionId": subscriptionID},
			"notifications": acknowledged,
		},
	})
	flusher.Flush()
	for {
		select {
		case _, open := <-updates:
			if !open {
				return
			}
			if notifications.ToolsListChanged {
				writeSSE(writer, map[string]any{
					"jsonrpc": "2.0", "method": "notifications/tools/list_changed",
					"params": map[string]any{"_meta": map[string]any{
						"io.modelcontextprotocol/subscriptionId": subscriptionID,
					}},
				})
				flusher.Flush()
			}
		case <-request.Context().Done():
			return
		case <-auth.revoked:
			writeSSE(writer, rpcResponse{JSONRPC: "2.0", ID: id, Result: map[string]any{
				"resultType": "complete", "_meta": map[string]any{"io.modelcontextprotocol/subscriptionId": subscriptionID},
			}})
			flusher.Flush()
			server.revokeToken(token)
			return
		}
	}
}

type registrySessionRouter struct {
	registry *implementationhost.MCPRegistry
}

func (router registrySessionRouter) Tools(ctx context.Context, _ RequestScope) ([]implementationhost.MCPTool, error) {
	return router.registry.Tools(ctx)
}

func (router registrySessionRouter) CallValidated(
	ctx context.Context,
	_ RequestScope,
	name string,
	arguments map[string]any,
	validate func(implementationhost.MCPTool) error,
) (json.RawMessage, error) {
	return router.registry.CallValidated(ctx, name, arguments, validate)
}

func (router registrySessionRouter) Subscribe(_ RequestScope) (<-chan struct{}, func()) {
	return router.registry.Subscribe()
}

func decodeRequestParams(raw json.RawMessage) (map[string]json.RawMessage, requestMetadata, error) {
	var params map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, requestMetadata{}, errors.New("params are required")
	}
	var metadata requestMetadata
	if json.Unmarshal(params["_meta"], &metadata) != nil || strings.TrimSpace(metadata.ProtocolVersion) == "" ||
		strings.TrimSpace(metadata.ClientInfo.Name) == "" || strings.TrimSpace(metadata.ClientInfo.Version) == "" || metadata.ClientCapabilities == nil {
		return nil, requestMetadata{}, errors.New("metadata is required")
	}
	return params, metadata, nil
}

type requestValidationError struct {
	status  int
	code    int
	message string
	data    any
}

func validateRequestHeaders(request *http.Request, method string, params map[string]json.RawMessage, metadata requestMetadata) *requestValidationError {
	requested := strings.TrimSpace(request.Header.Get("MCP-Protocol-Version"))
	if requested == "" || requested != strings.TrimSpace(metadata.ProtocolVersion) {
		return &requestValidationError{status: http.StatusBadRequest, code: -32020, message: "MCP-Protocol-Version header does not match request metadata"}
	}
	if requested != protocolVersion {
		return &requestValidationError{status: http.StatusBadRequest, code: -32022, message: "Unsupported protocol version",
			data: map[string]any{"supported": []string{protocolVersion}, "requested": requested}}
	}
	if strings.TrimSpace(request.Header.Get("Mcp-Method")) != method {
		return &requestValidationError{status: http.StatusBadRequest, code: -32020, message: "Mcp-Method header does not match request method"}
	}
	if method != "tools/call" {
		return nil
	}
	var name string
	if json.Unmarshal(params["name"], &name) != nil {
		return &requestValidationError{status: http.StatusBadRequest, code: -32602, message: "Tool name is required"}
	}
	headerName, err := decodeHeaderValue(request.Header.Get("Mcp-Name"))
	if err != nil || headerName != name {
		return &requestValidationError{status: http.StatusBadRequest, code: -32020, message: "Mcp-Name header does not match request tool name"}
	}
	return nil
}

func validateToolParameterHeaders(headers http.Header, tools []implementationhost.MCPTool, name string, rawArguments json.RawMessage) error {
	var schema map[string]any
	for _, tool := range tools {
		if tool.Name == name {
			schema = tool.InputSchema
			break
		}
	}
	if schema == nil {
		return nil
	}
	arguments := map[string]any{}
	if len(rawArguments) != 0 && json.Unmarshal(rawArguments, &arguments) != nil {
		return errors.New("tool arguments are invalid")
	}
	for _, binding := range collectHeaderBindings(schema, nil) {
		value, present := nestedValue(arguments, binding.path)
		header := headers.Get("Mcp-Param-" + binding.name)
		if !present || value == nil {
			if header != "" {
				return fmt.Errorf("Mcp-Param-%s header has no matching tool argument", binding.name)
			}
			continue
		}
		decoded, err := decodeHeaderValue(header)
		if err != nil || decoded != fmt.Sprint(value) {
			return fmt.Errorf("Mcp-Param-%s header does not match tool arguments", binding.name)
		}
	}
	return nil
}

type headerBinding struct {
	name string
	path []string
}

func collectHeaderBindings(schema map[string]any, path []string) []headerBinding {
	properties, _ := schema["properties"].(map[string]any)
	result := make([]headerBinding, 0)
	for property, raw := range properties {
		child, _ := raw.(map[string]any)
		if child == nil {
			continue
		}
		nextPath := append(append([]string(nil), path...), property)
		if name, _ := child["x-mcp-header"].(string); strings.TrimSpace(name) != "" {
			result = append(result, headerBinding{name: strings.TrimSpace(name), path: nextPath})
		}
		result = append(result, collectHeaderBindings(child, nextPath)...)
	}
	return result
}

func nestedValue(arguments map[string]any, path []string) (any, bool) {
	var current any = arguments
	for _, segment := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[segment]
		if !ok {
			return nil, false
		}
	}
	return current, true
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
	return token, auth, ok
}

func (server *Server) revokeLocked(workspaceID, agentSessionID string) {
	for token, auth := range server.authorizations {
		if auth.scope.WorkspaceID == workspaceID && auth.scope.AgentSessionID == agentSessionID {
			server.revokeTokenLocked(token)
		}
	}
}

func (server *Server) revokeToken(token string) {
	server.mu.Lock()
	server.revokeTokenLocked(token)
	server.mu.Unlock()
}

func (server *Server) revokeTokenLocked(token string) {
	delete(server.authorizations, token)
	if revoked := server.revocations[token]; revoked != nil {
		close(revoked)
		delete(server.revocations, token)
	}
}

func writeRPC(writer http.ResponseWriter, status int, response rpcResponse) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(response)
}

func writeRPCError(writer http.ResponseWriter, status int, id json.RawMessage, code int, message string, data any) {
	writeRPC(writer, status, rpcResponse{JSONRPC: "2.0", ID: nullID(id), Error: &rpcError{Code: code, Message: message, Data: data}})
}

func writeSSE(writer io.Writer, payload any) {
	raw, err := json.Marshal(payload)
	if err == nil {
		_, _ = fmt.Fprintf(writer, "event: message\ndata: %s\n\n", raw)
	}
}

func nullID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func cloneRawJSON(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func randomID(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate connector MCP secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func mediaTypeContains(value, expected string) bool {
	for _, candidate := range strings.Split(strings.ToLower(value), ",") {
		if strings.TrimSpace(strings.SplitN(candidate, ";", 2)[0]) == expected {
			return true
		}
	}
	return false
}

func decodeHeaderValue(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "=?base64?") || !strings.HasSuffix(value, "?=") {
		return value, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(strings.TrimPrefix(value, "=?base64?"), "?="))
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func validLoopbackHost(value string) bool {
	host := value
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func validLoopbackOrigin(value string) bool {
	origin := strings.TrimSpace(value)
	if origin == "" || origin == "null" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.Trim(strings.ToLower(parsed.Hostname()), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
