package agentruntime

import (
	"errors"
	"fmt"
	"strings"
)

func classifyACPResumeError(session Session, method string, err error) error {
	if err == nil {
		return nil
	}
	var callErr *acpCallError
	if !errors.As(err, &callErr) || callErr == nil {
		return err
	}
	if !isACPProviderSessionNotFound(method, callErr) {
		return err
	}
	return &AppError{
		Code:    AppErrorProviderSessionNotFound,
		Message: "Agent provider session could not be restored.",
		DebugMessage: fmt.Sprintf(
			"ACP restore target missing: room_id=%s provider=%s agent_session_id=%s provider_session_id=%s method=%s acp_error=%s",
			strings.TrimSpace(session.RoomID),
			strings.TrimSpace(session.Provider),
			strings.TrimSpace(session.AgentSessionID),
			strings.TrimSpace(session.ProviderSessionID),
			strings.TrimSpace(method),
			acpErrorSummary(&callErr.Err),
		),
		Cause: err,
	}
}

func unsupportedACPResumeError(session Session) error {
	return resumeSessionNotLocalError(session, "reason=resume/load unsupported")
}

func missingProviderSessionResumeError(session Session) error {
	return resumeSessionNotLocalError(session, "reason=provider_session_id missing")
}

func resumeSessionNotLocalError(session Session, reason string) error {
	return &AppError{
		Code:    AppErrorResumeSessionNotLocal,
		Message: "Agent provider session could not be restored.",
		DebugMessage: fmt.Sprintf(
			"ACP restore unavailable locally: room_id=%s provider=%s agent_session_id=%s provider_session_id=%s %s",
			strings.TrimSpace(session.RoomID),
			strings.TrimSpace(session.Provider),
			strings.TrimSpace(session.AgentSessionID),
			strings.TrimSpace(session.ProviderSessionID),
			strings.TrimSpace(reason),
		),
	}
}

func isACPProviderSessionNotFound(method string, callErr *acpCallError) bool {
	if callErr == nil {
		return false
	}
	switch strings.TrimSpace(method) {
	case acpMethodLoadSession, acpMethodResume, appServerMethodThreadResume:
	default:
		return false
	}
	message := strings.TrimSpace(callErr.Err.Message)
	lower := strings.ToLower(message)
	// Codex app server reports a missing rollout file (conversation imported from
	// another device, rollout pruned by retention, ...) as -32600 "no rollout
	// found for thread id …". JSON-RPC -32600 is the generic "invalid request"
	// code, so key off the distinctive message rather than the code here.
	if strings.Contains(lower, "no rollout found") {
		return true
	}
	// Standard ACP session/load and session/resume report a vanished provider
	// session as -32002 "Resource not found".
	if callErr.Err.Code == -32002 {
		return strings.EqualFold(message, "Resource not found") ||
			strings.HasPrefix(lower, "resource not found:")
	}
	return false
}
