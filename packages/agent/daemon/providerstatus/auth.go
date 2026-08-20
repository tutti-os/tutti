package providerstatus

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

// AuthStatus is the provider-reported authentication state.
type AuthStatus string

const (
	AuthAuthenticated AuthStatus = "authenticated"
	AuthConfigured    AuthStatus = "configured"
	AuthRequired      AuthStatus = "required"
	AuthUnknown       AuthStatus = "unknown"
)

// AuthInfo is the provider-neutral result of parsing an auth status command.
type AuthInfo struct {
	Status       AuthStatus
	AccountLabel string
	AuthMethod   string
}

// ParseAuthStatusOutput interprets the output of a descriptor-owned provider
// auth status command. The bool is false when the output is not authoritative.
func ParseAuthStatusOutput(
	parserKind providerregistry.AuthOutputParserKind,
	output []byte,
) (AuthInfo, bool) {
	if auth, ok := parseConfigurationError(output); ok {
		return auth, true
	}
	switch parserKind {
	case providerregistry.AuthOutputParserKindCodex:
		return parseCodexAuthStatusOutput(output)
	case providerregistry.AuthOutputParserKindClaude:
		return parseClaudeAuthStatusOutput(output)
	case providerregistry.AuthOutputParserKindOpenCode:
		return parseOpenCodeAuthStatusOutput(output)
	case providerregistry.AuthOutputParserKindCursor:
		return parseCursorAuthStatusOutput(output)
	default:
		return AuthInfo{}, false
	}
}

func parseConfigurationError(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if strings.Contains(normalized, "error loading configuration") {
		return AuthInfo{Status: AuthUnknown}, true
	}
	return AuthInfo{}, false
}

func parseCodexAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "logged out") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "logged in") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
}

func parseClaudeAuthStatusOutput(output []byte) (AuthInfo, bool) {
	output = bytes.TrimSpace(output)
	if len(output) == 0 {
		return AuthInfo{}, false
	}
	var payload struct {
		AccountLabel string `json:"accountLabel"`
		AuthMethod   string `json:"authMethod"`
		Email        string `json:"email"`
		LoggedIn     *bool  `json:"loggedIn"`
	}
	if err := json.Unmarshal(output, &payload); err == nil && payload.LoggedIn != nil {
		if *payload.LoggedIn {
			return AuthInfo{
				AccountLabel: firstNonBlank(payload.AccountLabel, payload.Email, payload.AuthMethod),
				AuthMethod:   payload.AuthMethod,
				Status:       AuthAuthenticated,
			}, true
		}
		return AuthInfo{Status: AuthRequired, AuthMethod: payload.AuthMethod}, true
	}
	normalized := strings.ToLower(string(output))
	if strings.Contains(normalized, `"loggedin":false`) ||
		strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "logged out") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, `"loggedin":true`) ||
		strings.Contains(normalized, "logged in") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
}

var openCodeCredentialCountPattern = regexp.MustCompile(`([0-9]+)\s+credentials?\b`)

func parseOpenCodeAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if match := openCodeCredentialCountPattern.FindStringSubmatch(normalized); len(match) == 2 {
		if strings.TrimLeft(match[1], "0") == "" {
			return AuthInfo{Status: AuthRequired}, true
		}
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	if strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "not authenticated") ||
		strings.Contains(normalized, "no authenticated") ||
		strings.Contains(normalized, "no providers") ||
		strings.Contains(normalized, "unauthenticated") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "logged in") ||
		strings.Contains(normalized, "authenticated") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
}

func parseCursorAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "logged out") ||
		strings.Contains(normalized, "not authenticated") ||
		strings.Contains(normalized, "unauthenticated") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "logged in") ||
		strings.Contains(normalized, "authenticated") {
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: cursorAccountLabel(string(output)),
		}, true
	}
	return AuthInfo{}, false
}

func cursorAccountLabel(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		const prefix = "logged in as "
		if strings.HasPrefix(strings.ToLower(trimmed), prefix) {
			label := strings.TrimSpace(trimmed[len(prefix):])
			if label != "" && !isCursorUnauthenticatedLabel(label) {
				return label
			}
		}
	}
	return ""
}

func isCursorUnauthenticatedLabel(label string) bool {
	normalized := strings.ToLower(strings.TrimSpace(label))
	return normalized == "not logged in" ||
		strings.Contains(normalized, "login required") ||
		strings.Contains(normalized, "authentication required")
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
