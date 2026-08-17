package agentruntime

import "errors"

const (
	AppErrorProviderSessionNotFound           = "agent.provider_session_not_found"
	AppErrorProviderAcceptanceMissingIdentity = "provider_acceptance_missing_identity"
	AppErrorProcessCleanupPending             = "agent.process_cleanup_pending"
	AppErrorResumeSessionNotLocal             = "agent.resume_session_not_local"
)

var (
	// ErrProviderStartTimeout is attached only by a provider adapter that has
	// reached its provider-readiness boundary and observed the start deadline
	// before a runtime Session was established. Callers must not infer this
	// verdict from an arbitrary context deadline.
	ErrProviderStartTimeout          = errors.New("agent provider start timed out")
	ErrSessionDisconnected           = errors.New("agent session is not connected")
	ErrInteractiveRequestNotLive     = errors.New("interactive request is no longer live")
	ErrInteractiveAlreadyAnswered    = errors.New("interactive request has already been answered")
	ErrSessionNoActiveTurn           = errors.New("agent session has no active turn")
	ErrCancelTargetMismatch          = errors.New("agent cancellation target is no longer active")
	ErrActiveTurnTargetRequired      = errors.New("active-turn guidance requires an exact target turn")
	ErrActiveTurnTargetMismatch      = errors.New("active-turn guidance target is no longer active")
	ErrActiveTurnGuidanceUnsupported = errors.New("agent provider does not support active-turn guidance")
	ErrMCPHTTPUnsupported            = errors.New("agent provider does not support HTTP MCP servers")
)

type AppError struct {
	Code         string
	Message      string
	DebugMessage string
	Cause        error
}

func (e *AppError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return "agent session error"
}

func (e *AppError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func AppErrorCode(err error) string {
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr == nil {
		return ""
	}
	return appErr.Code
}

func AppErrorDebugMessage(err error) string {
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr == nil {
		return ""
	}
	return appErr.DebugMessage
}
