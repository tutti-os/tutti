package agentruntime

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// IsAuthenticationRequired reports whether a runtime startup failure is an
// authentication gate. Setup probes use the same classification as sessions.
func IsAuthenticationRequired(err error) bool {
	if err == nil {
		return false
	}
	// Some runtimes wrap account-state failures in an authentication-shaped
	// error because model discovery uses the same credentialed endpoint. The
	// account state is more specific and must win, otherwise setup sends users
	// back through login even though a subscription, balance, or quota is the
	// actual blocker.
	if ClassifyAccountFailure(err) != "" {
		return false
	}
	var callErr *acpCallError
	if errors.As(err, &callErr) {
		return callErr.AuthRequired()
	}
	return AppErrorCode(err) == "auth_required"
}

const (
	visibleErrorKind     = "agent_visible_error"
	visibleErrorSeverity = "error"

	FailureCodeInsufficientCredits  = "insufficient_credits"
	FailureCodeModelNotAllowed      = "model_not_allowed"
	FailureCodeQuotaOrRateLimit     = "quota_or_rate_limit"
	FailureCodeSubscriptionRequired = "subscription_required"
)

var (
	ansiEscapePattern  = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	authFailurePattern = regexp.MustCompile(
		`(?i)\b(api key|credentials?|log in|login|logged in|sign in|signin|token|unauthori[sz]ed|unauthenticated|not authenticated|authentication required|authentication failed|authenticate|auth required)\b|auth_required`,
	)
	subscriptionRequiredFailureMarkers = []string{
		"unable to verify your membership benefits",
		"ensure your membership is active",
		"subscription does not have access",
		"current plan supports only",
		"membership expired",
		"subscription required",
	}
	quotaOrRateLimitFailureMarkers = []string{
		"quota",
		"rate limit",
		"limit exceeded",
		"usage limit",
		"upgrade your plan to continue",
		"add a payment method to continue",
		"resource_exhausted",
		"too many requests",
		" 429",
	}
)

type visibleFailureProjection struct {
	eventID string
	content string
	payload map[string]any
}

func projectVisibleFailure(source canonical.EventSource, event activityshared.Event) (visibleFailureProjection, bool) {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return visibleFailureProjection{}, false
	}
	eventID := strings.TrimSpace(event.EventID)
	if eventID == "" {
		return visibleFailureProjection{}, false
	}
	phase := "turn"
	if event.Type == activityshared.EventSessionFailed {
		phase = "start"
	}
	detail := visibleFailureDetail(event)
	code := firstNonEmptyString(
		payloadString(event.Payload.Metadata, "code"),
		visibleFailureCode(detail),
	)
	// A Model Plan or Agent Extension can reject its own credential without
	// proving that the provider-native account needs login. Keep the upstream
	// detail, but do not emit the provider-login action code for that scope.
	if code == "auth_required" && !source.ProviderGlobalAuthEligible {
		code = "provider_error"
	}
	provider := firstNonEmptyString(string(event.Provider), source.Provider)
	content := visibleFailureContent(provider, phase, code)
	if payloadString(event.Payload.Metadata, "origin") == providerFailureOriginProvider && detail != "" {
		content = detail
	}
	payload := map[string]any{
		"kind":          visibleErrorKind,
		"severity":      visibleErrorSeverity,
		"phase":         phase,
		"code":          code,
		"provider":      provider,
		"sourceEventId": eventID,
		"retryable":     visibleFailureRetryable(code, detail),
		"content":       content,
		"text":          content,
	}
	if detail != "" {
		payload["detail"] = detail
	}
	for _, key := range []string{"providerCode", "origin", "authImpact", "authReason", "additionalDetails"} {
		if value := payloadString(event.Payload.Metadata, key); value != "" {
			payload[key] = value
		}
	}
	if status, ok := event.Payload.Metadata["httpStatus"]; ok {
		payload["httpStatus"] = status
	}
	if retryable, ok := event.Payload.Metadata["retryable"].(bool); ok {
		payload["retryable"] = retryable
	}
	return visibleFailureProjection{eventID: eventID, content: content, payload: payload}, true
}

func visibleFailureMessageUpdate(
	source canonical.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	turnID := strings.TrimSpace(event.Payload.TurnID)
	projection, ok := projectVisibleFailure(source, event)
	if strings.TrimSpace(sessionID) == "" || turnID == "" || !ok {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	payload := clonePayload(projection.payload)
	payload["source"] = "runtime"
	return agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID: strings.TrimSpace(sessionID),
		MessageID:      "visible-error:" + projection.eventID,
		Seq:            uint64(timestamp),
		TurnID:         turnID,
		Role:           string(activityshared.MessageRoleAssistant),
		Kind:           "text",
		Status:         messageStreamStateFailed,
		Semantics: &canonical.WorkspaceAgentMessageSemantics{
			UserVisibleAssistantResponse: true,
		},
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}, true
}

