package canonical

import "fmt"

// EditRetryReasonCode is the closed, provider-neutral reason vocabulary stored
// with durable edit-retry operations and projected through Host consumers.
type EditRetryReasonCode string

const (
	EditRetryReasonProviderUnsupported        EditRetryReasonCode = "provider_unsupported"
	EditRetryReasonTurnNotFound               EditRetryReasonCode = "turn_not_found"
	EditRetryReasonTurnNotLatest              EditRetryReasonCode = "turn_not_latest"
	EditRetryReasonTurnNotSettled             EditRetryReasonCode = "turn_not_settled"
	EditRetryReasonHistoryRevisionConflict    EditRetryReasonCode = "history_revision_conflict"
	EditRetryReasonOperationConflict          EditRetryReasonCode = "operation_conflict"
	EditRetryReasonRecoveryRequired           EditRetryReasonCode = "recovery_required"
	EditRetryReasonProviderOutcomeUnknown     EditRetryReasonCode = "provider_outcome_unknown"
	EditRetryReasonReplacementNotProvenAbsent EditRetryReasonCode = "replacement_not_proven_absent"
)

func (reason EditRetryReasonCode) Validate() error {
	switch reason {
	case EditRetryReasonProviderUnsupported,
		EditRetryReasonTurnNotFound,
		EditRetryReasonTurnNotLatest,
		EditRetryReasonTurnNotSettled,
		EditRetryReasonHistoryRevisionConflict,
		EditRetryReasonOperationConflict,
		EditRetryReasonRecoveryRequired,
		EditRetryReasonProviderOutcomeUnknown,
		EditRetryReasonReplacementNotProvenAbsent:
		return nil
	default:
		return fmt.Errorf("unknown edit retry reason code %q", reason)
	}
}
