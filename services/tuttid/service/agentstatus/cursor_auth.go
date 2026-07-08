package agentstatus

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

const cursorAuthStatusProbeCount = 3

func runCursorAuthStatusCommand(ctx context.Context, binaryPath string, env []string) (AuthInfo, bool) {
	proxyEnv := runtimecmd.InjectSystemProxyEnv(env)

	attempts := []struct {
		args  []string
		parse func([]byte) (AuthInfo, bool)
	}{
		{
			args:  []string{"about", "--format", "json"},
			parse: parseCursorAboutOutput,
		},
		{
			args:  []string{"about"},
			parse: parseCursorAboutOutput,
		},
		{
			args:  []string{"status"},
			parse: parseCursorAuthStatusOutput,
		},
	}
	for _, attempt := range attempts {
		attemptCtx, cancel := cursorAuthStatusAttemptContext(ctx)
		auth, ok := runCursorCLICommand(attemptCtx, binaryPath, attempt.args, proxyEnv)
		cancel()
		if !ok {
			continue
		}
		if parsed, ok := attempt.parse(auth); ok {
			return parsed, true
		}
	}
	return AuthInfo{}, false
}

func cursorAuthStatusAttemptContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, cursorAuthStatusAttemptTimeout())
}

func cursorAuthStatusAttemptTimeout() time.Duration {
	return authStatusCommandTimeout / cursorAuthStatusProbeCount
}

func runCursorCLICommand(
	ctx context.Context,
	binaryPath string,
	args []string,
	env []string,
) ([]byte, bool) {
	command := exec.CommandContext(ctx, binaryPath, args...)
	command.Env = env
	output, err := command.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			output = append(output, exitErr.Stderr...)
		} else {
			return nil, false
		}
	}
	if len(bytes.TrimSpace(output)) == 0 {
		return nil, false
	}
	return output, true
}

// parseCursorAuthStatusOutput interprets `cursor-agent status` output, which
// reports the login state as human-readable text (e.g. "Logged in as
// user@example.com" / "Not logged in. Run cursor-agent login").
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
		accountLabel := cursorAuthStatusAccountLabel(string(output))
		if accountLabel == "" {
			return AuthInfo{Status: AuthAuthenticated}, true
		}
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: accountLabel,
		}, true
	}
	return AuthInfo{}, false
}

func parseCursorAboutOutput(output []byte) (AuthInfo, bool) {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return AuthInfo{}, false
	}
	if trimmed[0] == '{' {
		return parseCursorAboutJSON(trimmed)
	}
	return parseCursorAboutText(trimmed)
}

func parseCursorAboutJSON(output []byte) (AuthInfo, bool) {
	var payload struct {
		CLIVersion       string          `json:"cliVersion"`
		SubscriptionTier *string         `json:"subscriptionTier"`
		UserEmail        json.RawMessage `json:"userEmail"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return AuthInfo{}, false
	}
	if len(payload.UserEmail) > 0 && string(payload.UserEmail) == "null" {
		return AuthInfo{Status: AuthRequired}, true
	}
	userEmail := ""
	if len(payload.UserEmail) > 0 && string(payload.UserEmail) != "null" {
		var decoded string
		if err := json.Unmarshal(payload.UserEmail, &decoded); err == nil {
			userEmail = strings.TrimSpace(decoded)
		}
	}
	subscriptionTier := ""
	if payload.SubscriptionTier != nil {
		subscriptionTier = strings.TrimSpace(*payload.SubscriptionTier)
	}
	if isCursorUnauthenticatedEmail(userEmail) {
		return AuthInfo{Status: AuthRequired}, true
	}
	if userEmail == "" && subscriptionTier == "" {
		return AuthInfo{}, false
	}
	return AuthInfo{
		Status:       AuthAuthenticated,
		AccountLabel: formatCursorAccountLabel(subscriptionTier, userEmail),
		AuthMethod:   "cursor_login",
	}, true
}

func parseCursorAboutText(output []byte) (AuthInfo, bool) {
	plain := stripANSIEscapeSequences(string(output))
	version := extractCursorAboutField(plain, "CLI Version")
	userEmail := extractCursorAboutField(plain, "User Email")
	subscriptionTier := extractCursorAboutField(plain, "Subscription Tier")
	if userEmail == "" && subscriptionTier == "" && version == "" {
		return AuthInfo{}, false
	}
	if isCursorUnauthenticatedEmail(userEmail) {
		return AuthInfo{Status: AuthRequired}, true
	}
	if userEmail == "" && subscriptionTier == "" {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{
		Status:       AuthAuthenticated,
		AccountLabel: formatCursorAccountLabel(subscriptionTier, userEmail),
		AuthMethod:   "cursor_login",
	}, true
}

func formatCursorAccountLabel(subscriptionTier, userEmail string) string {
	subscriptionTier = strings.TrimSpace(subscriptionTier)
	userEmail = strings.TrimSpace(userEmail)
	switch {
	case subscriptionTier != "" && userEmail != "":
		return "Cursor " + cursorSubscriptionDisplayName(subscriptionTier) + " · " + userEmail
	case subscriptionTier != "":
		return "Cursor " + cursorSubscriptionDisplayName(subscriptionTier)
	case userEmail != "":
		return userEmail
	default:
		return ""
	}
}

func cursorSubscriptionDisplayName(subscriptionTier string) string {
	normalized := strings.ToLower(strings.TrimSpace(subscriptionTier))
	switch normalized {
	case "free":
		return "Free"
	case "pro":
		return "Pro"
	case "pro+":
		return "Pro+"
	case "ultra":
		return "Ultra"
	case "team":
		return "Team"
	case "business":
		return "Business"
	case "enterprise":
		return "Enterprise"
	default:
		return strings.TrimSpace(subscriptionTier)
	}
}

func cursorAuthStatusAccountLabel(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		const prefix = "logged in as "
		if strings.HasPrefix(lower, prefix) {
			email := strings.TrimSpace(trimmed[len(prefix):])
			if email != "" && !isCursorUnauthenticatedEmail(email) {
				return email
			}
		}
	}
	return ""
}

func isCursorUnauthenticatedEmail(email string) bool {
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" {
		return false
	}
	return normalized == "not logged in" ||
		strings.Contains(normalized, "login required") ||
		strings.Contains(normalized, "authentication required")
}

func extractCursorAboutField(plain, key string) string {
	regex := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `\s{2,}(.+)$`)
	match := regex.FindStringSubmatch(plain)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func stripANSIEscapeSequences(value string) string {
	ansiPattern := regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07`)
	return ansiPattern.ReplaceAllString(value, "")
}
