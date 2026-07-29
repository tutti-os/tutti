package computer

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

func TestNativeToolCommandsAreRegistered(t *testing.T) {
	commands := NewProvider(nil, &fakeComputerService{}).Commands()
	for _, id := range []string{"computer.tool.list", "computer.tool.describe", "computer.tool.call"} {
		commandByID(t, commands, id)
	}
}

func TestNativeToolListRendersCompleteCatalogAuthorization(t *testing.T) {
	computer := &fakeComputerService{catalog: testToolCatalog()}
	command := commandByID(t, NewProvider(nil, computer).Commands(), "computer.tool.list")
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatalf("tool list: %v", err)
	}
	tools := output.Value["tools"].([]map[string]any)
	if len(tools) != 3 || tools[0]["name"] != "click" || tools[1]["name"] != "get_desktop_state" || tools[2]["name"] != "set_config" {
		t.Fatalf("tools = %#v", tools)
	}
	if tools[0]["allowed"] != true || tools[0]["denialReason"] != "" {
		t.Fatalf("allowed row = %#v", tools[0])
	}
	if tools[2]["allowed"] != true || tools[2]["denialReason"] != "" {
		t.Fatalf("config row = %#v", tools[2])
	}
	if !reflect.DeepEqual(tools[2]["inputSchema"], map[string]any{"type": "object"}) || !reflect.DeepEqual(tools[2]["capabilities"], []string{"system.config.write"}) {
		t.Fatalf("catalog metadata = %#v", tools[2])
	}

	tableRows := toolListRows(computer.catalog.Tools)
	if tableRows[2]["allowed"] != true || tableRows[2]["denialReason"] != "" {
		t.Fatalf("table row = %#v", tableRows[2])
	}
}

func TestNativeToolDescribeReturnsAllowedConfigWriteAuthorization(t *testing.T) {
	computer := &fakeComputerService{catalog: testToolCatalog()}
	command := commandByID(t, NewProvider(nil, computer).Commands(), "computer.tool.describe")
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"name": "set_config"},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatalf("tool describe: %v", err)
	}
	if output.Value["name"] != "set_config" || output.Value["allowed"] != true || output.Value["denialReason"] != "" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestNativeToolCallForwardsJSONArgumentsWithoutPerToolBinding(t *testing.T) {
	computer := &fakeComputerService{
		catalog: testToolCatalog(),
		result: computersvc.ToolResult{
			Text:              "clicked",
			StructuredContent: map[string]any{"verified": false},
			Raw:               json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"clicked"},{"type":"resource_link","uri":"file:///tmp/result"}],"structuredContent":{"verified":false},"futureField":true,"largeId":9007199254740993}`),
			IsError:           true,
		},
	}
	command := commandByID(t, NewProvider(nil, computer).Commands(), "computer.tool.call")
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"name":           "click",
			"arguments-json": `{"scope":"desktop","x":120,"y":240}`,
		},
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatalf("tool call: %v", err)
	}
	if len(computer.nativeCalls) != 1 {
		t.Fatalf("native calls = %#v", computer.nativeCalls)
	}
	call := computer.nativeCalls[0]
	wantArgs := map[string]any{
		"scope": "desktop",
		"x":     json.Number("120"),
		"y":     json.Number("240"),
	}
	if call.tool != "click" || !reflect.DeepEqual(call.args, wantArgs) {
		t.Fatalf("call = %#v, want click %#v", call, wantArgs)
	}
	content := output.Value["content"].([]any)
	if len(content) != 2 || output.Value["isError"] != true || output.Value["futureField"] != true || output.Value["largeId"] != json.Number("9007199254740993") || !reflect.DeepEqual(output.Value["structuredContent"], map[string]any{"verified": false}) {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestNativeToolCallForwardsGlobalConfigWriteToServicePolicy(t *testing.T) {
	computer := &fakeComputerService{catalog: testToolCatalog()}
	command := commandByID(t, NewProvider(nil, computer).Commands(), "computer.tool.call")
	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"name":           "set_config",
			"arguments-json": `{"capture_scope":"desktop"}`,
		},
		OutputMode: cliservice.OutputModePlain,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatalf("tool call: %v", err)
	}
	if len(computer.nativeCalls) != 1 || computer.nativeCalls[0].tool != "set_config" ||
		computer.nativeCalls[0].args["capture_scope"] != "desktop" {
		t.Fatalf("native calls: %#v", computer.nativeCalls)
	}
}

func testToolCatalog() computersvc.ToolCatalog {
	return computersvc.ToolCatalog{
		SchemaVersion:     "1",
		CapabilityVersion: "1",
		Tools: []computersvc.ToolDefinition{
			{
				Name:         "click",
				Description:  "Click",
				InputSchema:  map[string]any{"type": "object"},
				Capabilities: []string{"input.pointer.click"},
				Allowed:      true,
			},
			{
				Name:         "get_desktop_state",
				Description:  "Capture desktop",
				InputSchema:  map[string]any{"type": "object"},
				Capabilities: []string{"screen.capture"},
				Annotations:  computersvc.ToolAnnotations{ReadOnly: true},
				Allowed:      true,
			},
			{
				Name:         "set_config",
				Description:  "Set global driver config",
				InputSchema:  map[string]any{"type": "object"},
				Capabilities: []string{"system.config.write"},
				Allowed:      true,
			},
		},
	}
}
