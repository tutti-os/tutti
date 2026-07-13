package agentruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func providerRuntimeConfig(session Session, provider string) map[string]any {
	baseURL := providerBaseURL(session, provider)
	if baseURL == "" {
		return nil
	}
	return map[string]any{
		"baseUrl": baseURL,
	}
}

func providerBaseURL(session Session, provider string) string {
	env := append(os.Environ(), session.Env...)
	if descriptor, ok := providerregistry.Find(provider); ok {
		return providerBaseURLFromDescriptor(env, session.CWD, descriptor.Runtime.Endpoint)
	}
	return ""
}

func providerBaseURLFromDescriptor(
	env []string,
	cwd string,
	endpoint providerregistry.RuntimeEndpointDescriptor,
) string {
	if baseURL := firstNonEmptyEnv(env, endpoint.BaseURLEnvVars...); baseURL != "" {
		return baseURL
	}
	switch endpoint.ConfigKind {
	case providerregistry.EndpointConfigKindCodexCLI:
		return codexConfigBaseURL(env)
	case providerregistry.EndpointConfigKindClaudeSettings:
		return claudeSettingsBaseURL(env, cwd)
	default:
		return ""
	}
}

func claudeSettingsBaseURL(env []string, cwd string) string {
	var candidates []string
	configDir := firstNonEmptyEnv(env, "CLAUDE_CONFIG_DIR")
	if configDir == "" {
		if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
			configDir = filepath.Join(home, ".claude")
		}
	}
	if configDir != "" {
		candidates = append(candidates, filepath.Join(configDir, "settings.json"))
	}
	candidates = append(candidates, claudeProjectSettingsPaths(cwd)...)
	for index := len(candidates) - 1; index >= 0; index-- {
		if baseURL := claudeSettingsEnvValue(candidates[index], "ANTHROPIC_BASE_URL"); baseURL != "" {
			return baseURL
		}
	}
	return ""
}

func claudeProjectSettingsPaths(cwd string) []string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return nil
	}
	var dirs []string
	current := filepath.Clean(cwd)
	for {
		dirs = append(dirs, current)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	var candidates []string
	for index := len(dirs) - 1; index >= 0; index-- {
		dir := dirs[index]
		candidates = append(candidates,
			filepath.Join(dir, ".claude", "settings.json"),
			filepath.Join(dir, ".claude", "settings.local.json"),
		)
	}
	return candidates
}

func claudeSettingsEnvValue(path string, key string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var parsed struct {
		Env map[string]any `json:"env"`
	}
	if err := json.Unmarshal(content, &parsed); err != nil {
		return ""
	}
	value, ok := parsed.Env[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func firstNonEmptyEnv(env []string, keys ...string) string {
	for _, key := range keys {
		if value := envValueLast(env, key); value != "" {
			return value
		}
	}
	return ""
}

func envValueLast(env []string, key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	prefix := key + "="
	for index := len(env) - 1; index >= 0; index-- {
		entry := env[index]
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(entry, prefix))
		}
	}
	return ""
}

func codexConfigBaseURL(env []string) string {
	codexHome := envValueLast(env, "CODEX_HOME")
	if codexHome == "" {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return ""
		}
		codexHome = filepath.Join(home, ".codex")
	}
	content, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		return ""
	}
	modelProvider := ""
	chatGPTBaseURL := ""
	providerBaseURLs := map[string]string{}
	currentProvider := ""
	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(strings.SplitN(rawLine, "#", 2)[0])
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			currentProvider = codexModelProviderSection(line)
			continue
		}
		key, value, ok := splitSimpleTomlAssignment(line)
		if !ok {
			continue
		}
		switch {
		case currentProvider != "" && key == "base_url":
			providerBaseURLs[currentProvider] = value
		case currentProvider == "" && key == "model_provider":
			modelProvider = value
		case currentProvider == "" && key == "chatgpt_base_url":
			chatGPTBaseURL = value
		}
	}
	if modelProvider != "" {
		if baseURL := strings.TrimSpace(providerBaseURLs[modelProvider]); baseURL != "" {
			return baseURL
		}
	}
	if chatGPTBaseURL != "" {
		return chatGPTBaseURL
	}
	return ""
}

func codexModelProviderSection(line string) string {
	section := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
	const prefix = "model_providers."
	if !strings.HasPrefix(section, prefix) {
		return ""
	}
	return strings.Trim(strings.TrimSpace(strings.TrimPrefix(section, prefix)), `"'`)
}

func splitSimpleTomlAssignment(line string) (string, string, bool) {
	left, right, ok := strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key := strings.TrimSpace(left)
	value := strings.Trim(strings.TrimSpace(right), `"'`)
	if key == "" || value == "" {
		return "", "", false
	}
	return key, value, true
}
