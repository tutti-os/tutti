package computer

import (
	"context"
	"errors"
	"reflect"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

type recordedToolCall struct {
	workspaceID string
	tool        string
	args        map[string]any
}

type fakeComputerService struct {
	calls       []recordedToolCall
	nativeCalls []recordedToolCall
	result      computersvc.ToolResult
	catalog     computersvc.ToolCatalog
}

func (f *fakeComputerService) CallTool(_ context.Context, workspaceID, _ string, tool string, args map[string]any) (computersvc.ToolResult, error) {
	f.calls = append(f.calls, recordedToolCall{workspaceID: workspaceID, tool: tool, args: args})
	if f.result.Text == "" {
		f.result.Text = "ok"
	}
	return f.result, nil
}

func (f *fakeComputerService) CallNativeTool(_ context.Context, workspaceID, _ string, tool string, args map[string]any) (computersvc.ToolResult, error) {
	f.nativeCalls = append(f.nativeCalls, recordedToolCall{workspaceID: workspaceID, tool: tool, args: args})
	if f.result.Text == "" {
		f.result.Text = "ok"
	}
	return f.result, nil
}

func (f *fakeComputerService) ListTools(context.Context, string, string) (computersvc.ToolCatalog, error) {
	return f.catalog, nil
}

func TestStableComputerCommandSchemasExposeWindowTargetsWithoutSyntheticScope(t *testing.T) {
	provider := NewProvider(nil, &fakeComputerService{})

	screenshot := commandByID(t, provider.Commands(), "computer.screenshot")
	assertNoSchemaProperty(t, screenshot, "scope")
	assertSchemaProperty(t, screenshot, "pid", "integer")
	assertSchemaProperty(t, screenshot, "window-id", "integer")

	for _, commandID := range []string{"computer.click", "computer.double-click", "computer.right-click", "computer.scroll"} {
		command := commandByID(t, provider.Commands(), commandID)
		assertSchemaProperty(t, command, "x", "integer")
		assertSchemaProperty(t, command, "y", "integer")
		assertNoSchemaProperty(t, command, "scope")
		assertSchemaProperty(t, command, "pid", "integer")
		assertSchemaProperty(t, command, "window-id", "integer")
	}

	scroll := commandByID(t, provider.Commands(), "computer.scroll")
	assertSchemaProperty(t, scroll, "amount", "integer")
}

func TestStableScreenshotRoutesOnlyWindowTargets(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{
			name:  "explicit window",
			input: map[string]any{"pid": "42", "window-id": "99"},
			want:  map[string]any{"pid": 42, "window_id": 99},
		},
		{
			name:  "compatible automatic window",
			input: map[string]any{},
			want:  map[string]any{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			computer := &fakeComputerService{}
			command := commandByID(t, NewProvider(nil, computer).Commands(), "computer.screenshot")
			invokeCommand(t, command, tt.input)
			assertSingleToolCall(t, computer, "screenshot", tt.want)
		})
	}
}

func TestPointerCommandsPassNativeNumericArguments(t *testing.T) {
	tests := []struct {
		name      string
		commandID string
		tool      string
		input     map[string]any
		want      map[string]any
	}{
		{
			name:      "explicit window click",
			commandID: "computer.click",
			tool:      "click",
			input:     map[string]any{"pid": "42", "window-id": "99", "x": "120", "y": "240"},
			want:      map[string]any{"pid": 42, "window_id": 99, "x": 120, "y": 240},
		},
		{
			name:      "explicit window double click",
			commandID: "computer.double-click",
			tool:      "click",
			input:     map[string]any{"pid": "42", "window-id": "99", "x": "120", "y": "240"},
			want:      map[string]any{"pid": 42, "window_id": 99, "x": 120, "y": 240, "count": 2},
		},
		{
			name:      "explicit window right click",
			commandID: "computer.right-click",
			tool:      "click",
			input:     map[string]any{"pid": "42", "window-id": "99", "x": "120", "y": "240"},
			want:      map[string]any{"pid": 42, "window_id": 99, "x": 120, "y": 240, "button": "right"},
		},
		{
			name:      "move cursor",
			commandID: "computer.move-cursor",
			tool:      "move_cursor",
			input:     map[string]any{"x": "120", "y": "240"},
			want:      map[string]any{"x": 120, "y": 240},
		},
		{
			name:      "window scroll",
			commandID: "computer.scroll",
			tool:      "scroll",
			input:     map[string]any{"pid": "42", "window-id": "99", "x": "120", "y": "240", "direction": "down", "amount": "4"},
			want:      map[string]any{"pid": 42, "window_id": 99, "x": 120, "y": 240, "direction": "down", "amount": 4},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			computer := &fakeComputerService{}
			command := commandByID(t, NewProvider(nil, computer).Commands(), tt.commandID)
			invokeCommand(t, command, tt.input)
			assertSingleToolCall(t, computer, tt.tool, tt.want)
		})
	}
}

