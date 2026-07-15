package agentruntime

import (
	"fmt"
	"os"
	"strings"
)

const claudeSystemPromptFileEnv = "TUTTI_CLAUDE_SYSTEM_PROMPT_FILE"
const claudePluginDirEnv = "TUTTI_CLAUDE_PLUGIN_DIR"

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

func claudeSystemPromptAppend(env []string) (string, error) {
	path := sessionEnvValue(env, claudeSystemPromptFileEnv)
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read claude system prompt: %w", err)
	}
	return string(content), nil
}

func claudePluginDir(env []string) (string, error) {
	path := sessionEnvValue(env, claudePluginDirEnv)
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat claude plugin dir: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("claude plugin dir is not a directory: %s", path)
	}
	return path, nil
}

func claudeCodeCustomModel(session Session) string {
	model := strings.TrimSpace(session.SettingsValue().Model)
	if model == "" || claudeCodeBuiltInModelAliases[model] {
		return ""
	}
	return model
}

type claudeProviderMetaError struct {
	phase string
	err   error
}

func (e claudeProviderMetaError) Error() string {
	if e.err == nil {
		return e.phase
	}
	return e.err.Error()
}

func (e claudeProviderMetaError) Unwrap() error {
	return e.err
}

type claudeCodeSessionMeta struct {
	systemPromptPath   string
	systemPromptAppend string
	pluginDirPath      string
	pluginDir          string
	options            map[string]any
}

func buildClaudeCodeSessionMeta(session Session) (claudeCodeSessionMeta, error) {
	meta := claudeCodeSessionMeta{
		systemPromptPath: sessionEnvValue(session.Env, claudeSystemPromptFileEnv),
		pluginDirPath:    sessionEnvValue(session.Env, claudePluginDirEnv),
	}
	systemPrompt, err := claudeSystemPromptAppend(session.Env)
	if err != nil {
		return meta, claudeProviderMetaError{phase: "system_prompt", err: err}
	}
	if !promptHasAgentConversationDetailMode(systemPrompt) {
		systemPrompt = joinPromptSections(systemPrompt, agentConversationDetailModePromptAppend(session.SettingsValue()))
	}
	meta.systemPromptAppend = systemPrompt
	pluginDir, err := claudePluginDir(session.Env)
	if err != nil {
		return meta, claudeProviderMetaError{phase: "plugin_dir", err: err}
	}
	meta.pluginDir = pluginDir
	meta.options = map[string]any{
		"planModeInstructions": claudePlanModeInstructions,
		"allowedTools":         []string{"Grep", "Glob"},
		"disallowedTools":      []string{"Monitor"},
		"tools": map[string]string{
			"type":   "preset",
			"preset": "claude_code",
		},
	}
	extraArgs := map[string]string{}
	if pluginDir != "" {
		extraArgs["plugin-dir"] = pluginDir
		meta.options["plugins"] = []map[string]string{
			{"type": "local", "path": pluginDir},
		}
	}
	if model := claudeCodeCustomModel(session); model != "" {
		extraArgs["model"] = model
	}
	if len(extraArgs) > 0 {
		meta.options["extraArgs"] = extraArgs
	}
	return meta, nil
}

func (m claudeCodeSessionMeta) sdkPayload() map[string]any {
	payload := map[string]any{}
	if strings.TrimSpace(m.systemPromptAppend) != "" {
		payload["systemPromptAppend"] = m.systemPromptAppend
	}
	for _, key := range []string{"planModeInstructions", "allowedTools", "disallowedTools", "plugins", "extraArgs", "tools"} {
		if value, ok := m.options[key]; ok {
			payload[key] = value
		}
	}
	return payload
}
