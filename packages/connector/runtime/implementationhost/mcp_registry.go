package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	connectormcp "github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

// MCPTool is the connector-scoped projection exposed by the local connector
// MCP server. UpstreamName is deliberately not serialized: callers use the
// namespaced local name and the registry resolves the upstream binding.
type MCPTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema"`
	// ConnectorKey and ConnectorVersion are trusted in-process route provenance.
	// They are never exposed through the MCP tools/list JSON contract or accepted
	// from Agent input.
	ConnectorKey     string `json:"-"`
	ConnectorVersion string `json:"-"`
}

// MCPToolProjection derives the exact transport-validation contract for a
// resolved live Tool. A Session router can use this to inject an
// authority-specific discriminator after it has selected Owner or Caller,
// without asking the transport validator to interpret a presentation oneOf.
type MCPToolProjection func(MCPTool) (MCPTool, error)

type registeredMCPTool struct {
	routeID      string
	localName    string
	upstreamName string
	description  string
	inputSchema  map[string]any
	client       mcpCaller
}

// MCPRegistry exposes only Connector-owned MCP routes. It intentionally
// shares the implementation host's generation-fenced RouteTable so MCP and
// CLI publication observe the same lifecycle boundary.
type MCPRegistry struct {
	mu                         sync.RWMutex
	routes                     *connectorruntime.RouteTable
	subscribers                map[uint64]chan struct{}
	nextID                     uint64
	authorizationErrorObserver func()
}

func NewMCPRegistry() *MCPRegistry {
	return &MCPRegistry{subscribers: make(map[uint64]chan struct{})}
}

func (registry *MCPRegistry) attach(routes *connectorruntime.RouteTable) {
	registry.mu.Lock()
	registry.routes = routes
	registry.mu.Unlock()
}

func (registry *MCPRegistry) activeRoutes() []*connectorRoute {
	if registry == nil {
		return nil
	}
	registry.mu.RLock()
	table := registry.routes
	registry.mu.RUnlock()
	if table == nil {
		return nil
	}
	portable := table.PublishedRoutes()
	routes := make([]*connectorRoute, 0, len(portable))
	for _, candidate := range portable {
		if route, ok := candidate.(*connectorRoute); ok && len(route.mcpTools) > 0 {
			routes = append(routes, route)
		}
	}
	return routes
}

// Tools reads each active downstream MCP directly. Route activation keeps only
// bootstrap evidence; it is not an Agent-visible tool-list cache.
func (registry *MCPRegistry) Tools(ctx context.Context) ([]MCPTool, error) {
	routes := registry.activeRoutes()
	type routeToolsResult struct {
		route *connectorRoute
		tools []mcpTool
		err   error
	}
	results := make(chan routeToolsResult, len(routes))
	for _, route := range routes {
		go func(route *connectorRoute) {
			tools, err := registry.listRouteTools(ctx, route)
			results <- routeToolsResult{route: route, tools: tools, err: err}
		}(route)
	}
	seen := make(map[string]struct{})
	result := make([]MCPTool, 0)
	var listErr error
	succeeded := 0
	for range routes {
		listed := <-results
		if listed.err != nil {
			listErr = errors.Join(listErr, fmt.Errorf("%s: %w", listed.route.connectorKey, listed.err))
			slog.Warn("connector MCP tools/list omitted unavailable route", "connectorKey", listed.route.connectorKey, "error", listed.err)
			continue
		}
		succeeded++
		for _, tool := range listed.tools {
			localName := listed.route.connectorKey + "_" + tool.Name
			if _, duplicate := seen[localName]; duplicate {
				continue
			}
			seen[localName] = struct{}{}
			result = append(result, MCPTool{Name: localName, Description: tool.Description,
				InputSchema: cloneJSONMap(tool.InputSchema), ConnectorKey: listed.route.connectorKey,
				ConnectorVersion: listed.route.connectorVersion})
		}
	}
	if len(routes) > 0 && succeeded == 0 {
		return nil, listErr
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result, nil
}

// Call resolves a native namespaced tool against an immutable current route.
// Duplicate bindings fail closed instead of selecting an arbitrary account or
// generation.
func (registry *MCPRegistry) Call(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	return registry.CallValidated(ctx, name, arguments, nil)
}

// CallValidated resolves the current downstream Tool once, lets the local
// transport validate request-integrity headers against that exact live schema,
// and then calls the same binding.
func (registry *MCPRegistry) CallValidated(ctx context.Context, name string, arguments map[string]any, validate func(MCPTool) error) (json.RawMessage, error) {
	return registry.CallProjectedValidated(ctx, name, arguments, nil, validate)
}

// CallProjectedValidated resolves the current downstream Tool once, projects
// an authority-specific validation schema, validates that projected contract,
// and calls the same immutable live binding. Projection cannot rename a Tool,
// change its Connector provenance, or remove its input schema.
func (registry *MCPRegistry) CallProjectedValidated(
	ctx context.Context,
	name string,
	arguments map[string]any,
	project MCPToolProjection,
	validate func(MCPTool) error,
) (json.RawMessage, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("connector MCP tool was not found")
	}
	type candidateResult struct {
		route *connectorRoute
		tools []mcpTool
		err   error
	}
	candidates := make([]*connectorRoute, 0)
	for _, route := range registry.activeRoutes() {
		if strings.HasPrefix(name, route.connectorKey+"_") {
			candidates = append(candidates, route)
		}
	}
	results := make(chan candidateResult, len(candidates))
	for _, route := range candidates {
		go func(route *connectorRoute) {
			tools, err := registry.listRouteTools(ctx, route)
			results <- candidateResult{route: route, tools: tools, err: err}
		}(route)
	}
	type resolvedBinding struct {
		binding registeredMCPTool
		owner   *connectorRoute
		tool    MCPTool
	}
	bindings := make([]resolvedBinding, 0, 1)
	var resolveErr error
	for range candidates {
		listed := <-results
		if listed.err != nil {
			resolveErr = errors.Join(resolveErr, fmt.Errorf("%s: %w", listed.route.connectorKey, listed.err))
			continue
		}
		for _, tool := range listed.tools {
			localName := listed.route.connectorKey + "_" + tool.Name
			if localName != name {
				continue
			}
			bindings = append(bindings, resolvedBinding{
				binding: registeredMCPTool{localName: localName, upstreamName: tool.Name, client: routeMCPCaller(listed.route)}, owner: listed.route,
				tool: MCPTool{Name: localName, Description: tool.Description, InputSchema: cloneJSONMap(tool.InputSchema),
					ConnectorKey: listed.route.connectorKey, ConnectorVersion: listed.route.connectorVersion},
			})
		}
	}
	if len(bindings) == 0 {
		if resolveErr != nil {
			return nil, resolveErr
		}
		return nil, errors.New("connector MCP tool was not found")
	}
	if len(bindings) != 1 {
		return nil, errors.New("connector MCP tool binding is ambiguous")
	}
	resolved := bindings[0]
	validationTool := resolved.tool
	if project != nil {
		projected, err := project(validationTool)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(projected.Name) != validationTool.Name || projected.InputSchema == nil ||
			strings.TrimSpace(projected.ConnectorKey) != validationTool.ConnectorKey ||
			strings.TrimSpace(projected.ConnectorVersion) != validationTool.ConnectorVersion {
			return nil, errors.New("connector MCP projected tool contract is invalid")
		}
		validationTool = projected
	}
	if validate != nil {
		if err := validate(validationTool); err != nil {
			return nil, err
		}
	}
	if !registry.routeCurrent(resolved.owner) {
		return nil, errors.New("connector MCP route is no longer active")
	}
	result, err := resolved.binding.client.Call(ctx, "tools/call", map[string]any{
		"name": resolved.binding.upstreamName, "arguments": arguments,
	})
	if err != nil {
		registry.observeAuthorizationError(err)
	}
	return result, err
}

