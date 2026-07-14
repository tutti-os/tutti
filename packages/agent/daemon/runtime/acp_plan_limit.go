package agentruntime

import (
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Cursor (and similar ACP agents) report account plan / payment gates with
// fixed user-facing copy. cursor-agent often soft-surfaces the first hit as an
// assistant text chunk + end_turn; later attempts may instead fail the ACP
// session/prompt call with the same text. Treat those as calm plan-limit
// notices rather than scary turn-failed error cards.
var providerPlanLimitPhrases = []string{
	"upgrade your plan to continue",
	"add a payment method to continue",
}

func acpProviderPlanLimitMessage(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	candidates := make([]string, 0, 3)
	var callErr *acpCallError
	if errors.As(err, &callErr) {
		if message := strings.TrimSpace(callErr.Err.Message); message != "" {
			candidates = append(candidates, message)
		}
		data := acpErrorDataPayload(callErr.Err.Data)
		if message := strings.TrimSpace(asString(data["message"])); message != "" {
			candidates = append(candidates, message)
		}
	}
	candidates = append(candidates, err.Error())
	for _, candidate := range candidates {
		if message, ok := providerPlanLimitUserMessage(candidate); ok {
			return message, true
		}
	}
	return "", false
}

func providerPlanLimitUserMessage(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	normalized := strings.ToLower(trimmed)
	for _, phrase := range providerPlanLimitPhrases {
		if !strings.Contains(normalized, phrase) {
			continue
		}
		// Prefer the canonical phrase when the provider wraps it.
		for _, line := range strings.Split(trimmed, "\n") {
			line = strings.TrimSpace(line)
			if strings.Contains(strings.ToLower(line), phrase) {
				return line, true
			}
		}
		return trimmed, true
	}
	return "", false
}

func acpPlanLimitNoticeEvent(session Session, turnID string, message string) (activityshared.Event, bool) {
	return acpSystemNoticeEvent(session, turnID, map[string]any{
		"kind":       "agent_system_notice",
		"noticeKind": "warning",
		"severity":   "warning",
		"title":      message,
		"detail":     message,
		"code":       "quota_or_rate_limit",
		"retryable":  false,
	}, "system_notice", true)
}
