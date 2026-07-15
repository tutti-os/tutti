package agentruntime

import (
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Cursor's ACP agent surfaces transient upstream failures (its HTTP/2 stream
// to the Cursor backend getting cut) as a plain trailing text chunk such as
//
//	Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)
//
// followed by a NORMAL session/prompt result — protocol-wise the turn looks
// successful, so the conversation silently stops mid-task and the user has to
// prod the agent to continue. cursor-agent classifies these as retriable
// itself; when a provider opts in (config.autoContinueRetriableTurnError) the
// adapter resumes the turn with a synthetic continue prompt a bounded number
// of times, and marks the turn failed once the retries are also cut short.
const acpAutoContinueMaxAttempts = 2

var acpRetriableTurnTailPrefixes = []string{
	"Error: RetriableError:",
	"Error: ConnectError:",
}

// acpRetriableTurnTailError returns the transient-error line when the turn's
// trailing assistant text ends with one.
func acpRetriableTurnTailError(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	lines := strings.Split(trimmed, "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	for _, prefix := range acpRetriableTurnTailPrefixes {
		if strings.HasPrefix(last, prefix) {
			return last, true
		}
	}
	return "", false
}

// acpStopReasonEndsTurnNormally reports whether the stop reason would take
// Exec's default (turn-completed) branch — the only state worth auto-continuing
// from. Canceled and hard-failure stop reasons keep their existing handling.
func acpStopReasonEndsTurnNormally(stopReason string) bool {
	switch stopReason {
	case "canceled", "refusal", "max_tokens", "max_turn_requests":
		return false
	default:
		return true
	}
}

// acpAutoContinueHasUsefulProgress reports whether the failed attempt produced
// anything worth "continuing": assistant text besides the retriable error
// tail, or at least one tool call. Zero-progress failures (e.g. TLS drop right
// after the user said hello) must not use mid-task continue wording — that
// prompts the model to invent interrupted prior work.
func acpAutoContinueHasUsefulProgress(assistantText string, toolCallCount int) bool {
	if toolCallCount > 0 {
		return true
	}
	trimmed := strings.TrimSpace(assistantText)
	if trimmed == "" {
		return false
	}
	if errLine, ok := acpRetriableTurnTailError(trimmed); ok {
		withoutTail := strings.TrimSpace(strings.TrimSuffix(trimmed, errLine))
		return withoutTail != ""
	}
	return true
}

const (
	acpAutoContinueMidTaskPrompt      = "The previous response was interrupted by a transient network error. Continue exactly where you left off; do not repeat work that already completed."
	acpAutoContinueZeroProgressPrompt = "A transient network error aborted your reply before any useful output. Answer the user's most recent message normally. Do not invent interrupted prior work, recover transcripts, or continue a task that never started."
)

// acpAutoContinuePromptContent is the synthetic prompt that resumes a turn cut
// short by a transient network error. It is deliberately not emitted as a
// user message: the provider session retains the full prior context.
//
// hasUsefulProgress selects wording: mid-task continue vs "answer the last
// user message" for attempts that died before producing useful output.
func acpAutoContinuePromptContent(hasUsefulProgress bool) []map[string]any {
	text := acpAutoContinueZeroProgressPrompt
	if hasUsefulProgress {
		text = acpAutoContinueMidTaskPrompt
	}
	return []map[string]any{{
		"type": "text",
		"text": text,
	}}
}

// acpAutoContinueNoticeEvent renders the in-transcript banner that separates
// the error tail from the auto-continued output, so the retry is visible
// instead of the agent appearing to stutter.
func acpAutoContinueNoticeEvent(session Session, turnID string, errLine string, attempt int) (activityshared.Event, bool) {
	return acpSystemNoticeEvent(session, turnID, map[string]any{
		"kind":       "agent_system_notice",
		"noticeKind": "transport_retry",
		"severity":   "warning",
		"title":      fmt.Sprintf("Connection to the agent backend dropped; continuing automatically (%d/%d).", attempt, acpAutoContinueMaxAttempts),
		"detail":     errLine,
		"retryable":  true,
	}, "system_notice", true)
}
