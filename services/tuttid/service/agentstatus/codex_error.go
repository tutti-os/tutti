package agentstatus

import "strings"

// CodexErrorCode is a structured classification of a Codex failure, surfaced to
// the renderer so the UI can show one human sentence plus one remediation
// action instead of a raw spawn stack or JSON payload.
type CodexErrorCode string

const (
	// CodexErrCLIMissing: the codex CLI is not resolvable on PATH.
	CodexErrCLIMissing CodexErrorCode = "CODEX_CLI_MISSING"
	// CodexErrPlatformPkgIncomplete: the @openai/codex wrapper resolved but its
	// platform-specific binary subpackage is missing (the field ENOENT).
	CodexErrPlatformPkgIncomplete CodexErrorCode = "CODEX_PLATFORM_PKG_INCOMPLETE"
	// CodexErrVersionTooOld: the installed codex is below MinSupportedCodexVersion
	// or the server rejected the request as requiring a newer version.
	CodexErrVersionTooOld CodexErrorCode = "CODEX_VERSION_TOO_OLD"
	// CodexErrVersionUnknown: the CLI exists but `--version` did not yield a
	// parseable semantic version, so compatibility cannot be established.
	CodexErrVersionUnknown CodexErrorCode = "CODEX_VERSION_UNKNOWN"
	// CodexErrAuthRequired: codex is installed but not logged in.
	CodexErrAuthRequired CodexErrorCode = "CODEX_AUTH_REQUIRED"
	// CodexErrNetwork: an install or request failed for a network reason.
	CodexErrNetwork CodexErrorCode = "CODEX_NETWORK"
)

// classifyCodexRuntimeError maps a raw error/message string from spawning or
// requesting codex into a structured CodexErrorCode. ok is false when the
// message does not match any known pattern.
func classifyCodexRuntimeError(msg string) (CodexErrorCode, bool) {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "requires a newer version"):
		return CodexErrVersionTooOld, true
	case strings.Contains(lower, "enoent") && strings.Contains(lower, "@openai/codex-"):
		return CodexErrPlatformPkgIncomplete, true
	case strings.Contains(lower, "enoent"):
		return CodexErrCLIMissing, true
	case strings.Contains(lower, "not logged in") || strings.Contains(lower, "please run /login"):
		return CodexErrAuthRequired, true
	case codexErrorLooksLikeNetwork(lower):
		return CodexErrNetwork, true
	default:
		return "", false
	}
}

func codexErrorLooksLikeNetwork(lower string) bool {
	for _, marker := range []string{"etimedout", "enotfound", "econnrefused", "econnreset", "network", "socket hang up", "getaddrinfo"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
