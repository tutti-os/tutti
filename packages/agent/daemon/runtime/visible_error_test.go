package agentruntime

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
)

func TestVisibleFailureCodeClassifiesDeadlineExceededAsRequestTimedOut(t *testing.T) {
	if got := visibleFailureCode("context deadline exceeded"); got != "request_timed_out" {
		t.Fatalf("visibleFailureCode() = %q, want request_timed_out", got)
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

func TestVisibleFailureCodeClassifiesGenuineExitAsProcessExited(t *testing.T) {
	// A non-zero exit that is NOT a missing binary stays process_exited.
	if got := visibleFailureCode("codex process exited with code 1"); got != "process_exited" {
		t.Fatalf("visibleFailureCode() = %q, want process_exited", got)
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

func reportTestSource() agentsessionstore.EventSource {
	return agentsessionstore.EventSource{Provider: ProviderClaudeCode}
}
