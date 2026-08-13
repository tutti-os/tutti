package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

type registryMCPCaller struct {
	method string
	params map[string]any
}

type failingListCaller struct{}

func (failingListCaller) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	if method == "tools/list" {
		return nil, errors.New("unrelated connector unavailable")
	}
	return nil, errors.New("unexpected call")
}

func (caller *registryMCPCaller) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	caller.method = method
	caller.params, _ = params.(map[string]any)
	if method == "tools/list" {
		return json.RawMessage(`{"tools":[{"name":"status","description":"Read status","inputSchema":{"type":"object","oneOf":[{"required":["id"]}]}}]}`), nil
	}
	return json.RawMessage(`{"content":[{"type":"text","text":"ready"}]}`), nil
}

func TestMCPRegistryListsCallsAndNotifies(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	caller := &registryMCPCaller{}
	route := &connectorRoute{id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github", connectorVersion: "2.0.0",
		releaseDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		generation:    market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
		mcpTools: map[string]registeredMCPTool{
			"github_status": {routeID: "connector.github.mcp.status", localName: "github_status", upstreamName: "status",
				description: "Read status", inputSchema: map[string]any{"type": "object", "oneOf": []any{map[string]any{"required": []any{"id"}}}}, client: caller},
		}}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	tools, err := registry.Tools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "github_status" || tools[0].InputSchema["type"] != "object" ||
		tools[0].ConnectorKey != "github" || tools[0].ConnectorVersion != "2.0.0" {
		t.Fatalf("tools = %#v", tools)
	}
	if _, preserved := tools[0].InputSchema["oneOf"]; !preserved {
		t.Fatalf("native MCP JSON Schema was narrowed: %#v", tools[0].InputSchema)
	}
	encoded, err := json.Marshal(tools[0])
	if err != nil || strings.Contains(string(encoded), "ConnectorKey") || strings.Contains(string(encoded), "connectorKey") ||
		strings.Contains(string(encoded), "ConnectorVersion") || strings.Contains(string(encoded), "connectorVersion") {
		t.Fatalf("trusted Connector provenance leaked into MCP JSON: %s, %v", encoded, err)
	}
	raw, err := registry.Call(context.Background(), "github_status", map[string]any{"verbose": true})
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
	if tools, err := registry.Tools(context.Background()); err != nil || len(tools) != 0 {
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

func TestMCPRegistryCallDoesNotListUnrelatedConnector(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	target := &registryMCPCaller{}
	routes := []*connectorRoute{
		{id: connectorRouteKey("default", "slow"), connectionID: "default", connectorKey: "slow", releaseDigest: strings.Repeat("a", 64),
			generation: market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
			mcpTools: map[string]registeredMCPTool{"slow_wait": {client: failingListCaller{}}}},
		{id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github", releaseDigest: strings.Repeat("b", 64),
			generation: market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
			mcpTools: map[string]registeredMCPTool{"github_status": {client: target}}},
	}
	for _, route := range routes {
		if err := table.Commit(route); err != nil {
			t.Fatal(err)
		}
	}
	tools, err := registry.Tools(context.Background())
	if err != nil || len(tools) != 1 || tools[0].Name != "github_status" {
		t.Fatalf("partial tools = %#v, %v", tools, err)
	}
	if _, err := registry.Call(context.Background(), "github_status", map[string]any{}); err != nil {
		t.Fatalf("target call was blocked by unrelated connector: %v", err)
	}
}

func TestMCPRegistryCallIsolatesFailingOverlappingNamespaceCandidate(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	target := &registryMCPCaller{}
	routes := []*connectorRoute{
		{id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github", releaseDigest: strings.Repeat("a", 64),
			generation: market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
			mcpTools: map[string]registeredMCPTool{"github_wait": {client: failingListCaller{}}}},
		{id: connectorRouteKey("default", "github_enterprise"), connectionID: "default", connectorKey: "github_enterprise", releaseDigest: strings.Repeat("b", 64),
			generation: market.HostGeneration{BootEpoch: "boot", Generation: 1}, processes: connectorruntime.NewProcessGroup(),
			mcpTools: map[string]registeredMCPTool{"github_enterprise_status": {client: target}}},
	}
	for _, route := range routes {
		if err := table.Commit(route); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := registry.Call(context.Background(), "github_enterprise_status", map[string]any{}); err != nil {
		t.Fatalf("overlapping failed candidate blocked target call: %v", err)
	}
}

func TestMCPRegistryCallProjectedValidatedUsesSelectedLiveSchemaAndBinding(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	caller := &registryMCPCaller{}
	route := &connectorRoute{
		id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github", connectorVersion: "2.0.0",
		releaseDigest: strings.Repeat("a", 64), generation: market.HostGeneration{BootEpoch: "boot", Generation: 1},
		processes: connectorruntime.NewProcessGroup(),
		mcpTools:  map[string]registeredMCPTool{"github_status": {client: caller}},
	}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	projected := false
	validated := false
	raw, err := registry.CallProjectedValidated(
		context.Background(), "github_status", map[string]any{"connectorAuthority": "owner"},
		func(tool MCPTool) (MCPTool, error) {
			projected = true
			if tool.ConnectorKey != "github" || tool.ConnectorVersion != "2.0.0" {
				t.Fatalf("projection Connector provenance = %q@%q", tool.ConnectorKey, tool.ConnectorVersion)
			}
			if _, ok := tool.InputSchema["oneOf"]; !ok {
				t.Fatalf("projection did not receive live native schema: %#v", tool.InputSchema)
			}
			tool.InputSchema["properties"] = map[string]any{
				"connectorAuthority": map[string]any{"type": "string", "enum": []any{"owner"}},
			}
			return tool, nil
		},
		func(tool MCPTool) error {
			validated = true
			properties, _ := tool.InputSchema["properties"].(map[string]any)
			if properties["connectorAuthority"] == nil {
				t.Fatalf("validator did not receive authority-specific schema: %#v", tool.InputSchema)
			}
			return nil
		},
	)
	if err != nil || len(raw) == 0 || !projected || !validated || caller.method != "tools/call" || caller.params["name"] != "status" {
		t.Fatalf("projected call raw=%s projected=%v validated=%v method=%q params=%#v err=%v", raw, projected, validated, caller.method, caller.params, err)
	}
}

func TestMCPRegistryCallProjectedValidatedRejectsRenamedContractBeforeCall(t *testing.T) {
	table := connectorruntime.NewRouteTable()
	registry := NewMCPRegistry()
	registry.attach(table)
	caller := &registryMCPCaller{}
	route := &connectorRoute{
		id: connectorRouteKey("default", "github"), connectionID: "default", connectorKey: "github",
		releaseDigest: strings.Repeat("b", 64), generation: market.HostGeneration{BootEpoch: "boot", Generation: 1},
		processes: connectorruntime.NewProcessGroup(),
		mcpTools:  map[string]registeredMCPTool{"github_status": {client: caller}},
	}
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	_, err := registry.CallProjectedValidated(context.Background(), "github_status", nil, func(tool MCPTool) (MCPTool, error) {
		tool.Name = "github_other"
		return tool, nil
	}, nil)
	if err == nil || caller.method == "tools/call" {
		t.Fatalf("renamed projected contract reached upstream: method=%q err=%v", caller.method, err)
	}
}

func TestMCPRegistryCallProjectedValidatedRejectsChangedConnectorProvenance(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*MCPTool)
	}{
		{name: "key", mutate: func(tool *MCPTool) { tool.ConnectorKey = "foo" }},
		{name: "version", mutate: func(tool *MCPTool) { tool.ConnectorVersion = "1.0.0" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			table := connectorruntime.NewRouteTable()
			registry := NewMCPRegistry()
			registry.attach(table)
			caller := &registryMCPCaller{}
			route := &connectorRoute{
				id: connectorRouteKey("default", "foo_bar"), connectionID: "default",
				connectorKey: "foo_bar", connectorVersion: "2.0.0",
				releaseDigest: strings.Repeat("c", 64), generation: market.HostGeneration{BootEpoch: "boot", Generation: 1},
				processes: connectorruntime.NewProcessGroup(),
				mcpTools:  map[string]registeredMCPTool{"foo_bar_status": {client: caller}},
			}
			if err := table.Commit(route); err != nil {
				t.Fatal(err)
			}
			_, err := registry.CallProjectedValidated(context.Background(), "foo_bar_status", nil, func(tool MCPTool) (MCPTool, error) {
				if tool.ConnectorKey != "foo_bar" || tool.ConnectorVersion != "2.0.0" {
					t.Fatalf("exact route provenance = %q@%q", tool.ConnectorKey, tool.ConnectorVersion)
				}
				test.mutate(&tool)
				return tool, nil
			}, nil)
			if err == nil || caller.method == "tools/call" {
				t.Fatalf("changed Connector provenance reached upstream: method=%q err=%v", caller.method, err)
			}
		})
	}
}
