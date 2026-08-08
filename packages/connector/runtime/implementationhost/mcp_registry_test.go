package implementationhost

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

type registryMCPCaller struct {
	method string
	params map[string]any
}

func (caller *registryMCPCaller) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	caller.method = method
	caller.params, _ = params.(map[string]any)
	return json.RawMessage(`{"content":[{"type":"text","text":"ready"}]}`), nil
}

func TestMCPRegistryListsCallsFiltersAndNotifies(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	caller := &registryMCPCaller{}
	route := &connectorRoute{id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github",
		releaseDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		generation:    market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
		mcpTools: map[string]registeredMCPTool{
			"github_status": {routeID: "connector.github.mcp.status", localName: "github_status", upstreamName: "status",
				description: "Read status", inputSchema: map[string]any{"type": "object", "oneOf": []any{map[string]any{"required": []any{"id"}}}}, client: caller},
		}}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	tools := registry.Tools(nil)
	if len(tools) != 1 || tools[0].Name != "github_status" || tools[0].InputSchema["type"] != "object" {
		t.Fatalf("tools = %#v", tools)
	}
	if _, preserved := tools[0].InputSchema["oneOf"]; !preserved {
		t.Fatalf("native MCP JSON Schema was narrowed: %#v", tools[0].InputSchema)
	}
	if filtered := registry.Tools(map[string]struct{}{"notion": {}}); len(filtered) != 0 {
		t.Fatalf("filtered tools = %#v", filtered)
	}
	raw, err := registry.Call(context.Background(), map[string]struct{}{"github": {}}, "github_status", map[string]any{"verbose": true})
	if err != nil || len(raw) == 0 || caller.method != "tools/call" || caller.params["name"] != "status" {
		t.Fatalf("call raw=%s method=%q params=%#v err=%v", raw, caller.method, caller.params, err)
	}
	updates, unsubscribe := registry.Subscribe()
	defer unsubscribe()
	registry.notifyChanged()
	select {
	case <-updates:
	case <-time.After(time.Second):
		t.Fatal("registry notification was not delivered")
	}
	if err := table.Remove(route.id, route.generation, route.releaseDigest, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if tools := registry.Tools(nil); len(tools) != 0 {
		t.Fatalf("retired tools = %#v", tools)
	}
}

func TestRegisterMCPToolsKeepsNativeNamesAndSchemasOutsideLegacyCommandSubset(t *testing.T) {
	route := &connectorRoute{connectorKey: "lark-cli", mcpTools: make(map[string]registeredMCPTool)}
	caller := &registryMCPCaller{}
	err := (&Host{}).registerMCPTools(route, caller, []mcpTool{{
		Name: "Read:Item", InputSchema: map[string]any{
			"oneOf": []any{map[string]any{"type": "object"}, map[string]any{"type": "null"}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	registered, ok := route.mcpTools["lark-cli_Read:Item"]
	if !ok || registered.upstreamName != "Read:Item" || registered.routeID != "connector.lark-cli.mcp.Read:Item" {
		t.Fatalf("registered MCP tool = %#v", route.mcpTools)
	}
}
