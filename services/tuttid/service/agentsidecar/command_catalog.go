package agentsidecar

import (
	"context"
	"fmt"
	"sort"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type CommandCatalog interface {
	Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability
}

func commandGuideFromCatalog(ctx context.Context, catalog CommandCatalog, workspaceID string, cliName string) string {
	cliName = normalizeCLICommandName(cliName)
	if catalog == nil {
		return fallbackCommandGuide(cliName)
	}
	return commandGuideFromCapabilities(cliName, catalog.Capabilities(ctx, cliservice.InvokeContext{
		Source:      "agent-runtime",
		WorkspaceID: strings.TrimSpace(workspaceID),
	}))
}

func commandGuideFromCapabilities(cliName string, capabilities []cliservice.Capability) string {
	cliName = normalizeCLICommandName(cliName)
	commands := relevantRuntimeCommands(cliName, capabilities)
	if len(commands) == 0 {
		return fallbackCommandGuide(cliName)
	}
	lines := make([]string, 0, len(commands))
	for _, command := range commands {
		line := fmt.Sprintf("- %s: `%s`", command.Summary, command.Example)
		if strings.TrimSpace(command.Description) != "" {
			line += " - " + strings.TrimSpace(command.Description)
		}
		if command.InputDetails != "" {
			line += " Arguments: " + command.InputDetails
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

type runtimeCommand struct {
	ID           string
	Summary      string
	Description  string
	Example      string
	InputDetails string
	Rank         int
}

func relevantRuntimeCommands(cliName string, capabilities []cliservice.Capability) []runtimeCommand {
	commands := make([]runtimeCommand, 0)
	for _, capability := range capabilities {
		command, ok := runtimeCommandFromCapability(cliName, capability)
		if ok {
			commands = append(commands, command)
		}
	}
	sort.SliceStable(commands, func(left, right int) bool {
		if commands[left].Rank != commands[right].Rank {
			return commands[left].Rank < commands[right].Rank
		}
		return commands[left].ID < commands[right].ID
	})
	return commands
}

func runtimeCommandFromCapability(cliName string, capability cliservice.Capability) (runtimeCommand, bool) {
	id := strings.TrimSpace(capability.ID)
	if id == "agent-context.agent.skill-bundle" || id == "agent-context.agent.tutti-cli-skill-bundle" {
		return runtimeCommand{}, false
	}
	if capability.Source.Kind != cliservice.CapabilitySourceApp &&
		id != "workspace-apps.app.open" &&
		!strings.HasPrefix(id, "issue-manager.") &&
		!strings.HasPrefix(id, "agent-context.") &&
		!strings.HasPrefix(id, "browser.") {
		return runtimeCommand{}, false
	}
	path := commandPath(capability.Path)
	if path == "" {
		return runtimeCommand{}, false
	}
	description := strings.TrimSpace(capability.Description)
	if id == "workspace-apps.app.open" || appCapabilityIsOpenCommand(capability) {
		if description != "" {
			description += " "
		}
		description += "Use only when the user explicitly asks to open or show an app window, or confirms an app window should be opened; prefer app-specific CLI commands for ordinary app work."
	}
	if capability.Source.Kind == cliservice.CapabilitySourceApp && strings.TrimSpace(capability.Source.AppName) != "" {
		if description != "" {
			description += " "
		}
		description += "Provided by workspace app " + strings.TrimSpace(capability.Source.AppName) + "."
	}
	if capability.Source.Kind == cliservice.CapabilitySourceApp && strings.TrimSpace(capability.Source.AppID) != "" {
		if description != "" {
			description += " "
		}
		description += "App id: " + strings.TrimSpace(capability.Source.AppID) + "."
	}
	if agentLauncherCommandUsesDefaultModel(id) {
		if description != "" {
			description += " "
		}
		description += "Omit --model unless the user explicitly requested a model; tuttid uses the target provider default."
	}
	if agentCommandAcceptsImageInput(id, capability.InputSchema) {
		if description != "" {
			description += " "
		}
		description += "Pass --image <path> multiple times to include local PNG, JPEG, or WebP image context."
	}
	summary := firstNonEmptyText(capability.Summary, id)
	if id == "issue-manager.issue.list" {
		summary = "List issues in a topic"
		topicDiscoveryHint := fmt.Sprintf("Requires --topic-id; use `%s issue topic list --json` first when the topic is unknown.", normalizeCLICommandName(cliName))
		description = strings.ReplaceAll(description, "`issue topic list --json`", fmt.Sprintf("`%s issue topic list --json`", normalizeCLICommandName(cliName)))
		if !strings.Contains(description, topicDiscoveryHint) {
			if description != "" {
				description += " "
			}
			description += topicDiscoveryHint
		}
	}
	return runtimeCommand{
		ID:           id,
		Summary:      summary,
		Description:  description,
		Example:      normalizeCLICommandName(cliName) + " " + path + requiredInputHintForCommand(id, capability.InputSchema) + commandExampleSuffix(id),
		InputDetails: inputDetailsForCommand(id, capability.InputSchema),
		Rank:         commandRank(id),
	}, true
}

func appCapabilityIsOpenCommand(capability cliservice.Capability) bool {
	path := capability.Path
	return capability.Source.Kind == cliservice.CapabilitySourceApp &&
		len(path) > 0 &&
		strings.TrimSpace(path[len(path)-1]) == "open"
}

func commandPath(path []string) string {
	parts := make([]string, 0, len(path))
	for _, part := range path {
		part = strings.TrimSpace(part)
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " ")
}

func requiredInputHintForCommand(id string, schema map[string]any) string {
	required := stringSliceSchemaValue(schema["required"])
	if agentLauncherCommandUsesDefaultModel(id) {
		filtered := make([]string, 0, len(required))
		for _, name := range required {
			if strings.TrimSpace(name) != "model" {
				filtered = append(filtered, name)
			}
		}
		required = filtered
	}
	return requiredInputHintFromNames(required)
}

func requiredInputHintFromNames(required []string) string {
	if len(required) == 0 {
		return ""
	}
	sort.Strings(required)
	parts := make([]string, 0, len(required))
	for _, name := range required {
		name = strings.TrimSpace(name)
		if name != "" {
			parts = append(parts, "--"+name+" <"+name+">")
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return " " + strings.Join(parts, " ")
}

func agentLauncherCommandUsesDefaultModel(id string) bool {
	switch strings.TrimSpace(id) {
	case "agent-context.codex.start", "agent-context.claude.start":
		return true
	default:
		return false
	}
}

func inputDetailsForCommand(id string, schema map[string]any) string {
	properties := mapSchemaValue(schema["properties"])
	if len(properties) == 0 {
		return ""
	}
	required := map[string]bool{}
	for _, name := range stringSliceSchemaValue(schema["required"]) {
		name = strings.TrimSpace(name)
		if name != "" {
			required[name] = true
		}
	}
	if agentLauncherCommandUsesDefaultModel(id) {
		delete(required, "model")
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		name = strings.TrimSpace(name)
		if name != "" {
			names = append(names, name)
		}
	}
	sort.SliceStable(names, func(left, right int) bool {
		leftRequired := required[names[left]]
		rightRequired := required[names[right]]
		if leftRequired != rightRequired {
			return leftRequired
		}
		return names[left] < names[right]
	})
	parts := make([]string, 0, len(names))
	for _, name := range names {
		property := mapSchemaValue(properties[name])
		detail := "--" + name
		if typ := schemaTypeLabel(property); typ != "" {
			detail += " <" + typ + ">"
		}
		var qualifiers []string
		if required[name] {
			qualifiers = append(qualifiers, "required")
		} else {
			qualifiers = append(qualifiers, "optional")
		}
		if enum := stringSliceSchemaValue(property["enum"]); len(enum) > 0 {
			qualifiers = append(qualifiers, "values: "+strings.Join(enum, "|"))
		}
		if defaultValue, ok := property["default"]; ok {
			if defaultText := strings.TrimSpace(fmt.Sprint(defaultValue)); defaultText != "" {
				qualifiers = append(qualifiers, "default: "+defaultText)
			}
		}
		if len(qualifiers) > 0 {
			detail += " (" + strings.Join(qualifiers, "; ") + ")"
		}
		if description := strings.TrimSpace(asSchemaString(property["description"])); description != "" {
			detail += " - " + description
		}
		parts = append(parts, detail)
	}
	return strings.Join(parts, "; ")
}

func schemaTypeLabel(property map[string]any) string {
	typeLabel := strings.TrimSpace(asSchemaString(property["type"]))
	switch typeLabel {
	case "integer", "number":
		return "number"
	case "boolean":
		return "true|false"
	case "array":
		return "json"
	case "object":
		return "json"
	default:
		return typeLabel
	}
}

func mapSchemaValue(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func asSchemaString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func agentCommandAcceptsImageInput(id string, schema map[string]any) bool {
	switch strings.TrimSpace(id) {
	case "agent-context.agent.start", "agent-context.codex.start", "agent-context.claude.start", "agent-context.agent.send":
	default:
		return false
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = properties["image"]
	return ok
}

func commandExampleSuffix(id string) string {
	switch id {
	case "issue-manager.issue.topic.update":
		return " --title <title> --json"
	case "issue-manager.issue.update", "issue-manager.issue.task.update":
		return " --status completed --json"
	case "issue-manager.issue.run.create", "issue-manager.issue.task.run.create":
		return " --json"
	case "issue-manager.issue.run.complete", "issue-manager.issue.task.run.complete":
		return " --summary <summary> --outputs '[{\"path\":\"<artifact-path>\"}]' --json"
	case "browser.navigate":
		return " --url <url>"
	case "browser.click":
		return " --uid <uid>"
	case "browser.fill":
		return " --uid <uid> --value <text>"
	case "browser.eval":
		return " --script '() => document.title'"
	case "workspace-apps.app.open":
		return " --json"
	default:
		return ""
	}
}

func stringSliceSchemaValue(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func commandRank(id string) int {
	switch id {
	case "issue-manager.issue.topic.list":
		return 5
	case "issue-manager.issue.topic.create":
		return 6
	case "issue-manager.issue.topic.update":
		return 7
	case "issue-manager.issue.topic.delete":
		return 8
	case "issue-manager.issue.list":
		return 10
	case "issue-manager.issue.get":
		return 20
	case "issue-manager.issue.update":
		return 30
	case "issue-manager.issue.task.list":
		return 40
	case "issue-manager.issue.task.get":
		return 50
	case "issue-manager.issue.task.create":
		return 55
	case "issue-manager.issue.task.create-batch":
		return 56
	case "issue-manager.issue.task.update":
		return 60
	case "issue-manager.issue.task.delete":
		return 65
	case "issue-manager.issue.run.create":
		return 70
	case "issue-manager.issue.run.complete":
		return 80
	case "issue-manager.issue.task.run.create":
		return 90
	case "issue-manager.issue.task.run.complete":
		return 100
	case "agent-context.agent.sessions":
		return 110
	case "agent-context.agent.session-summary":
		return 120
	case "agent-context.agent.turn-resources":
		return 125
	case "agent-context.agent.active-peers":
		return 130
	case "workspace-apps.app.open":
		return 135
	default:
		return 140
	}
}

func fallbackCommandGuide(cliName string) string {
	cliName = normalizeCLICommandName(cliName)
	return strings.Join([]string{
		fmt.Sprintf("- List issue topics: `%s issue topic list`", cliName),
		fmt.Sprintf("- List issues in a topic: `%s issue list --topic-id <topic-id>` - Requires a topic id; use `%s issue topic list --json` first when the topic is unknown.", cliName, cliName),
		fmt.Sprintf("- Get issue detail: `%s issue get --issue-id <issue-id> --json`", cliName),
		fmt.Sprintf("- Update issue status: `%s issue update --issue-id <issue-id> --status completed --json`", cliName),
		fmt.Sprintf("- List issue tasks: `%s issue task list --issue-id <issue-id>`", cliName),
		fmt.Sprintf("- Create ordered issue tasks for breakdown: `%s issue task create-batch --issue-id <issue-id> --tasks-json '[{\"title\":\"<title>\",\"content\":\"<content>\"}]' --json` - Prefer this for multiple child tasks; it persists tasks in array order without creating runs.", cliName),
		fmt.Sprintf("- Create issue task for breakdown: `%s issue task create --issue-id <issue-id> --title <title> --content <content> --json` - Use this to persist child tasks without creating a run.", cliName),
		fmt.Sprintf("- Update issue task status: `%s issue task update --issue-id <issue-id> --task-id <task-id> --status completed --json`", cliName),
		fmt.Sprintf("- Create an issue run: `%s issue run create --issue-id <issue-id> --agent-provider <provider> --json` - Execution mode only; the CLI binds the current AgentGUI session from runtime context. Do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Complete an issue run: `%s issue run complete --issue-id <issue-id> --run-id <run-id> --status completed --summary <summary> --outputs '[{\"path\":\"<artifact-path>\"}]' --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Create an issue task run: `%s issue task run create --issue-id <issue-id> --task-id <task-id> --agent-provider <provider> --json` - Execution mode only; the CLI binds the current AgentGUI session from runtime context. Do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Complete an issue task run: `%s issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed --summary <summary> --outputs '[{\"path\":\"<artifact-path>\"}]' --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- List agent sessions: `%s agent sessions`", cliName),
		fmt.Sprintf("- Get agent session summary: `%s agent session-summary --session-id <session-id> --json`", cliName),
		fmt.Sprintf("- Get resources from one agent turn: `%s agent turn-resources --session-id <session-id> --turn-id <turn-id> --json`", cliName),
		fmt.Sprintf("- Show active peer agents: `%s agent active-peers --json`", cliName),
		fmt.Sprintf("- Open an app window: `%s app open --app-id <app-id> --json` - Use only when the user explicitly asks to open or show an app window, or confirms an app window should be opened; prefer app-specific CLI commands for ordinary app work.", cliName),
	}, "\n")
}

func normalizeCLICommandName(cliName string) string {
	cliName = strings.TrimSpace(cliName)
	if cliName == "" {
		return "tutti"
	}
	return cliName
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
