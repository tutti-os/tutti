package agent

import (
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s *Service) composerCommandsFromRunningSession(
	workspaceID string,
	provider string,
	agentTargetID string,
) []map[string]any {
	workspaceID = strings.TrimSpace(workspaceID)
	provider = agentprovider.NormalizeOpen(provider)
	agentTargetID = strings.TrimSpace(agentTargetID)
	if workspaceID == "" || provider == "" {
		return nil
	}
	for _, session := range s.controller().Sessions(workspaceID) {
		if agentprovider.NormalizeOpen(session.Provider) != provider {
			continue
		}
		if agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != agentTargetID {
			continue
		}
		if commands := composerCommandsFromRuntimeContext(session.RuntimeContext); len(commands) > 0 {
			return commands
		}
	}
	if s.SessionReader == nil {
		return nil
	}
	persisted, ok := s.SessionReader.ListSessions(workspaceID)
	if !ok {
		return nil
	}
	var selected []map[string]any
	var selectedUpdatedAt int64
	for _, session := range persisted {
		if agentprovider.NormalizeOpen(session.Provider) != provider {
			continue
		}
		if agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != agentTargetID {
			continue
		}
		commands := composerCommandsFromRuntimeContext(session.InternalRuntimeContext)
		if len(commands) == 0 || len(selected) > 0 && session.UpdatedAtUnixMS <= selectedUpdatedAt {
			continue
		}
		selected = commands
		selectedUpdatedAt = session.UpdatedAtUnixMS
	}
	if len(selected) > 0 {
		return selected
	}
	return nil
}

func composerCommandsFromRuntimeContext(runtimeContext map[string]any) []map[string]any {
	if len(runtimeContext) == 0 {
		return nil
	}
	if values, ok := runtimeContext["availableCommands"].([]map[string]any); ok {
		return cloneComposerCommands(values)
	}
	if values, ok := runtimeContext["availableCommands"].([]any); ok {
		commands := make([]map[string]any, 0, len(values))
		for _, value := range values {
			if command, ok := value.(map[string]any); ok {
				commands = append(commands, command)
			}
		}
		return cloneComposerCommands(commands)
	}
	// Older persisted sessions only stored command names. Preserve those
	// names so a daemon/desktop restart does not erase an already-advertised
	// command catalog while the resumed ACP process is reconnecting.
	commands := make([]map[string]any, 0)
	switch values := runtimeContext["commands"].(type) {
	case []string:
		for _, name := range values {
			if name = strings.TrimSpace(name); name != "" {
				commands = append(commands, map[string]any{"name": name})
			}
		}
	case []any:
		for _, value := range values {
			if name := strings.TrimSpace(stringFromAny(value)); name != "" {
				commands = append(commands, map[string]any{"name": name})
			}
		}
	}
	return cloneComposerCommands(commands)
}

func cloneComposerCommands(commands []map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(commands))
	seen := map[string]struct{}{}
	for _, command := range commands {
		name := strings.TrimSpace(stringFromAny(command["name"]))
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		value := map[string]any{"name": name}
		for _, key := range []string{"description", "inputHint"} {
			if text := strings.TrimSpace(stringFromAny(command[key])); text != "" {
				value[key] = text
			}
		}
		result = append(result, value)
	}
	return result
}

func composerCommandOptions(commands []map[string]any) []ComposerCommandOption {
	result := make([]ComposerCommandOption, 0, len(commands))
	for _, command := range cloneComposerCommands(commands) {
		result = append(result, ComposerCommandOption{
			Name:        strings.TrimSpace(stringFromAny(command["name"])),
			Description: strings.TrimSpace(stringFromAny(command["description"])),
			InputHint:   strings.TrimSpace(stringFromAny(command["inputHint"])),
		})
	}
	return result
}
