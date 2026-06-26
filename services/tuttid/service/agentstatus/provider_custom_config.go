package agentstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// providerUsesCustomConfig reports whether the user configured their own API key
// or a custom API endpoint for the provider — via environment variables OR the
// CLI's on-disk config. When they have, the default API endpoint is not what the
// CLI actually talks to, so the service-API reachability probe is skipped.
//
// The config-file parsing mirrors the runtime's endpoint adaptation in
// packages/agent/daemon/runtime/provider_endpoint.go (Codex config.toml,
// Claude settings.json); kept in sync by intent.
func (s Service) providerUsesCustomConfig(provider string) bool {
	for _, key := range providerCustomConfigEnvVars(provider) {
		if strings.TrimSpace(s.lookupEnv(key)) != "" {
			return true
		}
	}
	switch provider {
	case agentprovider.Codex:
		return s.codexConfigHasCustomEndpoint()
	case agentprovider.ClaudeCode:
		return s.claudeSettingsHasCustomConfig()
	default:
		return false
	}
}

// providerCustomConfigEnvVars lists the env vars that signal a user-provided API
// key or a custom base URL for a provider.
func providerCustomConfigEnvVars(provider string) []string {
	switch provider {
	case agentprovider.Codex:
		return []string{
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
			"OPENAI_API_BASE_URL",
			"OPENAI_API_BASE",
		}
	case agentprovider.ClaudeCode:
		return []string{
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_API_BASE_URL",
		}
	case agentprovider.Gemini:
		return []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}
	default:
		return nil
	}
}

// codexConfigHasCustomEndpoint reports whether ~/.codex/config.toml (or
// $CODEX_HOME) declares a custom base URL or an inline API key.
func (s Service) codexConfigHasCustomEndpoint() bool {
	codexHome := strings.TrimSpace(s.lookupEnv("CODEX_HOME"))
	if codexHome == "" {
		home, err := s.homeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return false
		}
		codexHome = filepath.Join(home, ".codex")
	}
	content, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		return false
	}
	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(strings.SplitN(rawLine, "#", 2)[0])
		if line == "" || strings.HasPrefix(line, "[") {
			continue
		}
		key, value, ok := splitTomlAssignment(line)
		if !ok {
			continue
		}
		switch key {
		case "base_url", "chatgpt_base_url", "api_key":
			if value != "" {
				return true
			}
		}
	}
	return false
}

// claudeSettingsHasCustomConfig reports whether ~/.claude/settings.json declares
// a custom API key or base URL (in its `env` block) or an apiKeyHelper.
func (s Service) claudeSettingsHasCustomConfig() bool {
	home, err := s.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return false
	}
	content, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return false
	}
	var parsed struct {
		Env          map[string]any `json:"env"`
		APIKeyHelper string         `json:"apiKeyHelper"`
	}
	if err := json.Unmarshal(content, &parsed); err != nil {
		return false
	}
	if strings.TrimSpace(parsed.APIKeyHelper) != "" {
		return true
	}
	for _, key := range []string{
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_API_BASE_URL",
	} {
		if value, ok := parsed.Env[key].(string); ok && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// splitTomlAssignment parses a `key = "value"` line, stripping quotes. Mirrors
// the runtime's splitSimpleTomlAssignment.
func splitTomlAssignment(line string) (string, string, bool) {
	left, right, ok := strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key := strings.TrimSpace(left)
	value := strings.Trim(strings.TrimSpace(right), `"'`)
	if key == "" {
		return "", "", false
	}
	return key, value, true
}
