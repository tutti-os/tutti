package agentruntime

import (
	"strings"
)

const claudePlanModeInstructions = "You are in plan mode. Inspect files and gather context as needed, but do not edit files, run mutation commands, or make external changes. Produce a concrete implementation plan first. If the user gives feedback, refine the plan. Only after the user approves leaving plan mode may you implement changes."

const (
	sessionSpeedStandard = "standard"
	sessionSpeedFast     = "fast"
	claudeSDKFastModeOff = "off"
	claudeSDKFastModeOn  = "on"
)

var claudeCodeBuiltInModelAliases = map[string]bool{
	"default":    true,
	"sonnet":     true,
	"opus":       true,
	"haiku":      true,
	"sonnet[1m]": true,
}

func claudeCodeCustomModel(session Session) string {
	model := strings.TrimSpace(session.SettingsValue().Model)
	if model == "" || claudeCodeBuiltInModelAliases[model] {
		return ""
	}
	return model
}

func claudeCodeSDKStartOptions(session Session) map[string]any {
	options := map[string]any{
		"planModeInstructions": claudePlanModeInstructions,
		"allowedTools":         []string{"Grep", "Glob"},
		"disallowedTools":      []string{"Monitor"},
		"tools": map[string]string{
			"type":   "preset",
			"preset": "claude_code",
		},
	}
	extraArgs := map[string]string{}
	if model := claudeCodeCustomModel(session); model != "" {
		extraArgs["model"] = model
	}
	if len(extraArgs) > 0 {
		options["extraArgs"] = extraArgs
	}
	return options
}
