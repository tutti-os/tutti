package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"

	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

// MCPTool is the connector-scoped projection exposed by the local connector
// MCP server. UpstreamName is deliberately not serialized: callers use the
// namespaced local name and the registry resolves the upstream binding.
type MCPTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema"`
}

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
	mu          sync.RWMutex
	routes      *connectorruntime.RouteTable
	subscribers map[uint64]chan struct{}
	nextID      uint64
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

// Tools returns the stable native MCP projection for the allowed Connector
// keys. A nil set authorizes every active Connector; a non-nil empty set
// authorizes none.
func (registry *MCPRegistry) Tools(allowedKeys map[string]struct{}) []MCPTool {
	if allowedKeys != nil && len(allowedKeys) == 0 {
		return []MCPTool{}
	}
	seen := make(map[string]struct{})
	result := make([]MCPTool, 0)
	for _, route := range registry.activeRoutes() {
		if allowedKeys != nil {
			if _, allowed := allowedKeys[route.connectorKey]; !allowed {
				continue
			}
		}
		for _, tool := range route.mcpTools {
			if _, duplicate := seen[tool.localName]; duplicate {
				continue
			}
			seen[tool.localName] = struct{}{}
			result = append(result, MCPTool{Name: tool.localName, Description: tool.description,
				InputSchema: cloneJSONMap(tool.inputSchema)})
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result
}

// Call resolves a native namespaced tool against an immutable current route.
// Duplicate bindings fail closed instead of selecting an arbitrary account or
// generation.
func (registry *MCPRegistry) Call(ctx context.Context, allowedKeys map[string]struct{}, name string,
	arguments map[string]any) (json.RawMessage, error) {
	name = strings.TrimSpace(name)
	if name == "" || (allowedKeys != nil && len(allowedKeys) == 0) {
		return nil, errors.New("connector MCP tool was not found")
	}
	var binding *registeredMCPTool
	var owner *connectorRoute
	for _, route := range registry.activeRoutes() {
		if allowedKeys != nil {
			if _, allowed := allowedKeys[route.connectorKey]; !allowed {
				continue
			}
		}
		tool, found := route.mcpTools[name]
		if !found {
			continue
		}
		if binding != nil {
			return nil, errors.New("connector MCP tool binding is ambiguous")
		}
		copy := tool
		binding, owner = &copy, route
	}
	if binding == nil || owner == nil {
		return nil, errors.New("connector MCP tool was not found")
	}
	if !registry.routeCurrent(owner) {
		return nil, errors.New("connector MCP route is no longer active")
	}
	return binding.client.Call(ctx, "tools/call", map[string]any{
		"name": binding.upstreamName, "arguments": arguments,
	})
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
