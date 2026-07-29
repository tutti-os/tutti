package agentruntime

import (
	"errors"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestVisibleFailureCodeClassifiesDeadlineExceededAsRequestTimedOut(t *testing.T) {
	if got := visibleFailureCode("context deadline exceeded"); got != "request_timed_out" {
		t.Fatalf("visibleFailureCode() = %q, want request_timed_out", got)
	}
}

func TestIsAuthenticationRequiredClassifiesGeminiMissingAPIKey(t *testing.T) {
	err := errors.New("Gemini API key is missing or not configured")
	if !IsAuthenticationRequired(err) {
		t.Fatalf("IsAuthenticationRequired(%q) = false, want true", err)
	}
}

func TestVisibleFailureCodeClassifiesProviderConcurrencyLimit(t *testing.T) {
	detail := `stream disconnected before completion: Concurrency limit exceeded for user, please retry later`
	if got := visibleFailureCode(detail); got != "provider_concurrency_limit" {
		t.Fatalf("visibleFailureCode() = %q, want provider_concurrency_limit", got)
	}
}

func TestVisibleFailureCodeClassifiesConfigTimeout(t *testing.T) {
	detail := `agent session ACP effort configuration failed: acp session/set_config_option timed out after 30s`
	if got := visibleFailureCode(detail); got != "provider_config_timeout" {
		t.Fatalf("visibleFailureCode() = %q, want provider_config_timeout", got)
	}
}

func TestVisibleFailureContentDescribesStartupConfigTimeout(t *testing.T) {
	got := visibleFailureContent(ProviderCodex, "start", "provider_config_timeout")
	want := "Codex could not apply session settings before startup timed out. Try again in a moment."
	if got != want {
		t.Fatalf("visibleFailureContent() = %q, want %q", got, want)
	}
}

func TestVisibleFailureCodeClassifiesStreamDisconnected(t *testing.T) {
	detail := `stream disconnected before completion: Transport error: network error: error decoding response body`
	if got := visibleFailureCode(detail); got != "provider_stream_disconnected" {
		t.Fatalf("visibleFailureCode() = %q, want provider_stream_disconnected", got)
	}
}

func TestVisibleFailureCodeDoesNotTreatPatchContextLoginTextAsAuth(t *testing.T) {
	// Test-function text in the stderr tail ("...Login...") must never read as
	// codex auth. The process exited cleanly (code 0) with that apply_patch error
	// only as incidental tail output, so it classifies as an interrupted session —
	// the one thing it must NOT be is auth_required.
	detail := `acp process exited with code 0: process exited: ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /Users/wwcome/work/tutti-os/tutti/services/tuttid/service/agentstatus/service_test.go:
func TestServiceLoginRunsProviderLoginCommand(t *testing.T) {
	service := testService(func(name string) (string, error) {`
	if got := visibleFailureCode(detail); got == "auth_required" {
		t.Fatalf("visibleFailureCode() = auth_required, but embedded test text must not read as codex auth")
	}
}

func TestVisibleFailureCodeDoesNotTreatMcpServerAuthAsCodexAuth(t *testing.T) {
	// A Notion/Figma MCP server's expired OAuth token crashes codex's MCP client
	// (rmcp) and bubbles up here. It mentions "access token"/"AuthRequired", which
	// trips the auth pattern, but codex itself is still signed in — so this must
	// NOT surface as "Codex needs authentication". The exit is code 0 (a clean
	// shutdown), so it reads as an interrupted session, never auth_required.
	detail := `acp process exited with code 0: process exited: ERROR rmcp::transport::worker: ` +
		`worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { ` +
		`www_authenticate_header: "Bearer realm=\"OAuth\", ` +
		`resource_metadata=\"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp\", ` +
		`error=\"invalid_token\", error_description=\"Missing or invalid access token\"" })`
	if got := visibleFailureCode(detail); got == "auth_required" {
		t.Fatalf("visibleFailureCode() = auth_required, but MCP server auth must not read as codex auth")
	}
	if got := visibleFailureCode(detail); got != "session_interrupted" {
		t.Fatalf("visibleFailureCode() = %q, want session_interrupted (clean exit-0 MCP failure)", got)
	}
}

func TestVisibleFailureCodeClassifiesCleanExitAsInterrupted(t *testing.T) {
	// A clean exit (code 0) reaching here means the app-server was stopped
	// externally mid-turn (host quit, or an agent killed its own host) — the
	// session was interrupted, not "Codex request failed".
	for _, detail := range []string{
		"acp process exited with code 0: ",
		"acp process exited with code 0: shutting down",
	} {
		if got := visibleFailureCode(detail); got != "session_interrupted" {
			t.Fatalf("visibleFailureCode(%q) = %q, want session_interrupted", detail, got)
		}
	}
	if !visibleFailureRetryable("session_interrupted", "acp process exited with code 0: ") {
		t.Fatal("session_interrupted should be retryable")
	}
}

func TestVisibleFailureCodeClassifiesSignalKillAsInterrupted(t *testing.T) {
	// Signal-terminations (128+N: 137 SIGKILL, 143 SIGTERM, 130 SIGINT) are the
	// process being killed externally, not codex erroring out.
	for _, detail := range []string{
		"acp process exited with code 137: ",
		"acp process exited with code 143: ",
		"acp process exited with code 130: ",
	} {
		if got := visibleFailureCode(detail); got != "session_interrupted" {
			t.Fatalf("visibleFailureCode(%q) = %q, want session_interrupted", detail, got)
		}
	}
}

func TestVisibleFailureCodeClassifiesGoSignalExitAsInterrupted(t *testing.T) {
	// Regression: the claude-code sidecar's process wrapper
	// (localProcessConnection in process_transport.go) reports a
	// signal-terminated exit via Go's exec.ExitError.ExitCode(), which
	// returns -1 — not the 128+N convention codex's own app-server uses for
	// the same event. Seen in the field: tuttid's graceful-shutdown path
	// (CloseAllLiveSessions) sends SIGTERM to a live claude-code sidecar
	// mid-turn, and the resulting "exited with code -1" must read as a calm,
	// retryable interruption rather than "Claude Code request failed".
	for _, detail := range []string{
		"claude sdk sidecar exited with code -1",
		"claude sdk sidecar exited with code -1: ",
	} {
		if got := visibleFailureCode(detail); got != "session_interrupted" {
			t.Fatalf("visibleFailureCode(%q) = %q, want session_interrupted", detail, got)
		}
	}
	if !visibleFailureRetryable("session_interrupted", "claude sdk sidecar exited with code -1") {
		t.Fatal("session_interrupted should be retryable")
	}
}

func TestVisibleFailureCodeClassifiesUsageLimitAsQuota(t *testing.T) {
	// The most common real codex failure in the field is the ChatGPT usage cap,
	// delivered as plain text (no structured codexErrorInfo). It must read as a
	// quota/rate-limit, not a generic "request failed".
	detail := "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
		"visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later."
	if got := visibleFailureCode(detail); got != "quota_or_rate_limit" {
		t.Fatalf("visibleFailureCode() = %q, want quota_or_rate_limit", got)
	}
}

func TestVisibleFailureCodeClassifiesTuttiInsufficientCredits(t *testing.T) {
	for _, detail := range []string{
		`unexpected status 402 Payment Required: pre-deduct credits failed, url: https://llm-api.tutti.sh/v1/responses`,
		`unexpected status 402 Payment Required: {"error":{"message":"insufficient credits","type":"billing_error","code":"insufficient_credits"}}`,
		`You've hit your usage limit. Insufficient credits. View Tutti plans at https://tutti.sh/profile/plan, or try again later.`,
	} {
		if got := visibleFailureCode(detail); got != "insufficient_credits" {
			t.Fatalf("visibleFailureCode(%q) = %q, want insufficient_credits", detail, got)
		}
	}
	if visibleFailureRetryable("insufficient_credits", "402 Payment Required") {
		t.Fatal("insufficient_credits should not be retryable")
	}
}

func TestVisibleFailureContentDescribesTuttiInsufficientCredits(t *testing.T) {
	got := visibleFailureContent(ProviderTuttiAgent, "turn", "insufficient_credits")
	want := "Tutti Agent could not continue because your Tutti credits are insufficient."
	if got != want {
		t.Fatalf("visibleFailureContent() = %q, want %q", got, want)
	}
}

func TestVisibleFailureCodeDoesNotMisclassifyStructuredProviderFailuresAsAuth(t *testing.T) {
	tests := map[string]string{
		`HTTP 403: {"error":{"code":"model_not_allowed","message":"authorization denied for model"}}`:                     "model_not_allowed",
		`MCP client for codex_apps failed: HTTP 451: {"message":"no_biscuit_no_service"} authentication transport failed`: "plugin_unavailable",
		`HTTP 451: {"message":"no_biscuit_no_service"} authentication transport failed`:                                   "provider_error",
	}
	for detail, want := range tests {
		if got := visibleFailureCode(detail); got != want {
			t.Fatalf("visibleFailureCode(%q) = %q, want %q", detail, got, want)
		}
	}
}

func TestVisibleFailureContentDescribesInterruptedSession(t *testing.T) {
	got := visibleFailureContent(ProviderCodex, "turn", "session_interrupted")
	want := "Codex stopped unexpectedly before it finished responding. Try again."
	if got != want {
		t.Fatalf("visibleFailureContent() = %q, want %q", got, want)
	}
}

func TestVisibleFailureCodeStillClassifiesCodexOwnAuth(t *testing.T) {
	// Codex's own login failure must still be auth_required (guard against the MCP
	// exclusion being too broad).
	for _, detail := range []string{
		"acp process exited with code 1: process exited: not logged in. Please run /login.",
		"401 Unauthorized: invalid authentication credentials",
	} {
		if got := visibleFailureCode(detail); got != "auth_required" {
			t.Fatalf("visibleFailureCode(%q) = %q, want auth_required", detail, got)
		}
	}
}

func TestVisibleFailureCodeClassifiesMissingBinaryAsCliNotFound(t *testing.T) {
	// A run that can't find the CLI binary surfaces as an exec error; this is the
	// real "not installed / not on PATH" failure (the aspirational CODEX_CLI_MISSING
	// never reaches the run pipeline), so it must be distinct from a genuine exit.
	for _, detail := range []string{
		`fork/exec /Users/asdf/.local/bin/codex: no such file or directory`,
		`spawn codex ENOENT`,
		`codex: command not found`,
	} {
		if got := visibleFailureCode(detail); got != "cli_not_found" {
			t.Fatalf("visibleFailureCode(%q) = %q, want cli_not_found", detail, got)
		}
	}
}

func TestVisibleFailureCodeDoesNotClassifyMetadataReadAsMissingCLI(t *testing.T) {
	detail := `read claude system prompt: open /run/tsh/managed-agent/session/claude-system-prompt.md: no such file or directory`
	if got := visibleFailureCode(detail); got != "provider_error" {
		t.Fatalf("visibleFailureCode(%q) = %q, want provider_error", detail, got)
	}
}

func TestVisibleFailureCodeClassifiesGenuineExitAsProcessExited(t *testing.T) {
	// A non-zero exit that is NOT a missing binary stays process_exited.
	if got := visibleFailureCode("codex process exited with code 1"); got != "process_exited" {
		t.Fatalf("visibleFailureCode() = %q, want process_exited", got)
	}
}

func TestVisibleFailureCodeClassifiesExplicitLoginFailureAsAuth(t *testing.T) {
	if got := visibleFailureCode("Please login to continue."); got != "auth_required" {
		t.Fatalf("visibleFailureCode() = %q, want auth_required", got)
	}
}

func TestVisibleFailureCodeClassifiesVersionUnsupported(t *testing.T) {
	for _, detail := range []string{
		`codex-acp requires a newer version of codex`,
		`installed codex version is too old`,
	} {
		if got := visibleFailureCode(detail); got != "cli_version_unsupported" {
			t.Fatalf("visibleFailureCode(%q) = %q, want cli_version_unsupported", detail, got)
		}
	}
}

func TestVisibleFailureCodeClassifiesNetworkError(t *testing.T) {
	for _, detail := range []string{
		`request failed: getaddrinfo ENOTFOUND api.anthropic.com`,
		`connect ECONNREFUSED 127.0.0.1:443`,
		`Error: socket hang up`,
	} {
		if got := visibleFailureCode(detail); got != "network_error" {
			t.Fatalf("visibleFailureCode(%q) = %q, want network_error", detail, got)
		}
	}
}

func TestVisibleFailureCodeStreamDisconnectBeatsNetworkMarker(t *testing.T) {
	// A stream-disconnect detail can also mention "network error"; the more
	// specific stream classification must still win.
	detail := `stream disconnected before completion: Transport error: network error: error decoding response body`
	if got := visibleFailureCode(detail); got != "provider_stream_disconnected" {
		t.Fatalf("visibleFailureCode() = %q, want provider_stream_disconnected", got)
	}
}

func TestVisibleFailureRetryableForNetworkButNotMissingCli(t *testing.T) {
	if !visibleFailureRetryable("network_error", "ECONNRESET") {
		t.Fatal("network_error should be retryable")
	}
	if visibleFailureRetryable("cli_not_found", "ENOENT") {
		t.Fatal("cli_not_found should not be retryable")
	}
}

func TestVisibleFailureTimelineItemCarriesTimeoutCodeForTurnFailures(t *testing.T) {
	session := reportTestSession()
	event := newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
		"error": "context deadline exceeded",
	})

	item, ok := visibleFailureTimelineItem("room-1", reportTestSource(), event, session.AgentSessionID, 123)
	if !ok {
		t.Fatal("visibleFailureTimelineItem() returned ok=false")
	}
	if got := item.Payload["code"]; got != "request_timed_out" {
		t.Fatalf("visible failure code = %#v, want request_timed_out", got)
	}
	if got := item.Payload["phase"]; got != "turn" {
		t.Fatalf("visible failure phase = %#v, want turn", got)
	}
}

func reportTestSource() canonical.EventSource {
	return canonical.EventSource{Provider: ProviderClaudeCode}
}
