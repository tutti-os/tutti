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
	apps := appIndexFromCapabilities(capabilities)

	sections := make([]string, 0, 2)
	if len(commands) == 0 {
		sections = append(sections, fallbackCommandGuide(cliName))
	} else {
		lines := make([]string, 0, len(commands))
		for _, command := range commands {
			line := fmt.Sprintf("- %s: `%s`", command.Summary, command.Example)
			if strings.TrimSpace(command.Description) != "" {
				line += " - " + strings.TrimSpace(command.Description)
			}
			lines = append(lines, line)
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}
	if len(apps) > 0 {
		sections = append(sections, appIndexSection(cliName, apps))
	}
	return strings.Join(sections, "\n\n")
}

type appIndexEntry struct {
	ID          string
	Name        string
	Description string
}

// appIndexFromCapabilities builds a compact, deduped index of workspace apps that
// expose CLI commands (one entry per app id). Per-app command details are not
// inlined; they are fetched on demand via the `app commands` lookup.
func appIndexFromCapabilities(capabilities []cliservice.Capability) []appIndexEntry {
	seen := map[string]struct{}{}
	entries := make([]appIndexEntry, 0)
	for _, capability := range capabilities {
		if capability.Source.Kind != cliservice.CapabilitySourceApp {
			continue
		}
		// Skip app-source capabilities that remain explicit inline lines
		// (the codex/claude agent launchers).
		if isBuiltinRuntimeCommandID(capability.ID) {
			continue
		}
		id := strings.TrimSpace(capability.Source.AppID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		entries = append(entries, appIndexEntry{
			ID:          id,
			Name:        firstNonEmptyText(capability.Source.AppName, id),
			Description: oneLineDescription(firstNonEmptyText(capability.Source.AppDescription, capability.Source.CLIDescription)),
		})
	}
	sort.SliceStable(entries, func(left, right int) bool {
		return entries[left].ID < entries[right].ID
	})
	return entries
}

func appIndexSection(cliName string, apps []appIndexEntry) string {
	cliName = normalizeCLICommandName(cliName)
	lines := make([]string, 0, len(apps)+1)
	lines = append(lines, fmt.Sprintf(
		"Workspace apps with CLI commands (run `%s app commands --app-id <app id> --json` to list one app's commands, `--all` for every app, or use the workspace-app skill):",
		cliName,
	))
	for _, app := range apps {
		line := "- " + app.Name
		if app.Description != "" {
			line += " — " + app.Description
		}
		line += " (app id: " + app.ID + ")"
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// oneLineDescription collapses whitespace/newlines and truncates so a single app
// description cannot bloat the always-on prompt.
func oneLineDescription(text string) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	const maxRunes = 140
	runes := []rune(collapsed)
	if len(runes) > maxRunes {
		return strings.TrimSpace(string(runes[:maxRunes])) + "…"
	}
	return collapsed
}

type runtimeCommand struct {
	ID          string
	Summary     string
	Description string
	Example     string
	Rank        int
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

// isBuiltinRuntimeCommandID reports whether a capability should be rendered as an
// explicit command line in the always-on command guide. Built-in workflow commands
// (issue/agent/browser, app open, and the app-commands lookup itself) stay inline.
// The codex/claude agent launchers are app-source but carry the agent-context.
// prefix, so they remain inline too. Generic workspace-app commands are excluded
// here and surfaced via the compact app index + the on-demand `app commands` lookup.
func isBuiltinRuntimeCommandID(id string) bool {
	id = strings.TrimSpace(id)
	return id == "workspace-apps.app.open" ||
		id == "workspace-apps.app.commands" ||
		strings.HasPrefix(id, "issue-manager.") ||
		strings.HasPrefix(id, "agent-context.") ||
		strings.HasPrefix(id, "browser.")
}

func runtimeCommandFromCapability(cliName string, capability cliservice.Capability) (runtimeCommand, bool) {
	id := strings.TrimSpace(capability.ID)
	if id == "agent-context.agent.skill-bundle" || id == "agent-context.agent.tutti-cli-skill-bundle" {
		return runtimeCommand{}, false
	}
	if !isBuiltinRuntimeCommandID(id) {
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
	return runtimeCommand{
		ID:          id,
		Summary:     firstNonEmptyText(capability.Summary, id),
		Description: description,
		Example:     normalizeCLICommandName(cliName) + " " + path + requiredInputHintForCommand(id, capability.InputSchema) + commandExampleSuffix(id),
		Rank:        commandRank(id),
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
	case "workspace-apps.app.commands":
		return " --app-id <app-id> --json"
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
	case "agent-context.agent.active-peers":
		return 130
	case "workspace-apps.app.open":
		return 135
	case "workspace-apps.app.commands":
		return 136
	default:
		return 140
	}
}

func fallbackCommandGuide(cliName string) string {
	cliName = normalizeCLICommandName(cliName)
	return strings.Join([]string{
		fmt.Sprintf("- List issue topics: `%s issue topic list`", cliName),
		fmt.Sprintf("- List issues: `%s issue list --topic-id <topic-id>`", cliName),
		fmt.Sprintf("- Get issue detail: `%s issue get --issue-id <issue-id> --json`", cliName),
		fmt.Sprintf("- Update issue status: `%s issue update --issue-id <issue-id> --status completed --json`", cliName),
		fmt.Sprintf("- List issue tasks: `%s issue task list --issue-id <issue-id>`", cliName),
		fmt.Sprintf("- Create issue task for breakdown: `%s issue task create --issue-id <issue-id> --title <title> --content <content> --json` - Use this to persist child tasks without creating a run.", cliName),
		fmt.Sprintf("- Update issue task status: `%s issue task update --issue-id <issue-id> --task-id <task-id> --status completed --json`", cliName),
		fmt.Sprintf("- Create an issue run: `%s issue run create --issue-id <issue-id> --agent-provider <provider> --agent-session-id <session-id> --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Complete an issue run: `%s issue run complete --issue-id <issue-id> --run-id <run-id> --status completed --summary <summary> --outputs '[{\"path\":\"<artifact-path>\"}]' --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Create an issue task run: `%s issue task run create --issue-id <issue-id> --task-id <task-id> --agent-provider <provider> --agent-session-id <session-id> --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- Complete an issue task run: `%s issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed --summary <summary> --outputs '[{\"path\":\"<artifact-path>\"}]' --json` - Execution mode only; do not use for breakdown-only work.", cliName),
		fmt.Sprintf("- List agent sessions: `%s agent sessions`", cliName),
		fmt.Sprintf("- Get agent session summary: `%s agent session-summary --session-id <session-id> --json`", cliName),
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
