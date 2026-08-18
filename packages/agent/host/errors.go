package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

var (
	ErrInvalidArgument               = errors.New("invalid agent session request")
	ErrRailPlacementConflict         = errors.New("agent session rail placement conflicts with canonical state")
	ErrSessionNotFound               = errors.New("workspace agent session not found")
	ErrTurnNotFound                  = errors.New("workspace agent turn not found")
	ErrProviderSessionNotEstablished = errors.New("provider session was never established")
	ErrSubmitDeliveryUnknown         = errors.New("agent submit delivery is still being confirmed")
	ErrActiveTurnTargetRequired      = errors.New("active-turn guidance requires an exact target turn")
	ErrActiveTurnTargetMismatch      = errors.New("active-turn guidance target is no longer active")
	ErrSessionTitleTooLong           = errors.New("agent session title is too long")
	ErrRuntimeSessionDisconnected    = errors.New("agent runtime session is disconnected")
	// ErrRuntimeCancelDeliveryUnconfirmed means the runtime received an exact
	// cancel request but could not confirm that the requested provider turn was
	// the one it stopped. Host keeps the durable cancel operation retryable and
	// waits for canonical terminal evidence instead of fabricating a terminal.
	ErrRuntimeCancelDeliveryUnconfirmed   = errors.New("agent runtime cancellation delivery is unconfirmed")
	ErrRuntimeSessionActive               = errors.New("agent runtime session has an active turn")
	ErrRuntimeSessionReprepareUnavailable = errors.New("agent runtime session reprepare is unavailable")
	ErrRuntimeSessionPublishUnavailable   = errors.New("agent runtime session initialization publication is unavailable")
	ErrRuntimeRailPlacementUnavailable    = errors.New("agent runtime rail placement resolution is unavailable")
	ErrWorkspaceDisconnectUnavailable     = errors.New("agent workspace runtime disconnect is unavailable")
	ErrInteractionNotFound                = errors.New("agent interaction was not found")
	ErrRuntimeOperationInProgress         = errors.New("agent runtime operation is already in progress")
	ErrRuntimeOperationFailed             = errors.New("agent runtime operation failed")
	ErrRuntimeOperationIdentityMismatch   = errors.New("agent runtime operation identity is inconsistent")
	ErrGoalConsumerUnavailable            = errors.New("agent goal reconcile consumer is unavailable")
	ErrGoalGenerationFenceUnavailable     = errors.New("agent goal generation fence consumer is unavailable")
	ErrRuntimeSessionLivenessUnavailable  = errors.New("agent runtime session liveness is unavailable")
	ErrSessionForkUnsupported             = errors.New("agent session through-turn fork is unsupported")
	ErrSessionForkInProgress              = errors.New("agent session fork is in progress")
	ErrSessionForkDeliveryUnknown         = errors.New("agent session fork provider delivery is unknown")
	ErrSessionForkFailed                  = errors.New("agent session fork failed")
	ErrEditRetryNotEligible               = errors.New("only the latest completed user turn can be edited and retried")
	ErrEditRetryHistoryConflict           = errors.New("agent effective history revision changed")
	ErrRuntimeHistoryUnsupported          = errors.New("agent provider does not support effective history mutation")
	ErrEditRetryInProgress                = errors.New("agent history edit is still being confirmed")
	ErrEditRetryResendPending             = errors.New("agent history was rolled back but the edited turn still needs to be resent")
	ErrEditRetryRecoveryRequired          = errors.New("agent provider history diverged and requires explicit recovery")
	ErrDeletedSessionNotFound             = storesqlite.ErrDeletedSessionNotFound
	ErrDeletedSessionNotRestorable        = storesqlite.ErrDeletedSessionNotRestorable
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

const ProviderErrorCodeStartTimeout = "provider_start_timeout"

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

// NewProviderStartTimeoutError preserves the narrow runtime verdict that a
// provider adapter timed out while starting, before a runtime Session was
// established. Unlike an arbitrary deadline, this verdict is safe to expose as
// a ProviderError because the runtime owner has already identified the failed
// lifecycle stage.
func NewProviderStartTimeoutError(message, debugMessage string, cause error) error {
	if cause == nil {
		return nil
	}
	return &ProviderError{
		Code:         ProviderErrorCodeStartTimeout,
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

func terminalFailureCode(err error) string {
	var providerErr *ProviderError
	if errors.As(err, &providerErr) && providerErr != nil {
		return strings.TrimSpace(providerErr.Code)
	}
	return ""
}

func guidanceTargetFailureCode(err error) string {
	switch {
	case errors.Is(err, ErrActiveTurnTargetRequired):
		return "active_turn_target_required"
	case errors.Is(err, ErrActiveTurnTargetMismatch):
		return "active_turn_target_mismatch"
	}
	if code := terminalFailureCode(err); code != "" {
		return code
	}
	return "guidance_target"
}
