package canonical

import "fmt"

// EditRetryReasonCode is the closed, provider-neutral reason vocabulary stored
// with durable edit-retry operations and projected through Host consumers.
type EditRetryReasonCode string

const (
	// EditRetryReasonRetryWait means automatic recovery is deferred until the
	// durable retry timestamp. It must be paired with Automatic=true and a
	// positive next-attempt time at the Host projection boundary.
	EditRetryReasonRetryWait EditRetryReasonCode = "retry_wait"
	// EditRetryReasonRetryBudgetExhausted means automatic recovery has stopped
	// at its attempt or age budget. It is a session-local blocked state and has
	// no automatic retry timestamp.
	EditRetryReasonRetryBudgetExhausted EditRetryReasonCode = "retry_budget_exhausted"
	// EditRetryReasonLocalStateInconsistent means operation, fence, or history
	// facts cannot prove a safe local transition. It is never a daemon-wide
	// failure and exposes only Host-derived safe recovery actions.
	EditRetryReasonLocalStateInconsistent     EditRetryReasonCode = "local_state_inconsistent"
	EditRetryReasonProviderUnsupported        EditRetryReasonCode = "provider_unsupported"
	EditRetryReasonTurnNotFound               EditRetryReasonCode = "turn_not_found"
	EditRetryReasonTurnNotLatest              EditRetryReasonCode = "turn_not_latest"
	EditRetryReasonTurnNotSettled             EditRetryReasonCode = "turn_not_settled"
	EditRetryReasonHistoryRevisionConflict    EditRetryReasonCode = "history_revision_conflict"
	EditRetryReasonOperationConflict          EditRetryReasonCode = "operation_conflict"
	EditRetryReasonRecoveryRequired           EditRetryReasonCode = "recovery_required"
	EditRetryReasonProviderOutcomeUnknown     EditRetryReasonCode = "provider_outcome_unknown"
	EditRetryReasonReplacementNotProvenAbsent EditRetryReasonCode = "replacement_not_proven_absent"
	EditRetryReasonRolloutDisabled            EditRetryReasonCode = "rollout_disabled"
)

func (reason EditRetryReasonCode) Validate() error {
	switch reason {
	case EditRetryReasonRetryWait,
		EditRetryReasonRetryBudgetExhausted,
		EditRetryReasonLocalStateInconsistent,
		EditRetryReasonProviderUnsupported,
		EditRetryReasonTurnNotFound,
		EditRetryReasonTurnNotLatest,
		EditRetryReasonTurnNotSettled,
		EditRetryReasonHistoryRevisionConflict,
		EditRetryReasonOperationConflict,
		EditRetryReasonRecoveryRequired,
		EditRetryReasonProviderOutcomeUnknown,
		EditRetryReasonReplacementNotProvenAbsent,
		EditRetryReasonRolloutDisabled:
		return nil
	default:
		return fmt.Errorf("unknown edit retry reason code %q", reason)
	}
}
