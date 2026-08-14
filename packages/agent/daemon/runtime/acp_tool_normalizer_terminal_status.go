package agentruntime

import "strings"

func acpTerminalExitCodeIsSuccessful(update map[string]any, exitCode int) bool {
	if exitCode == 0 {
		return true
	}
	if exitCode != 1 {
		return false
	}
	input, _ := acpToolCallRawInput(update).(map[string]any)
	command := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		asString(input["cmd"]),
		acpTerminalShellCommand(input["command"]),
	)))
	if command == "" || !acpCommandRunsGitDiff(command) {
		return false
	}
	return strings.Contains(command, "--no-index") ||
		strings.Contains(command, "--exit-code") ||
		strings.Contains(command, "--quiet")
}

func acpTerminalShellCommand(value any) string {
	if values, ok := value.([]any); ok {
		parts := make([]string, 0, len(values))
		for _, item := range values {
			part := strings.TrimSpace(asString(item))
			if part != "" {
				parts = append(parts, part)
			}
		}
		if len(parts) >= 3 && (parts[len(parts)-2] == "-c" || parts[len(parts)-2] == "-lc") {
			return parts[len(parts)-1]
		}
		return strings.Join(parts, " ")
	}
	return acpExtractShellCommand(value)
}

func acpCommandRunsGitDiff(command string) bool {
	if strings.ContainsAny(command, ";&|") {
		return false
	}
	fields := strings.Fields(command)
	if len(fields) < 3 || fields[0] != "git" || fields[1] != "diff" {
		return false
	}
	for _, field := range fields[2:] {
		switch strings.Trim(field, "\"'") {
		case "&&", "||", ";", "|", "&":
			return false
		}
	}
	return true
}
