package providerstatus

import (
	"encoding/json"
	"strings"
)

// CodexAuthJSONHasAPICredential reports whether Codex auth.json contains an
// explicit API key. OAuth token presence is deliberately not treated as proof
// of an authenticated session.
func CodexAuthJSONHasAPICredential(content []byte) bool {
	var payload struct {
		OpenAIAPIKey string `json:"OPENAI_API_KEY"`
	}
	if err := json.Unmarshal(content, &payload); err != nil {
		return false
	}
	return strings.TrimSpace(payload.OpenAIAPIKey) != ""
}

// CodexConfigTOMLHasAPICredential reports whether Codex config.toml contains a
// non-empty api_key assignment in any section.
func CodexConfigTOMLHasAPICredential(content []byte) bool {
	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(strings.SplitN(rawLine, "#", 2)[0])
		if line == "" || strings.HasPrefix(line, "[") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "api_key" {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if value != "" {
			return true
		}
	}
	return false
}

// ClaudeSettingsHasAPICredential reports whether Claude settings.json
// configures API billing through a key, auth token, or apiKeyHelper.
func ClaudeSettingsHasAPICredential(content []byte) bool {
	var payload struct {
		Env          map[string]any `json:"env"`
		APIKeyHelper string         `json:"apiKeyHelper"`
	}
	if err := json.Unmarshal(content, &payload); err != nil {
		return false
	}
	if strings.TrimSpace(payload.APIKeyHelper) != "" {
		return true
	}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		if value, ok := payload.Env[key].(string); ok && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}
