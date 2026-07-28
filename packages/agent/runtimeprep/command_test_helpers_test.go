package runtimeprep

import (
	"context"
	"testing"
)

type staticCommandCatalog []CommandCapability

func (catalog staticCommandCatalog) Capabilities(_ context.Context, _ CommandContext) []CommandCapability {
	return append([]CommandCapability(nil), catalog...)
}

func newTestPreparer(stateDir string) *DefaultPreparer {
	preparer := NewDefaultPreparer(stateDir)
	preparer.CommandCatalog = staticCommandCatalog(testCommandCapabilities())
	return preparer
}

func testInputWithCommands(t testingT, input PrepareInput) PrepareInput {
	t.Helper()
	resolver, err := newCommandResolver(input.CLICommand, testCommandCapabilities())
	if err != nil {
		t.Fatal(err)
	}
	input.commandCapabilities = resolver
	return input
}

func testResolvedInput(t *testing.T, input PrepareInput) PrepareInput {
	t.Helper()
	input = testInputWithCommands(t, input)
	resolved, err := resolveCapabilities(t.Context(), input, StandardProfile(), nil)
	if err != nil {
		t.Fatal(err)
	}
	input.resolved = resolved
	return input
}

type testingT interface {
	Helper()
	Fatal(...any)
}

func testCommandCapabilities() []CommandCapability {
	command := func(id string, path []string, required []string, optional []string) CommandCapability {
		properties := make(map[string]any, len(required)+len(optional))
		for _, name := range append(append([]string(nil), required...), optional...) {
			properties[name] = map[string]any{"type": "string"}
		}
		return CommandCapability{
			ID:      id,
			Path:    path,
			Summary: id,
			InputSchema: map[string]any{
				"type":       "object",
				"properties": properties,
				"required":   required,
			},
			Output: CommandCapabilityOutput{DefaultMode: "table", JSON: true},
			Source: CommandSource{Kind: CommandSourceBuiltin},
		}
	}

	commands := []CommandCapability{
		command("issue-manager.issue.get", []string{"issue", "get"}, []string{"issue-id"}, nil),
		command("issue-manager.issue.update", []string{"issue", "update"}, []string{"issue-id"}, []string{"title", "content"}),
		command("issue-manager.issue.task.get", []string{"issue", "task", "get"}, []string{"issue-id", "task-id"}, nil),
		command("issue-manager.issue.task.create", []string{"issue", "task", "create"}, []string{"issue-id", "title"}, []string{"content"}),
		command("issue-manager.issue.task.create-batch", []string{"issue", "task", "create-batch"}, []string{"issue-id", "tasks-json"}, nil),
		command("issue-manager.issue.run.create", []string{"issue", "run", "create"}, []string{"issue-id", "agent-provider"}, []string{"agent-session-id"}),
		command("issue-manager.issue.task.run.create", []string{"issue", "task", "run", "create"}, []string{"issue-id", "task-id", "agent-provider"}, []string{"agent-session-id"}),
		command("issue-manager.issue.run.get", []string{"issue", "run", "get"}, []string{"issue-id", "run-id"}, nil),
		command("issue-manager.issue.task.run.get", []string{"issue", "task", "run", "get"}, []string{"issue-id", "task-id", "run-id"}, nil),
		command("issue-manager.issue.run.complete", []string{"issue", "run", "complete"}, []string{"issue-id", "run-id", "status"}, []string{"summary", "outputs"}),
		command("issue-manager.issue.task.run.complete", []string{"issue", "task", "run", "complete"}, []string{"issue-id", "task-id", "run-id", "status"}, []string{"summary", "outputs"}),
		command("issue-manager.issue.topic.list", []string{"issue", "topic", "list"}, []string{"issue-id"}, nil),
		command("workspace-apps.app.open", []string{"app", "open"}, []string{"app-id"}, nil),
		command("references.task.list", []string{"reference", "list"}, []string{"source", "id"}, []string{"group-id"}),
		command("agent-context.agent.list", []string{"agent", "list"}, nil, []string{"agent-id"}),
		command("agent-context.agent.start", []string{"agent", "start"}, []string{"agent-id", "prompt"}, []string{"show", "image"}),
		command("agent-context.agent.send", []string{"agent", "send"}, []string{"session-id", "prompt"}, nil),
		command("agent-context.agent.get", []string{"agent", "get"}, []string{"session-id"}, []string{"view", "turns", "turn-id"}),
		command("agent-context.agent.sessions", []string{"agent", "sessions"}, nil, nil),
		command("agent-context.agent.wait", []string{"agent", "wait"}, []string{"session-id"}, nil),
		command("agent-context.agent.cancel-turn", []string{"agent", "cancel-turn"}, []string{"session-id", "turn-id"}, nil),
		command("agent-context.agent.respond", []string{"agent", "respond"}, []string{"session-id", "request-id", "value"}, nil),
		command("agent-context.agent.turn-resources", []string{"agent", "turn-resources"}, []string{"session-id", "turn-id"}, nil),
		command("agent-context.agent.active-peers", []string{"agent", "active-peers"}, nil, nil),
		command("browser.navigate", []string{"browser", "navigate"}, []string{"url"}, nil),
		command("browser.snapshot", []string{"browser", "snapshot"}, nil, nil),
		command("browser.click", []string{"browser", "click"}, []string{"uid"}, nil),
		command("browser.fill", []string{"browser", "fill"}, []string{"uid", "value"}, nil),
		command("browser.list-pages", []string{"browser", "list-pages"}, nil, nil),
		command("browser.select-page", []string{"browser", "select-page"}, []string{"page-id"}, nil),
		command("browser.new-page", []string{"browser", "new-page"}, []string{"url"}, nil),
		command("browser.close-page", []string{"browser", "close-page"}, []string{"page-id"}, nil),
		command("browser.eval", []string{"browser", "eval"}, []string{"script"}, nil),
		command("browser.screenshot", []string{"browser", "screenshot"}, nil, nil),
		command("computer.screenshot", []string{"computer", "screenshot"}, nil, []string{"pid", "window-id"}),
		command("computer.click", []string{"computer", "click"}, []string{"x", "y"}, []string{"pid", "window-id"}),
		command("computer.double-click", []string{"computer", "double-click"}, []string{"x", "y"}, []string{"pid", "window-id"}),
		command("computer.right-click", []string{"computer", "right-click"}, []string{"x", "y"}, []string{"pid", "window-id"}),
		command("computer.type", []string{"computer", "type"}, []string{"text"}, []string{"pid", "window-id"}),
		command("computer.press-key", []string{"computer", "press-key"}, []string{"key"}, []string{"pid", "window-id"}),
		command("computer.scroll", []string{"computer", "scroll"}, []string{"x", "y", "direction", "amount"}, []string{"pid", "window-id"}),
		command("computer.move-cursor", []string{"computer", "move-cursor"}, []string{"x", "y"}, nil),
		command("computer.tool.list", []string{"computer", "tool", "list"}, nil, nil),
		command("computer.tool.describe", []string{"computer", "tool", "describe"}, []string{"name"}, nil),
		command("computer.tool.call", []string{"computer", "tool", "call"}, []string{"name", "arguments-json"}, nil),
	}
	for index := range commands {
		if commands[index].ID == "agent-context.agent.wait" {
			commands[index].ExecutionMode = "wait"
		}
	}
	setTestInputProperty(commands, "agent-context.agent.start", "show", map[string]any{"type": "boolean"})
	setTestInputProperty(commands, "agent-context.agent.get", "view", map[string]any{
		"type": "string",
		"enum": []string{"recent", "turns", "trace"},
	})
	setTestInputProperty(commands, "computer.scroll", "direction", map[string]any{
		"type": "string",
		"enum": []string{"up", "down", "left", "right"},
	})
	setTestInputProperty(commands, "issue-manager.issue.task.create-batch", "tasks-json", map[string]any{"type": "array"})
	setTestInputProperty(commands, "issue-manager.issue.run.complete", "outputs", map[string]any{"type": "array"})
	setTestInputProperty(commands, "issue-manager.issue.task.run.complete", "outputs", map[string]any{"type": "array"})
	return commands
}

func setTestInputProperty(commands []CommandCapability, id string, name string, property map[string]any) {
	for index := range commands {
		if commands[index].ID != id {
			continue
		}
		mapSchemaValue(commands[index].InputSchema["properties"])[name] = property
		return
	}
}