func (registry *MCPRegistry) listRouteTools(ctx context.Context, route *connectorRoute) ([]mcpTool, error) {
	client := routeMCPCaller(route)
	if client == nil {
		return nil, errors.New("connector MCP route is unavailable")
	}
	var tools []mcpTool
	var err error
	if route.remoteMCP != nil {
		tools, err = listModernMCPTools(ctx, client)
	} else {
		tools, err = listMCPTools(ctx, client)
	}
	if err != nil {
		registry.observeAuthorizationError(err)
		return nil, err
	}
	if err := validateMCPToolContracts(route.connectorKey, tools); err != nil {
		return nil, err
	}
	if route.remoteMCP != nil {
		schemas := make(map[string]map[string]any, len(tools))
		for _, tool := range tools {
			schemas[tool.Name] = tool.InputSchema
		}
		if err := route.remoteMCP.ReplaceTools(schemas); err != nil {
			return nil, err
		}
	}
	return tools, nil
}

func routeMCPCaller(route *connectorRoute) mcpCaller {
	if route == nil {
		return nil
	}
	if route.remoteMCP != nil {
		return route.remoteMCP
	}
	if route.mcpClient != nil {
		return route.mcpClient
	}
	for _, tool := range route.mcpTools {
		return tool.client
	}
	return nil
}

func (registry *MCPRegistry) observeAuthorizationError(err error) {
	var rpcErr *connectormcp.RPCError
	if !errors.As(err, &rpcErr) ||
		(rpcErr.Code != mcpAuthorizationRequiredCode && rpcErr.Code != mcpAuthorizationExpiredCode) {
		return
	}
	registry.mu.RLock()
	observer := registry.authorizationErrorObserver
	registry.mu.RUnlock()
	if observer != nil {
		observer()
	}
}

func (registry *MCPRegistry) SetAuthorizationErrorObserver(observer func()) {
	if registry == nil {
		return
	}
	registry.mu.Lock()
	registry.authorizationErrorObserver = observer
	registry.mu.Unlock()
}

func (registry *MCPRegistry) routeCurrent(route *connectorRoute) bool {
	registry.mu.RLock()
	table := registry.routes
	registry.mu.RUnlock()
	return table != nil && table.IsCurrent(route)
}

// Subscribe is used by the local MCP server to fan out
// notifications/tools/list_changed. Notifications are edge-triggered and
// coalesced for slow consumers.
func (registry *MCPRegistry) Subscribe() (<-chan struct{}, func()) {
	if registry == nil {
		closed := make(chan struct{})
		close(closed)
		return closed, func() {}
	}
	registry.mu.Lock()
	registry.nextID++
	id := registry.nextID
	updates := make(chan struct{}, 1)
	registry.subscribers[id] = updates
	registry.mu.Unlock()
	return updates, func() {
		registry.mu.Lock()
		if current, ok := registry.subscribers[id]; ok {
			delete(registry.subscribers, id)
			close(current)
		}
		registry.mu.Unlock()
	}
}

func (registry *MCPRegistry) notifyChanged() {
	if registry == nil {
		return
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for _, updates := range registry.subscribers {
		select {
		case updates <- struct{}{}:
		default:
		}
	}
}

func cloneJSONMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	return result
}