func TestKeyboardCommandsPassExplicitWindowTarget(t *testing.T) {
	tests := []struct {
		commandID string
		input     map[string]any
		tool      string
		want      map[string]any
	}{
		{
			commandID: "computer.type",
			input:     map[string]any{"text": "hello", "pid": "42", "window-id": "99"},
			tool:      "type_text",
			want:      map[string]any{"text": "hello", "pid": 42, "window_id": 99},
		},
		{
			commandID: "computer.press-key",
			input:     map[string]any{"key": "cmd+c", "pid": "42", "window-id": "99"},
			tool:      "press_key",
			want:      map[string]any{"key": "cmd+c", "pid": 42, "window_id": 99},
		},
	}

	for _, tt := range tests {
		t.Run(tt.commandID, func(t *testing.T) {
			computer := &fakeComputerService{}
			command := commandByID(t, NewProvider(nil, computer).Commands(), tt.commandID)
			invokeCommand(t, command, tt.input)
			assertSingleToolCall(t, computer, tt.tool, tt.want)
		})
	}
}

func TestComputerCommandsRejectPartialWindowTargets(t *testing.T) {
	tests := []struct {
		name      string
		commandID string
		input     map[string]any
	}{
		{
			name:      "partial window target",
			commandID: "computer.screenshot",
			input:     map[string]any{"pid": "42"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			computer := &fakeComputerService{}
			command := commandByID(t, NewProvider(nil, computer).Commands(), tt.commandID)
			_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
				Input:      tt.input,
				OutputMode: cliservice.OutputModePlain,
				Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
			})
			if !errors.Is(err, cliservice.ErrInvalidInput) {
				t.Fatalf("err = %v, want ErrInvalidInput", err)
			}
			if len(computer.calls) != 0 {
				t.Fatalf("unexpected tool calls: %#v", computer.calls)
			}
		})
	}
}

func TestComputerCommandsSupportJSONOutput(t *testing.T) {
	computer := &fakeComputerService{result: computersvc.ToolResult{
		Text:              "Screenshot saved to /tmp/screenshot.png",
		StructuredContent: map[string]any{"screenshot_file_path": "/tmp/screenshot.png"},
	}}
	commands := NewProvider(nil, computer).Commands()
	for _, command := range commands {
		if !command.Capability.Output.JSON {
			t.Errorf("%s does not advertise JSON output", command.Capability.ID)
		}
	}

	screenshot := commandByID(t, commands, "computer.screenshot")
	output, err := screenshot.Handler(context.Background(), cliservice.InvokeRequest{
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	})
	if err != nil {
		t.Fatalf("invoke screenshot JSON: %v", err)
	}
	want := map[string]any{
		"text": "Screenshot saved to /tmp/screenshot.png",
		"structuredContent": map[string]any{
			"screenshot_file_path": "/tmp/screenshot.png",
		},
	}
	if !reflect.DeepEqual(output.Value, want) {
		t.Fatalf("JSON output = %#v, want %#v", output.Value, want)
	}
}

func commandByID(t *testing.T, commands []cliservice.Command, id string) cliservice.Command {
	t.Helper()
	for _, command := range commands {
		if command.Capability.ID == id {
			return command
		}
	}
	t.Fatalf("command %q not found", id)
	return cliservice.Command{}
}

func invokeCommand(t *testing.T, command cliservice.Command, input map[string]any) {
	t.Helper()
	if _, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      input,
		OutputMode: cliservice.OutputModePlain,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1"},
	}); err != nil {
		t.Fatalf("invoke %s: %v", command.Capability.ID, err)
	}
}

func assertSingleToolCall(t *testing.T, computer *fakeComputerService, tool string, args map[string]any) {
	t.Helper()
	if len(computer.calls) != 1 {
		t.Fatalf("calls = %#v, want one", computer.calls)
	}
	call := computer.calls[0]
	if call.workspaceID != "workspace-1" || call.tool != tool || !reflect.DeepEqual(call.args, args) {
		t.Fatalf("call = %#v, want workspace-1 %s %#v", call, tool, args)
	}
}

func assertSchemaProperty(t *testing.T, command cliservice.Command, name, propertyType string) {
	t.Helper()
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	property, ok := properties[name].(map[string]any)
	if !ok || property["type"] != propertyType {
		t.Fatalf("%s property %q = %#v, want type %q", command.Capability.ID, name, properties[name], propertyType)
	}
}

func assertNoSchemaProperty(t *testing.T, command cliservice.Command, name string) {
	t.Helper()
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	if _, ok := properties[name]; ok {
		t.Fatalf("%s unexpectedly exposes property %q: %#v", command.Capability.ID, name, properties[name])
	}
}
