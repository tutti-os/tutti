package browser

import (
	"context"
	"testing"

	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type fakeBrowserService struct {
	workspaceID    string
	agentSessionID string
	agentTurnID    string
	tool           string
	args           map[string]any
}

func (f *fakeBrowserService) CallToolForAgent(
	_ context.Context,
	workspaceID string,
	_ string,
	agentSessionID string,
	agentTurnID string,
	tool string,
	args map[string]any,
) (browsersvc.ToolResult, error) {
	f.workspaceID = workspaceID
	f.agentSessionID = agentSessionID
	f.agentTurnID = agentTurnID
	f.tool = tool
	f.args = args
	return browsersvc.ToolResult{Text: "opened page"}, nil
}

type fakeAgentTurnReader struct {
	turnID string
}

func (f fakeAgentTurnReader) PersistedActiveTurnID(context.Context, string, string) (string, error) {
	return f.turnID, nil
}

func TestProviderBrowserCommandsAdvertiseJSONOutput(t *testing.T) {
	commands := NewProvider(nil, &fakeBrowserService{}).Commands()
	for _, command := range commands {
		if !command.Capability.Output.JSON {
			t.Errorf("command %q does not advertise JSON output", command.Capability.ID)
		}
	}
}

func TestProviderOpenCreatesAgentBrowserPage(t *testing.T) {
	browser := &fakeBrowserService{}
	commands := NewProvider(nil, browser, fakeAgentTurnReader{turnID: "turn-1"}).Commands()
	var openCommand cliservice.Command
	for _, command := range commands {
		if command.Capability.ID == "browser.open" {
			openCommand = command
			break
		}
	}
	if openCommand.Handler == nil {
		t.Fatal("browser.open command is unavailable")
	}

	output, err := openCommand.Handler(t.Context(), cliservice.InvokeRequest{
		Input:      map[string]any{"url": "https://example.com"},
		OutputMode: cliservice.OutputModeJSON,
		Context: cliservice.InvokeContext{
			AgentSessionID: "agent-session-1",
			WorkspaceID:    "workspace-1",
		},
	})
	if err != nil {
		t.Fatalf("invoke browser.open: %v", err)
	}
	if browser.tool != "new_page" || browser.args["url"] != "https://example.com" {
		t.Fatalf("browser call = %q %#v", browser.tool, browser.args)
	}
	if browser.workspaceID != "workspace-1" || browser.agentSessionID != "agent-session-1" {
		t.Fatalf("browser scope = workspace %q, agent session %q", browser.workspaceID, browser.agentSessionID)
	}
	if browser.agentTurnID != "turn-1" {
		t.Fatalf("browser agent turn = %q, want turn-1", browser.agentTurnID)
	}
	if output.Kind != cliservice.OutputModeJSON || output.Value["text"] != "opened page" {
		t.Fatalf("output = %#v", output)
	}
}