func visibleFailureSessionAuditUpdate(
	source canonical.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentSessionAuditUpdate, bool) {
	projection, ok := projectVisibleFailure(source, event)
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(event.Payload.TurnID) != "" || !ok {
		return agentsessionstore.WorkspaceAgentSessionAuditUpdate{}, false
	}
	payload := clonePayload(projection.payload)
	payload["source"] = "runtime"
	return agentsessionstore.WorkspaceAgentSessionAuditUpdate{
		AuditID:          "visible-error:" + projection.eventID,
		Role:             string(activityshared.MessageRoleAssistant),
		Content:          projection.content,
		Payload:          payload,
		OccurredAtUnixMS: timestamp,
	}, true
}

func shouldAppendVisibleFailure(events []activityshared.Event, event activityshared.Event) bool {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return false
	}
	scopeTurnID := strings.TrimSpace(event.Payload.TurnID)
	for _, candidate := range events {
		if candidate.Type != activityshared.EventMessageAppended && candidate.Type != activityshared.EventMessageCreated {
			continue
		}
		role := candidate.Payload.Role
		if role != "" && role != activityshared.MessageRoleAssistant {
			continue
		}
		if strings.TrimSpace(candidate.Payload.TurnID) != scopeTurnID {
			continue
		}
		if asString(candidate.Payload.Metadata["kind"]) == visibleErrorKind {
			return false
		}
		if asString(candidate.Payload.Metadata["streamState"]) == messageStreamStateFailed ||
			strings.TrimSpace(candidate.Payload.Status) == messageStreamStateFailed {
			return false
		}
	}
	return true
}

func visibleFailureDetail(event activityshared.Event) string {
	detail := firstNonEmptyString(
		payloadString(event.Payload.Metadata, "errorMessage"),
		payloadString(event.Payload.Metadata, "error"),
		activityshared.BestEffortErrorMessage(event.Payload),
	)
	if detail == "" {
		detail = firstNonEmptyString(
			payloadString(event.Payload.Metadata, "stopReason"),
			payloadString(event.Payload.Metadata, "reason"),
			strings.TrimSpace(event.Payload.Status),
		)
	}
	return sanitizeProviderFailureText(detail)
}

