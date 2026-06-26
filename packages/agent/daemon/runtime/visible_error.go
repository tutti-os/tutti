package agentruntime

import (
	"fmt"
	"regexp"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

const (
	visibleErrorKind     = "agent_visible_error"
	visibleErrorSeverity = "error"
)

var ansiEscapePattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

func visibleFailureTimelineItem(
	roomID string,
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentTimelineItem, bool) {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return agentsessionstore.WorkspaceAgentTimelineItem{}, false
	}
	eventID := strings.TrimSpace(event.EventID)
	if strings.TrimSpace(sessionID) == "" || eventID == "" {
		return agentsessionstore.WorkspaceAgentTimelineItem{}, false
	}
	phase := "turn"
	if event.Type == activityshared.EventSessionFailed {
		phase = "start"
	}
	detail := visibleFailureDetail(event)
	code := visibleFailureCode(detail)
	provider := firstNonEmptyString(string(event.Provider), source.Provider)
	content := visibleFailureContent(provider, phase, code)
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
	return agentsessionstore.WorkspaceAgentTimelineItem{
		RoomID:           strings.TrimSpace(roomID),
		AgentSessionID:   strings.TrimSpace(sessionID),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		EventSource:      "runtime",
		EventID:          "visible-error:" + eventID,
		ActorType:        "agent",
		ActorID:          provider,
		OccurredAtUnixMS: timestamp,
		CreatedAtUnixMS:  timestamp,
		Role:             string(activityshared.MessageRoleAssistant),
		ItemType:         "message.assistant",
		Status:           messageStreamStateFailed,
		Payload:          payload,
	}, true
}

func visibleFailureMessageUpdate(
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentMessageUpdate, bool) {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	eventID := strings.TrimSpace(event.EventID)
	if strings.TrimSpace(sessionID) == "" || eventID == "" {
		return agentsessionstore.WorkspaceAgentMessageUpdate{}, false
	}
	phase := "turn"
	if event.Type == activityshared.EventSessionFailed {
		phase = "start"
	}
	detail := visibleFailureDetail(event)
	code := visibleFailureCode(detail)
	provider := firstNonEmptyString(string(event.Provider), source.Provider)
	content := visibleFailureContent(provider, phase, code)
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
		"source":        "runtime",
	}
	if detail != "" {
		payload["detail"] = detail
	}
	return agentsessionstore.WorkspaceAgentMessageUpdate{
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        "visible-error:" + eventID,
		Seq:              uint64(timestamp),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             string(activityshared.MessageRoleAssistant),
		Kind:             "text",
		Status:           messageStreamStateFailed,
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
	detail := activityshared.BestEffortErrorMessage(event.Payload)
	if detail == "" {
		detail = firstNonEmptyString(
			payloadString(event.Payload.Metadata, "stopReason"),
			payloadString(event.Payload.Metadata, "reason"),
			strings.TrimSpace(event.Payload.Status),
		)
	}
	return limitVisibleErrorDetail(cleanVisibleErrorText(detail))
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

func visibleFailureCode(detail string) string {
	normalized := strings.ToLower(detail)
	switch {
	case strings.Contains(normalized, "auth") ||
		strings.Contains(normalized, "api key") ||
		strings.Contains(normalized, "credential") ||
		strings.Contains(normalized, "login") ||
		strings.Contains(normalized, "token"):
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
	case strings.Contains(normalized, "concurrency limit exceeded"):
		return "provider_concurrency_limit"
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
	case strings.Contains(normalized, "quota") ||
		strings.Contains(normalized, "rate limit") ||
		strings.Contains(normalized, "limit exceeded") ||
		strings.Contains(normalized, "resource_exhausted") ||
		strings.Contains(normalized, "too many requests") ||
		strings.Contains(normalized, " 429"):
		return "quota_or_rate_limit"
	case strings.Contains(normalized, "process exited") ||
		strings.Contains(normalized, "exited with code") ||
		strings.Contains(normalized, "exit status"):
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

// codexErrorLooksLikeMissingBinary reports whether the detail describes a CLI
// binary that could not be located/executed (as opposed to a binary that ran and
// exited non-zero).
func codexErrorLooksLikeMissingBinary(lower string) bool {
	for _, marker := range []string{
		"no such file or directory",
		"fork/exec",
		"command not found",
		"executable file not found",
		"enoent",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
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
	if code == "runtime_unavailable" || code == "request_timed_out" || code == "network_error" {
		return true
	}
	normalized := strings.ToLower(detail)
	return code == "quota_or_rate_limit" && strings.Contains(normalized, "rate")
}

func visibleFailureContent(provider string, phase string, code string) string {
	name := visibleProviderName(provider)
	if phase == "start" {
		switch code {
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
		case "request_timed_out":
			return fmt.Sprintf("%s could not start before the request timed out.", name)
		case "runtime_unavailable":
			return fmt.Sprintf("%s could not start because the runtime is unavailable.", name)
		default:
			return fmt.Sprintf("%s failed to start.", name)
		}
	}
	switch code {
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
	case "request_timed_out":
		return fmt.Sprintf("%s request timed out.", name)
	case "quota_or_rate_limit":
		return fmt.Sprintf("%s request failed because a quota or rate limit was reached.", name)
	default:
		return fmt.Sprintf("%s request failed.", name)
	}
}

func visibleProviderName(provider string) string {
	switch strings.TrimSpace(provider) {
	case ProviderClaudeCode:
		return "Claude Code"
	case ProviderCodex:
		return "Codex"
	case ProviderNexight:
		return "Nexight"
	case ProviderGemini:
		return "Gemini"
	case ProviderHermes:
		return "Hermes"
	case ProviderOpenClaw:
		return "OpenClaw"
	default:
		return "Agent"
	}
}
