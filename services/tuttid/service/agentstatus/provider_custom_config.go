package agentstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
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
	if status, ok := migratedProviderStatus(provider); ok {
		switch status.Kind {
		case providerregistry.StatusKindCodexCLI:
			return s.codexConfigDeclares("base_url", "chatgpt_base_url", "api_key") || s.codexAuthJSONHasAPIKey()
		case providerregistry.StatusKindClaudeCLI:
			return s.claudeSettingsDeclares(claudeCustomConfigKeys, true)
		case providerregistry.StatusKindOpenCodeCLI:
			return s.openCodeConfigDeclaresProviderOption("apiKey", "baseURL")
		}
	}
	return false
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
	if status, ok := migratedProviderStatus(provider); ok {
		switch status.Kind {
		case providerregistry.StatusKindCodexCLI:
			return s.codexConfigDeclares("api_key") || s.codexAuthJSONHasAPIKey()
		case providerregistry.StatusKindClaudeCLI:
			return s.claudeSettingsDeclares(claudeAPICredentialKeys, true)
		case providerregistry.StatusKindOpenCodeCLI:
			return s.openCodeConfigHasAPICredential()
		}
	}
	return false
}

func (s Service) codexAuthJSONHasAPIKey() bool {
	codexHome := strings.TrimSpace(s.lookupEnv("CODEX_HOME"))
	if codexHome == "" {
		home, err := s.homeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return false
		}
		codexHome = filepath.Join(home, ".codex")
	}
	content, err := os.ReadFile(filepath.Join(codexHome, "auth.json"))
	if err != nil {
		return false
	}
	var parsed struct {
		OpenAIAPIKey string `json:"OPENAI_API_KEY"`
	}
	if err := json.Unmarshal(content, &parsed); err != nil {
		return false
	}
	return strings.TrimSpace(parsed.OpenAIAPIKey) != ""
}

// providerCustomConfigEnvVars lists env vars that signal a user-provided API
// key OR a custom base URL for a provider — either axis counts as custom config
// for the network-probe skip.
func providerCustomConfigEnvVars(provider string) []string {
	if status, ok := migratedProviderStatus(provider); ok {
		return append([]string(nil), status.CustomConfigEnvVars...)
	}
	return nil
}

// providerCredentialEnvVars lists env vars that signal a user-provided API
// credential (key/token) for a provider — the billing axis only, excluding
// custom base URLs.
func providerCredentialEnvVars(provider string) []string {
	if status, ok := migratedProviderStatus(provider); ok {
		return append([]string(nil), status.CredentialEnvVars...)
	}
	return nil
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

// claudeSettingsDeclares reports whether $CLAUDE_CONFIG_DIR/settings.json sets any of
// the given env keys to a non-blank value, or — when withAPIKeyHelper is true —
// declares a non-blank apiKeyHelper.
func (s Service) claudeSettingsDeclares(keys []string, withAPIKeyHelper bool) bool {
	configDir := strings.TrimSpace(s.lookupEnv("CLAUDE_CONFIG_DIR"))
	if configDir == "" {
		home, err := s.homeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return false
		}
		configDir = filepath.Join(home, ".claude")
	}
	content, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
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
