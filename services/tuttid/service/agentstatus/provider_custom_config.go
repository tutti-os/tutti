package agentstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// A provider CLI can diverge from its default Console/OAuth login in two
// independent ways, detected from env vars and on-disk config:
//
//   - A custom API endpoint (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, ...): the CLI
//     talks to a user-supplied gateway instead of the provider's default host.
//     The service-API reachability probe is skipped in that case, since probing
//     the default endpoint would mislead.
//   - An API credential (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, apiKeyHelper,
//     OPENAI_API_KEY, ...): usage is billed to an API account and overrides any
//     stored OAuth/subscription session. The auth status reported to the
//     environment wizard reflects this so a configured API user is not told to
//     "log in".
//
// The two are orthogonal — a custom endpoint can carry an OAuth session, and an
// API key can target the default host — so they are detected separately.
// providerUsesCustomConfig (either axis set) drives the network-probe skip;
// providerHasAPICredential (credential axis only) drives the auth/billing label.
//
// The config-file parsing mirrors the runtime's endpoint adaptation in
// packages/agent/daemon/runtime/provider_endpoint.go (Codex config.toml,
// Claude settings.json); kept in sync by intent.

// providerUsesCustomConfig reports whether the user configured their own API
// key or a custom API endpoint for the provider — via environment variables OR
// the CLI's on-disk config. When they have, the default API endpoint is not
// what the CLI actually talks to, so the service-API reachability probe is
// skipped.
func (s Service) providerUsesCustomConfig(provider string) bool {
	for _, key := range providerCustomConfigEnvVars(provider) {
		if strings.TrimSpace(s.lookupEnv(key)) != "" {
			return true
		}
	}
	switch provider {
	case agentprovider.Codex:
		return s.codexConfigDeclares("base_url", "chatgpt_base_url", "api_key")
	case agentprovider.ClaudeCode:
		return s.claudeSettingsDeclares(claudeCustomConfigKeys, true)
	default:
		return false
	}
}

// providerHasAPICredential reports whether the user configured an API
// credential for the provider (an API key, an auth token, or an API key helper)
// via env vars or on-disk config. This is the signal that usage is billed to an
// API account rather than a Console/subscription session, and it overrides
// whatever `claude auth status` reports (which only reflects the stored OAuth
// session, not env/settings credentials).
func (s Service) providerHasAPICredential(provider string) bool {
	for _, key := range providerCredentialEnvVars(provider) {
		if strings.TrimSpace(s.lookupEnv(key)) != "" {
			return true
		}
	}
	switch provider {
	case agentprovider.Codex:
		return s.codexConfigDeclares("api_key")
	case agentprovider.ClaudeCode:
		return s.claudeSettingsDeclares(claudeAPICredentialKeys, true)
	default:
		return false
	}
}

// providerCustomConfigEnvVars lists env vars that signal a user-provided API
// key OR a custom base URL for a provider — either axis counts as custom config
// for the network-probe skip.
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
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_API_BASE_URL",
		}
	case agentprovider.Gemini:
		return []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}
	default:
		return nil
	}
}

// providerCredentialEnvVars lists env vars that signal a user-provided API
// credential (key/token) for a provider — the billing axis only, excluding
// custom base URLs.
func providerCredentialEnvVars(provider string) []string {
	switch provider {
	case agentprovider.Codex:
		return []string{"OPENAI_API_KEY"}
	case agentprovider.ClaudeCode:
		return []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}
	case agentprovider.Gemini:
		return []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}
	default:
		return nil
	}
}

// claudeCustomConfigKeys are the ~/.claude/settings.json env keys that count as
// custom config (credential or endpoint) for Claude Code.
var claudeCustomConfigKeys = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_API_BASE_URL",
}

// claudeAPICredentialKeys are the ~/.claude/settings.json env keys that count
// as an API credential for Claude Code — the billing axis, excluding endpoints.
var claudeAPICredentialKeys = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
}

// codexConfigDeclares reports whether ~/.codex/config.toml (or $CODEX_HOME)
// assigns a non-empty value to any of the given keys (e.g. "base_url",
// "api_key") in a top-level or [model_providers.*] block. Mirrors the runtime's
// TOML parsing.
func (s Service) codexConfigDeclares(keys ...string) bool {
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
		for _, want := range keys {
			if key == want && value != "" {
				return true
			}
		}
	}
	return false
}

// claudeSettingsDeclares reports whether ~/.claude/settings.json sets any of
// the given env keys to a non-blank value, or — when withAPIKeyHelper is true —
// declares a non-blank apiKeyHelper.
func (s Service) claudeSettingsDeclares(keys []string, withAPIKeyHelper bool) bool {
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
	if withAPIKeyHelper && strings.TrimSpace(parsed.APIKeyHelper) != "" {
		return true
	}
	for _, key := range keys {
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
