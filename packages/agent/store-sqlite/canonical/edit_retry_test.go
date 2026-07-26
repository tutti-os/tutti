package canonical

import "testing"

func TestEditRetryReasonVocabularyIsClosed(t *testing.T) {
	reasons := []EditRetryReasonCode{
		EditRetryReasonProviderUnsupported,
		EditRetryReasonTurnNotFound,
		EditRetryReasonTurnNotLatest,
		EditRetryReasonTurnNotSettled,
		EditRetryReasonHistoryRevisionConflict,
		EditRetryReasonOperationConflict,
		EditRetryReasonRecoveryRequired,
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
