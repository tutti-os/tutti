package agentstatus

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

func runCursorAuthStatusCommand(ctx context.Context, binaryPath string, env []string) (AuthInfo, string, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	proxyEnv := runtimecmd.InjectSystemProxyEnv(env)
	commandCtx, cancel := context.WithTimeout(ctx, authStatusCommandTimeout)
	defer cancel()
	output, ok := runCursorCLICommand(commandCtx, binaryPath, []string{"about", "--format", "json"}, proxyEnv)
	if !ok {
		return AuthInfo{}, "", false
	}
	return parseCursorAboutOutput(output)
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

func parseCursorAboutOutput(output []byte) (AuthInfo, string, bool) {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return AuthInfo{}, "", false
	}
	if trimmed[0] == '{' {
		return parseCursorAboutJSONWithVersion(trimmed)
	}
	return parseCursorAboutTextWithVersion(trimmed)
}

func parseCursorAboutJSON(output []byte) (AuthInfo, bool) {
	auth, _, ok := parseCursorAboutJSONWithVersion(output)
	return auth, ok
}

func parseCursorAboutJSONWithVersion(output []byte) (AuthInfo, string, bool) {
	var payload struct {
		CLIVersion       string          `json:"cliVersion"`
		SubscriptionTier *string         `json:"subscriptionTier"`
		UserEmail        json.RawMessage `json:"userEmail"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return AuthInfo{}, "", false
	}
	cliVersion := strings.TrimSpace(payload.CLIVersion)
	if len(payload.UserEmail) > 0 && string(payload.UserEmail) == "null" {
		return AuthInfo{Status: AuthRequired}, cliVersion, true
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
		return AuthInfo{Status: AuthRequired}, cliVersion, true
	}
	if userEmail == "" && subscriptionTier == "" {
		return AuthInfo{}, cliVersion, false
	}
	return AuthInfo{
		Status:       AuthAuthenticated,
		AccountLabel: formatCursorAccountLabel(subscriptionTier, userEmail),
		AuthMethod:   "cursor_login",
	}, cliVersion, true
}

func parseCursorAboutTextWithVersion(output []byte) (AuthInfo, string, bool) {
	plain := stripANSIEscapeSequences(string(output))
	version := extractCursorAboutField(plain, "CLI Version")
	userEmail := extractCursorAboutField(plain, "User Email")
	subscriptionTier := extractCursorAboutField(plain, "Subscription Tier")
	if userEmail == "" && subscriptionTier == "" && version == "" {
		return AuthInfo{}, "", false
	}
	if isCursorUnauthenticatedEmail(userEmail) {
		return AuthInfo{Status: AuthRequired}, version, true
	}
	if userEmail == "" && subscriptionTier == "" {
		return AuthInfo{Status: AuthAuthenticated}, version, true
	}
	return AuthInfo{
		Status:       AuthAuthenticated,
		AccountLabel: formatCursorAccountLabel(subscriptionTier, userEmail),
		AuthMethod:   "cursor_login",
	}, version, true
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
