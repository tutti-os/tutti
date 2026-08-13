package providerstatus

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const claudeLegacyKeychainService = "Claude Code-credentials"

// ClaudeOAuthAccessToken parses the credential grammar shared by Claude Code's
// macOS Keychain item and ~/.claude/.credentials.json. Local expiry metadata is
// deliberately ignored: the provider response is the authentication authority.
func ClaudeOAuthAccessToken(content []byte) (string, bool) {
	var document struct {
		ClaudeAIOAuth *struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(content, &document) != nil || document.ClaudeAIOAuth == nil {
		return "", false
	}
	token := strings.TrimSpace(document.ClaudeAIOAuth.AccessToken)
	return token, token != ""
}

// ClaudeOAuthKeychainServices returns Claude Code 2.1+'s config-scoped service
// followed by the legacy service used by older releases.
func ClaudeOAuthKeychainServices(configDir string) []string {
	configDir = strings.TrimSpace(configDir)
	if configDir == "" {
		return []string{claudeLegacyKeychainService}
	}
	digest := sha256.Sum256([]byte(configDir))
	scoped := claudeLegacyKeychainService + "-" + hex.EncodeToString(digest[:])[:8]
	return []string{scoped, claudeLegacyKeychainService}
}
