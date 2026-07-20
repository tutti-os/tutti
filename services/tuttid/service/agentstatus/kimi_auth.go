package agentstatus

import (
	"bytes"
	"strings"
)

// parseKimiCodeAuthStatusOutput interprets `kimi provider list` output. A
// signed-in CLI lists the managed provider row (e.g.
// "managed:kimi-code  type=kimi  models=3  source=oauth"); a signed-out CLI
// prints "No providers configured.".
func parseKimiCodeAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(stripANSIEscapeSequences(string(bytes.TrimSpace(output))))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if strings.Contains(normalized, "no providers configured") ||
		strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "login required") ||
		strings.Contains(normalized, "unauthenticated") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "source=oauth") ||
		strings.Contains(normalized, "source=api_key") ||
		strings.Contains(normalized, "key set") {
		return AuthInfo{Status: AuthAuthenticated, AuthMethod: "kimi_login"}, true
	}
	return AuthInfo{}, false
}