func cleanVisibleErrorText(value string) string {
	cleaned := ansiEscapePattern.ReplaceAllString(value, "")
	cleaned = strings.ReplaceAll(cleaned, "\r\n", "\n")
	cleaned = strings.ReplaceAll(cleaned, "\r", "\n")
	lines := strings.Split(cleaned, "\n")
	for index, line := range lines {
		lines[index] = strings.TrimRight(line, " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func limitVisibleErrorDetail(value string) string {
	const maxDetailLength = 4000
	if len(value) <= maxDetailLength {
		return value
	}
	return strings.TrimSpace(value[:maxDetailLength]) + "\n..."
}

func structuredProviderFailureCode(detail string) string {
	normalized := strings.ToLower(detail)
	for _, code := range []string{
		FailureCodeInsufficientCredits,
		FailureCodeModelNotAllowed,
		"no_biscuit_no_service",
	} {
		if strings.Contains(normalized, code) {
			return code
		}
	}
	return ""
}

func visibleFailureCode(detail string) string {
	normalized := strings.ToLower(detail)
	structuredCode := structuredProviderFailureCode(normalized)
	transportCode := structuredRuntimeTransportFailureCode(normalized)
	switch {
	case transportCode != "":
		return transportCode
	// Tutti billing failures are actionable account state, not a generic provider
	// crash. Prefer the structured code emitted by llm-token-usage, while also
	// recognizing the legacy 402 text already present in persisted conversations.
	case structuredCode == FailureCodeInsufficientCredits ||
		strings.Contains(normalized, "insufficient credits") ||
		strings.Contains(normalized, "insufficient balance") ||
		strings.Contains(normalized, "balance is insufficient") ||
		(strings.Contains(normalized, "402 payment required") &&
			(strings.Contains(normalized, "pre-deduct credits failed") ||
				strings.Contains(normalized, "pre_deduct_failed"))):
		return FailureCodeInsufficientCredits
	case containsFailureMarker(normalized, subscriptionRequiredFailureMarkers):
		return FailureCodeSubscriptionRequired
	case structuredCode == FailureCodeModelNotAllowed:
		return FailureCodeModelNotAllowed
	case structuredCode == "no_biscuit_no_service" &&
		(strings.Contains(normalized, "codex_apps") || strings.Contains(normalized, "mcp")):
		return "plugin_unavailable"
	case strings.Contains(normalized, "provider_empty_response"):
		return "provider_empty_response"
	// HTTP 402 is an account payment state even when the provider wraps the
	// response in text that also mentions credentials. Provider-specific
	// membership wording is handled above.
	case strings.Contains(normalized, "402 payment required"):
		return FailureCodeInsufficientCredits
	case strings.Contains(normalized, "concurrency limit exceeded"):
		return "provider_concurrency_limit"
	case containsFailureMarker(normalized, quotaOrRateLimitFailureMarkers):
		return FailureCodeQuotaOrRateLimit
	// A tool MCP server's OAuth failure (Notion/Figma/...) is distinct from
	// Codex's own login. The adapter now returns a typed startup error before the
	// generic lifecycle timeout, but keep this text classification for persisted
	// failures and older app-server artifacts.
	case detailIsMcpToolServerAuth(detail) && !strings.Contains(normalized, "process exited"):
		return "mcp_server_auth_required"
	case authFailurePattern.MatchString(detail) && !detailIsMcpToolServerAuth(detail):
		return "auth_required"
	// A run that can't find its CLI binary surfaces as an exec/ENOENT error. This
	// is the real "not installed / not on PATH" failure the env wizard can fix, so
	// it is split out of the generic process_exited bucket and checked before it.
	case codexErrorLooksLikeMissingBinary(normalized):
		return "cli_not_found"
	// The installed CLI/adapter is too old for this request — the wizard can
	// upgrade it.
	case strings.Contains(normalized, "requires a newer version") ||
		strings.Contains(normalized, "version is too old") ||
		strings.Contains(normalized, "version too old") ||
		strings.Contains(normalized, "unsupported version"):
		return "cli_version_unsupported"
	case strings.Contains(normalized, "session/set_config_option") &&
		strings.Contains(normalized, "timed out"):
		return "provider_config_timeout"
	case strings.Contains(normalized, "stream disconnected before completion") ||
		strings.Contains(normalized, "stream closed before response.completed"):
		return "provider_stream_disconnected"
	// Network failures (DNS/connection level) are an environment problem the
	// wizard can help diagnose. Checked after the stream/concurrency cases so a
	// stream-disconnect that merely mentions "network error" keeps its specific
	// code, but before request_timed_out so a low-level ETIMEDOUT reads as network.
	case codexErrorLooksLikeNetwork(normalized):
		return "network_error"
	case strings.Contains(normalized, "process exited") ||
		strings.Contains(normalized, "exited with code") ||
		strings.Contains(normalized, "exit status"):
		// A clean exit (code 0) or a signal-termination (128+N, e.g. 137 SIGKILL,
		// 143 SIGTERM) means the app-server was stopped/killed externally — the host
		// quit, the OS OOM-killed it, or (as seen in the field) an agent killed the
		// very Tutti process tree hosting its own session. That is the session being
		// interrupted, not Codex erroring out, so it reads calmer and is retryable.
		// A non-zero, non-signal exit (1/2/101…) is a genuine crash and stays
		// process_exited ("request failed").
		if codexExitLooksInterrupted(normalized) {
			return "session_interrupted"
		}
		return "process_exited"
	case strings.Contains(normalized, "deadline exceeded") ||
		strings.Contains(normalized, "timed out"):
		return "request_timed_out"
	case strings.Contains(normalized, "failed to connect") ||
		strings.Contains(normalized, "guest-agent") ||
		strings.Contains(normalized, "workspace is recovering") ||
		strings.Contains(normalized, "runtime"):
		return "runtime_unavailable"
	case strings.TrimSpace(detail) != "":
		return "provider_error"
	default:
		return "unknown"
	}
}

func containsFailureMarker(normalized string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func structuredRuntimeTransportFailureCode(normalized string) string {
	const marker = "error_code="
	index := strings.Index(normalized, marker)
	if index < 0 {
		return ""
	}
	remainder := normalized[index+len(marker):]
	end := 0
	for end < len(remainder) {
		character := remainder[end]
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' {
			break
		}
		end++
	}
	code := remainder[:end]
	if strings.HasPrefix(code, "egress_") || strings.HasPrefix(code, "provider_process_exit_") {
		return code
	}
	return ""
}

// ClassifyAccountFailure returns a stable account-state code without exposing
// a provider's raw error payload. Non-account runtime failures return an empty
// code so callers can retain their owning phase's failure classification.
func ClassifyAccountFailure(err error) string {
	if err == nil {
		return ""
	}
	code := visibleFailureCode(err.Error())
	switch code {
	case FailureCodeInsufficientCredits,
		FailureCodeModelNotAllowed,
		FailureCodeQuotaOrRateLimit,
		FailureCodeSubscriptionRequired:
		return code
	default:
		return ""
	}
}

// detailIsMcpToolServerAuth reports whether the failure is an MCP tool server's
// OAuth failure surfaced by codex's rust MCP client (rmcp) — e.g. a Notion or
// Figma MCP server whose access token expired. These markers never appear in
// codex's own login failures (which talk about chatgpt.com/openai, "not logged
// in", or "/login"), so keying on them safely separates "a tool server needs
// re-auth" from "codex needs to sign in".
func detailIsMcpToolServerAuth(detail string) bool {
	lower := strings.ToLower(detail)
	for _, marker := range []string{
		"rmcp::",
		"authrequirederror",
		"oauth-protected-resource",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// codexErrorLooksLikeMissingBinary reports whether the detail describes a CLI
// binary that could not be located/executed (as opposed to a binary that ran and
// exited non-zero).
func codexErrorLooksLikeMissingBinary(lower string) bool {
	return strings.Contains(lower, "command not found") ||
		strings.Contains(lower, "executable file not found") ||
		strings.Contains(lower, "fork/exec") && strings.Contains(lower, "no such file or directory") ||
		strings.Contains(lower, "spawn ") && strings.Contains(lower, "enoent")
}

// codexExitCodeFromDetail extracts the numeric process exit code from a
// "process exited" style detail (e.g. "...exited with code 137...",
// "exit status 1", "...exited with code -1..." — the negative form Go's
// os/exec reports for a signal-terminated process, see
// codexExitLooksInterrupted). It returns ok=false when no numeric code is
// present (a bare "process exited"), in which case the caller must not assume
// anything about it.
func codexExitCodeFromDetail(normalized string) (int, bool) {
	for _, marker := range []string{"exited with code ", "exit status "} {
		idx := strings.Index(normalized, marker)
		if idx < 0 {
			continue
		}
		rest := normalized[idx+len(marker):]
		end := 0
		if end < len(rest) && rest[end] == '-' {
			end++
		}
		digitsStart := end
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if end == digitsStart {
			continue
		}
		if code, err := strconv.Atoi(rest[:end]); err == nil {
			return code, true
		}
	}
	return 0, false
}

// codexExitLooksInterrupted reports whether a process-exit detail describes a
// clean shutdown (code 0), a signal-termination (128+N, signals 1..31), or a
// Go os/exec signal-termination (-1) rather than the provider process itself
// erroring out. Such exits mean the process was stopped or killed externally,
// so the session was interrupted — not "request failed". When no numeric code
// is present it returns false (stay with the generic process_exited
// classification rather than guess).
//
// The -1 case covers the claude-code sidecar's process wrapper
// (localProcessConnection in process_transport.go), which reports exit codes
// via Go's exec.ExitError.ExitCode(): per its docs, that returns -1 "if the
// process ... was terminated by a signal" — a different convention than the
// 128+N one Node-based app-servers (e.g. codex's) use for the same event. Seen
// in the field: tuttid's own graceful-shutdown path (CloseAllLiveSessions)
// calls Close() on a live claude-code session, which sends SIGTERM to the
// sidecar; the in-flight turn's reader observed the resulting exit and (before
// this fix) reported it as a hard "Claude Code request failed" instead of a
// calm, retryable interruption.
func codexExitLooksInterrupted(normalized string) bool {
	code, ok := codexExitCodeFromDetail(normalized)
	if !ok {
		return false
	}
	return code == 0 || code == -1 || (code >= 129 && code <= 159)
}

// codexErrorLooksLikeNetwork reports whether the detail describes a DNS or
// connection-level network failure.
func codexErrorLooksLikeNetwork(lower string) bool {
	for _, marker := range []string{
		"enotfound",
		"econnrefused",
		"econnreset",
		"etimedout",
		"getaddrinfo",
		"socket hang up",
		"dns",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func visibleFailureRetryable(code string, detail string) bool {
	if code == "runtime_unavailable" || code == "request_timed_out" || code == "network_error" ||
		code == "session_interrupted" || strings.HasPrefix(code, "egress_") ||
		strings.HasPrefix(code, "provider_process_exit_") || code == "mcp_server_auth_required" {
		return true
	}
	normalized := strings.ToLower(detail)
	return code == FailureCodeQuotaOrRateLimit && strings.Contains(normalized, "rate")
}

func visibleFailureContent(provider string, phase string, code string) string {
	name := visibleProviderName(provider)
	if phase == "start" {
		switch code {
		case FailureCodeInsufficientCredits:
			return fmt.Sprintf("%s could not start because the account has insufficient credits or balance.", name)
		case FailureCodeSubscriptionRequired:
			return fmt.Sprintf("%s could not start because the current account needs an eligible subscription.", name)
		case FailureCodeModelNotAllowed:
			return fmt.Sprintf("%s could not start because the selected model is unavailable for this account.", name)
		case "plugin_unavailable":
			return fmt.Sprintf("%s started without an optional integration that is currently unavailable.", name)
		case "mcp_server_auth_required":
			return fmt.Sprintf("%s could not start because an MCP integration needs to be reconnected. Re-authenticate it and try again.", name)
		case "auth_required":
			return fmt.Sprintf("%s needs authentication or configuration.", name)
		case "cli_not_found":
			return fmt.Sprintf("%s could not start because its CLI was not found. Set it up to continue.", name)
		case "cli_version_unsupported":
			return fmt.Sprintf("%s could not start because its installed version is unsupported. Upgrade to continue.", name)
		case "network_error":
			return fmt.Sprintf("%s could not start because the network is unreachable.", name)
		case "provider_concurrency_limit":
			return fmt.Sprintf("%s could not start because too many requests are already running for this user. Try again after another task finishes.", name)
		case "provider_config_timeout":
			return fmt.Sprintf("%s could not apply session settings before startup timed out. Try again in a moment.", name)
		case "provider_stream_disconnected":
			return fmt.Sprintf("%s could not start because the response was interrupted. Try again in a moment.", name)
		case "session_interrupted":
			return fmt.Sprintf("%s stopped unexpectedly before it finished starting. Try again.", name)
		case "request_timed_out":
			return fmt.Sprintf("%s could not start before the request timed out.", name)
		case FailureCodeQuotaOrRateLimit:
			return fmt.Sprintf("%s could not start because a quota or rate limit was reached.", name)
		case "runtime_unavailable":
			return fmt.Sprintf("%s could not start because the runtime is unavailable.", name)
		default:
			return fmt.Sprintf("%s failed to start.", name)
		}
	}
	switch code {
	case FailureCodeInsufficientCredits:
		return fmt.Sprintf("%s could not continue because the account has insufficient credits or balance.", name)
	case FailureCodeSubscriptionRequired:
		return fmt.Sprintf("%s requires an eligible subscription for this request.", name)
	case FailureCodeModelNotAllowed:
		return fmt.Sprintf("%s could not use the selected model. Choose another model and try again.", name)
	case "plugin_unavailable":
		return fmt.Sprintf("%s could not use an optional integration that is currently unavailable.", name)
	case "mcp_server_auth_required":
		return fmt.Sprintf("%s could not continue because an MCP integration needs to be reconnected. Re-authenticate it and try again.", name)
	case "auth_required":
		return fmt.Sprintf("%s needs authentication or configuration.", name)
	case "cli_not_found":
		return fmt.Sprintf("%s could not run because its CLI was not found. Set it up to continue.", name)
	case "cli_version_unsupported":
		return fmt.Sprintf("%s could not run because its installed version is unsupported. Upgrade to continue.", name)
	case "network_error":
		return fmt.Sprintf("%s could not reach the network to complete this request.", name)
	case "provider_concurrency_limit":
		return fmt.Sprintf("%s is handling too many requests for this user. Try again after another task finishes.", name)
	case "provider_config_timeout":
		return fmt.Sprintf("%s could not apply session settings before the request timed out. Try again in a moment.", name)
	case "provider_stream_disconnected":
		return fmt.Sprintf("%s response was interrupted before it completed. Try again in a moment.", name)
	case "provider_empty_response":
		return fmt.Sprintf("%s returned no response. Check the provider settings or try again.", name)
	case "session_interrupted":
		return fmt.Sprintf("%s stopped unexpectedly before it finished responding. Try again.", name)
	case "request_timed_out":
		return fmt.Sprintf("%s request timed out.", name)
	case FailureCodeQuotaOrRateLimit:
		return fmt.Sprintf("%s request failed because a quota or rate limit was reached.", name)
	default:
		return fmt.Sprintf("%s request failed.", name)
	}
}

func visibleProviderName(provider string) string {
	if descriptor, ok := providerregistry.Find(provider); ok {
		return descriptor.Identity.DisplayName
	}
	return "Agent"
}
