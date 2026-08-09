package agentstatus

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
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
// Claude settings.json, OpenCode provider config); kept in sync by intent.

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
			return s.openCodeConfigSignals().custom
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
			return s.codexConfigHasAPICredential() || s.codexAuthJSONHasAPIKey()
		case providerregistry.StatusKindClaudeCLI:
			return s.claudeSettingsHasAPICredential()
		case providerregistry.StatusKindOpenCodeCLI:
			return s.openCodeConfigSignals().credential
		}
	}
	return false
}

type openCodeConfigDocument struct {
	content []byte
	baseDir string
}

type openCodeConfigValue struct {
	value   any
	baseDir string
}

type openCodeConfigObject map[string]openCodeConfigValue

type openCodeConfigSignals struct {
	custom     bool
	credential bool
}

// openCodeConfigSignals reads the global OpenCode config sources that can be
// selected by CCSwitch or the OpenCode CLI. Status detection is intentionally
// provider-agnostic: the status endpoint has no selected model/provider ID, so
// any API key in the final merged provider config is treated as an agent-level
// API credential.
func (s Service) openCodeConfigSignals() openCodeConfigSignals {
	result := openCodeConfigSignals{}
	merged := openCodeConfigObject{}
	for _, document := range s.openCodeConfigDocuments() {
		parsed, err := parseOpenCodeConfig(document.content, document.baseDir)
		if err != nil {
			// Ignore malformed documents and let the native auth marker/CLI
			// probe remain authoritative.
			continue
		}
		mergeOpenCodeConfigObject(merged, parsed)
	}

	providerValue, ok := merged["provider"]
	if !ok {
		return result
	}
	providers, ok := providerValue.value.(openCodeConfigObject)
	if !ok {
		return result
	}
	for _, providerValue := range providers {
		provider, ok := providerValue.value.(openCodeConfigObject)
		if !ok {
			continue
		}
		optionsValue, ok := provider["options"]
		if !ok {
			continue
		}
		options, ok := optionsValue.value.(openCodeConfigObject)
		if !ok {
			continue
		}
		if apiKey, ok := options["apiKey"]; ok && s.openCodeCredentialValueConfigured(apiKey.value, apiKey.baseDir) {
			result.custom = true
			result.credential = true
		}
		for _, key := range []string{"baseURL", "baseUrl"} {
			if raw, ok := options[key]; ok && openCodeConfigStringConfigured(raw.value) {
				result.custom = true
			}
		}
	}
	return result
}

// openCodeConfigDocuments resolves the same global locations used by the
// OpenCode/CCSwitch integration. OPENCODE_CONFIG_DIR selects the global root
// (otherwise XDG_CONFIG_HOME or the user's default root is used); the
// OPENCODE_CONFIG file and OPENCODE_CONFIG_CONTENT are layered afterward.
func (s Service) openCodeConfigDocuments() []openCodeConfigDocument {
	documents := make([]openCodeConfigDocument, 0, 6)
	seen := make(map[string]struct{})
	appendFile := func(path string) {
		path = filepath.Clean(strings.TrimSpace(path))
		if path == "." || path == "" {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return
		}
		seen[path] = struct{}{}
		documents = append(documents, openCodeConfigDocument{content: content, baseDir: filepath.Dir(path)})
	}

	home, _ := s.homeDir()
	expand := func(path string) string {
		return expandHomePath(path, home)
	}

	configDir := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG_DIR"))
	if configDir != "" {
		configDir = expand(configDir)
	} else if xdgConfigHome := strings.TrimSpace(s.lookupEnv("XDG_CONFIG_HOME")); xdgConfigHome != "" {
		configDir = filepath.Join(expand(xdgConfigHome), "opencode")
	} else if strings.TrimSpace(home) != "" {
		configDir = filepath.Join(home, ".config", "opencode")
	}
	for _, name := range []string{"config.json", "opencode.json", "opencode.jsonc"} {
		if configDir != "" {
			appendFile(filepath.Join(configDir, name))
		}
	}
	if path := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG")); path != "" {
		appendFile(expand(path))
	}
	if content := strings.TrimSpace(s.lookupEnv("OPENCODE_CONFIG_CONTENT")); content != "" {
		documents = append(documents, openCodeConfigDocument{content: []byte(content)})
	}
	return documents
}

