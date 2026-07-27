package agenthost

import (
	"context"
	"errors"
)

var (
	ErrInvalidArgument                  = errors.New("invalid agent session request")
	ErrRailPlacementConflict            = errors.New("agent session rail placement conflicts with canonical state")
	ErrSessionNotFound                  = errors.New("workspace agent session not found")
	ErrSubmitDeliveryUnknown            = errors.New("agent submit delivery is still being confirmed")
	ErrSessionTitleTooLong              = errors.New("agent session title is too long")
	ErrRuntimeSessionDisconnected       = errors.New("agent runtime session is disconnected")
	ErrInteractionNotFound              = errors.New("agent interaction was not found")
	ErrRuntimeOperationInProgress       = errors.New("agent runtime operation is already in progress")
	ErrRuntimeOperationFailed           = errors.New("agent runtime operation failed")
	ErrRuntimeOperationIdentityMismatch = errors.New("agent runtime operation identity is inconsistent")
	ErrGoalConsumerUnavailable          = errors.New("agent goal reconcile consumer is unavailable")
)

// ProviderError preserves a provider-owned failure across the runtime adapter
// and Host boundary. Consumers may use errors.As to distinguish an explicit
// downstream failure from preparation, canonical-store, timeout, and other
// Host-local errors without parsing error text or depending on provider codes.
//
// Code and diagnostic text remain local observations. They are not a stable
// cross-service taxonomy and must not be persisted as coordination metadata.
type ProviderError struct {
	Code         string
	Message      string
	DebugMessage string
	Cause        error
}

// NewProviderError converts an adapter's structured provider observation into
// the Host contract. Cancellation and deadline errors remain unclassified
// because their delivery result is unknown and consumers must keep them
// recoverable.
func NewProviderError(code, message, debugMessage string, cause error) error {
	if cause == nil {
		return nil
	}
	if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) {
		return cause
	}
	return &ProviderError{
		Code:         code,
		Message:      message,
		DebugMessage: debugMessage,
		Cause:        cause,
	}
}

func (e *ProviderError) Error() string {
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
	return "agent provider error"
}

func (e *ProviderError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}
