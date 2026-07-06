package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// claudeAuthScopeEnvKeys are the environment inputs that select which Claude
// account / billing context a session runs under — and therefore which model
// list the SDK advertises. Fingerprinting them into the live-model cache key
// keeps one auth context's model list from being served after the user switches
// to another (e.g. OAuth subscription -> ANTHROPIC_API_KEY billing) when no
// running session is present to correct it via the reuse path.
//
// Keychain OAuth accounts are intentionally NOT read here: doing so is
// credential-touching (the exact operation the hidden-discovery serialization
// exists to minimize). Two OAuth subscriptions therefore share one scope; that
// residual case is reconciled the moment a real session runs (running-session
// first ordering in mergeLiveComposerModelsForComposerOptions).
var claudeAuthScopeEnvKeys = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_API_BASE_URL",
	"CLAUDE_CONFIG_DIR",
}

// liveModelAuthScope returns a stable, non-secret fingerprint of the auth
// context for the provider, or "" when the provider's model list is not
// auth-sensitive (every non-Claude provider today). The fingerprint is a hash,
// so raw credentials never enter the cache key.
func liveModelAuthScope(provider string) string {
	if agentprovider.Normalize(provider) != agentprovider.ClaudeCode {
		return ""
	}
	settingsEnv := claudeSettingsEnvBlock()
	var b strings.Builder
	for _, key := range claudeAuthScopeEnvKeys {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			value = strings.TrimSpace(settingsEnv[key])
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(value)
		b.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:8])
}

// claudeSettingsEnvBlock reads the `env` block of ~/.claude/settings.json (or
// $CLAUDE_CONFIG_DIR/settings.json). Claude Code merges these into the process
// environment, so an ANTHROPIC_API_KEY declared there is as authoritative as one
// exported in the shell. Missing file or malformed JSON yields an empty map.
func claudeSettingsEnvBlock() map[string]string {
	claudeConfigDir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if claudeConfigDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		claudeConfigDir = filepath.Join(home, ".claude")
	}
	settings := readJSONRecord(filepath.Join(claudeConfigDir, "settings.json"))
	envRaw, ok := settings["env"].(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]string, len(envRaw))
	for key, raw := range envRaw {
		if value, ok := raw.(string); ok {
			result[key] = value
		}
	}
	return result
}