func parseOpenCodeConfig(content []byte, baseDir string) (openCodeConfigObject, error) {
	cleaned, err := stripOpenCodeJSONC(content)
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(cleaned, &parsed); err != nil {
		return nil, err
	}
	return openCodeConfigObjectFromMap(parsed, baseDir), nil
}

func openCodeConfigObjectFromMap(input map[string]any, baseDir string) openCodeConfigObject {
	result := make(openCodeConfigObject, len(input))
	for key, value := range input {
		if child, ok := value.(map[string]any); ok {
			value = openCodeConfigObjectFromMap(child, baseDir)
		}
		result[key] = openCodeConfigValue{value: value, baseDir: baseDir}
	}
	return result
}

func mergeOpenCodeConfigObject(dst, src openCodeConfigObject) {
	for key, next := range src {
		current, ok := dst[key]
		if ok {
			currentObject, currentOK := current.value.(openCodeConfigObject)
			nextObject, nextOK := next.value.(openCodeConfigObject)
			if currentOK && nextOK {
				mergeOpenCodeConfigObject(currentObject, nextObject)
				current.value = currentObject
				dst[key] = current
				continue
			}
		}
		dst[key] = next
	}
}

func (s Service) openCodeCredentialValueConfigured(raw any, baseDir string) bool {
	value, ok := raw.(string)
	if !ok {
		return false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, "{env:") && strings.HasSuffix(value, "}") {
		name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, "{env:"), "}"))
		return name != "" && strings.TrimSpace(s.lookupEnv(name)) != ""
	}
	if strings.HasPrefix(value, "{file:") && strings.HasSuffix(value, "}") {
		path := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, "{file:"), "}"))
		if path == "" {
			return false
		}
		home, _ := s.homeDir()
		path = expandHomePath(path, home)
		if !filepath.IsAbs(path) {
			path = filepath.Join(baseDir, path)
		}
		content, err := os.ReadFile(filepath.Clean(path))
		return err == nil && strings.TrimSpace(string(content)) != ""
	}
	return true
}

func openCodeConfigStringConfigured(raw any) bool {
	value, ok := raw.(string)
	return ok && strings.TrimSpace(value) != ""
}

func stripOpenCodeJSONC(input []byte) ([]byte, error) {
	output := make([]byte, 0, len(input))
	inString, escaped, lineComment, blockComment := false, false, false, false
	for i := 0; i < len(input); i++ {
		current := input[i]
		if lineComment {
			if current == '\n' {
				lineComment = false
				output = append(output, current)
			}
			continue
		}
		if blockComment {
			if current == '*' && i+1 < len(input) && input[i+1] == '/' {
				blockComment = false
				i++
				continue
			}
			if current == '\n' || current == '\r' {
				output = append(output, current)
			}
			continue
		}
		if inString {
			output = append(output, current)
			if escaped {
				escaped = false
			} else if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		switch current {
		case '"':
			inString = true
			output = append(output, current)
		case '/':
			if i+1 < len(input) && input[i+1] == '/' {
				lineComment = true
				i++
			} else if i+1 < len(input) && input[i+1] == '*' {
				blockComment = true
				i++
			} else {
				output = append(output, current)
			}
		default:
			output = append(output, current)
		}
	}
	if blockComment {
		return nil, fmt.Errorf("unterminated block comment")
	}
	return removeOpenCodeTrailingCommas(output), nil
}

func removeOpenCodeTrailingCommas(input []byte) []byte {
	output := make([]byte, 0, len(input))
	inString, escaped := false, false
	for i := 0; i < len(input); i++ {
		current := input[i]
		if inString {
			output = append(output, current)
			if escaped {
				escaped = false
			} else if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		if current == '"' {
			inString = true
			output = append(output, current)
			continue
		}
		if current == ',' {
			next := i + 1
			for next < len(input) && (input[next] == ' ' || input[next] == '\t' || input[next] == '\r' || input[next] == '\n') {
				next++
			}
			if next < len(input) && (input[next] == '}' || input[next] == ']') {
				continue
			}
		}
		output = append(output, current)
	}
	return output
}

func (s Service) codexConfigHasAPICredential() bool {
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
	return providerstatus.CodexConfigTOMLHasAPICredential(content)
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
	return providerstatus.CodexAuthJSONHasAPICredential(content)
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

func (s Service) claudeSettingsHasAPICredential() bool {
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
	return providerstatus.ClaudeSettingsHasAPICredential(content)
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
