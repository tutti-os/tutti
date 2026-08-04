package canonical

import "testing"

func TestEditRetryReasonVocabularyIsClosed(t *testing.T) {
	reasons := []EditRetryReasonCode{
		EditRetryReasonRetryWait,
		EditRetryReasonRetryBudgetExhausted,
		EditRetryReasonLocalStateInconsistent,
		EditRetryReasonProviderUnsupported,
		EditRetryReasonRolloutDisabled,
		EditRetryReasonTurnNotFound,
		EditRetryReasonTurnNotLatest,
		EditRetryReasonTurnNotSettled,
		EditRetryReasonHistoryRevisionConflict,
		EditRetryReasonOperationConflict,
		EditRetryReasonRecoveryRequired,
		EditRetryReasonProviderRejected,
		EditRetryReasonProviderOutcomeUnknown,
		EditRetryReasonReplacementNotProvenAbsent,
	}
	for _, reason := range reasons {
		if err := reason.Validate(); err != nil {
			t.Fatalf("%q should be valid: %v", reason, err)
		}
	}
	if err := EditRetryReasonCode("unknown").Validate(); err == nil {
		t.Fatal("unknown edit-retry reason should be rejected")
	}
}
