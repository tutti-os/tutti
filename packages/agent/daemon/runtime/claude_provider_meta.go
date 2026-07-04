package agentruntime

import (
	"errors"
	"strings"
)

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

func (m claudeCodeSessionMeta) acpMeta() map[string]any {
	meta := map[string]any{}
	if strings.TrimSpace(m.systemPromptAppend) != "" {
		meta["systemPrompt"] = map[string]any{
			"type":   "preset",
			"preset": "claude_code",
			"append": m.systemPromptAppend,
		}
	}
	claudeCodeMeta := map[string]any{
		"options": m.options,
		"emitRawSDKMessages": []map[string]string{
			{"type": "system", "subtype": "init"},
			{"type": "system", "subtype": "task_started"},
			{"type": "system", "subtype": "task_progress"},
			{"type": "system", "subtype": "task_notification"},
			{"type": "system", "subtype": "task_updated"},
			{"type": "result"},
		},
	}
	if len(m.options) > 0 {
		meta["claudeCode"] = claudeCodeMeta
	}
	return meta
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

func claudeProviderMetaLogPhase(err error) string {
	var metaErr claudeProviderMetaError
	if !errors.As(err, &metaErr) {
		return ""
	}
	return metaErr.phase
}
