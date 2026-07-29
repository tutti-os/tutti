package agenthost

import (
	"errors"
	"testing"
)

func TestRuntimeDispatchDispositionContractValues(t *testing.T) {
	tests := []struct {
		name string
		got  RuntimeDispatchDisposition
		want string
	}{
		{name: "applied", got: RuntimeDispatchDispositionApplied, want: "applied"},
		{name: "rejected", got: RuntimeDispatchDispositionRejected, want: "rejected"},
		{name: "not dispatched", got: RuntimeDispatchDispositionNotDispatched, want: "not_dispatched"},
		{name: "outcome unknown", got: RuntimeDispatchDispositionOutcomeUnknown, want: "outcome_unknown"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := string(test.got); got != test.want {
				t.Fatalf("RuntimeDispatchDisposition = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRuntimeAcceptanceSourceContractValues(t *testing.T) {
	tests := []struct {
		name string
		got  RuntimeAcceptanceSource
		want string
	}{
		{name: "turn start response", got: RuntimeAcceptanceSourceTurnStartResponse, want: "turn_start_response"},
		{name: "history read", got: RuntimeAcceptanceSourceHistoryRead, want: "history_read"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := string(test.got); got != test.want {
				t.Fatalf("RuntimeAcceptanceSource = %q, want %q", got, test.want)
			}
		})
	}
}

func TestEditRetryContractValues(t *testing.T) {
	actions := map[EditRetryRecoveryAction]string{
		EditRetryRecoveryActionReconcile:        "reconcile",
		EditRetryRecoveryActionRetryReplacement: "retry_replacement",
	}
	for got, want := range actions {
		if string(got) != want {
			t.Fatalf("EditRetryRecoveryAction = %q, want %q", got, want)
		}
	}

	states := map[EditRetryState]string{
		EditRetryStatePrepared:         "prepared",
		EditRetryStateRollingBack:      "rolling_back",
		EditRetryStateResendPending:    "resend_pending",
		EditRetryStateRecoveryRequired: "recovery_required",
		EditRetryStateCompleted:        "completed",
	}
	for got, want := range states {
		if string(got) != want {
			t.Fatalf("EditRetryState = %q, want %q", got, want)
		}
	}

	reasons := map[EditRetryReasonCode]string{
		EditRetryReasonCodeProviderUnsupported:        "provider_unsupported",
		EditRetryReasonCodeTurnNotFound:               "turn_not_found",
		EditRetryReasonCodeTurnNotLatest:              "turn_not_latest",
		EditRetryReasonCodeTurnNotSettled:             "turn_not_settled",
		EditRetryReasonCodeHistoryRevisionConflict:    "history_revision_conflict",
		EditRetryReasonCodeOperationConflict:          "operation_conflict",
		EditRetryReasonCodeRecoveryRequired:           "recovery_required",
		EditRetryReasonCodeProviderOutcomeUnknown:     "provider_outcome_unknown",
		EditRetryReasonCodeReplacementNotProvenAbsent: "replacement_not_proven_absent",
	}
	for got, want := range reasons {
		if string(got) != want {
			t.Fatalf("EditRetryReasonCode = %q, want %q", got, want)
		}
	}
}

func TestEditRetryContractZeroValuesAreUncommitted(t *testing.T) {
	if got := (RuntimeProviderDispatchResult{}); got.Disposition != "" || got.Acceptance != nil {
		t.Fatalf("RuntimeProviderDispatchResult zero value = %#v", got)
	}
	if got := (RuntimeHistoryMutationResult{}); got.Disposition != "" || got.Snapshot != nil {
		t.Fatalf("RuntimeHistoryMutationResult zero value = %#v", got)
	}
	if got := (EditRetryAvailability{}); got.Supported || got.Eligible ||
		got.TurnID != "" || got.HistoryRevision != 0 || got.RecoveryState != "" ||
		got.OperationID != "" || got.AvailableActions != nil || got.ReasonCode != "" {
		t.Fatalf("EditRetryAvailability zero value = %#v", got)
	}
	if got := (EditRetryResult{}); got.State != "" || got.RetractedTurnID != "" ||
		got.ReplacementTurnID != "" || got.HistoryRevision != 0 ||
		got.OperationID != "" || got.ReasonCode != "" {
		t.Fatalf("EditRetryResult zero value = %#v", got)
	}
}

func TestEditRetryErrorSentinelsAreStableAndDistinct(t *testing.T) {
	sentinels := []error{
		ErrEditRetryNotEligible,
		ErrEditRetryHistoryConflict,
		ErrRuntimeHistoryUnsupported,
		ErrEditRetryInProgress,
		ErrEditRetryResendPending,
		ErrEditRetryRecoveryRequired,
	}
	for index, sentinel := range sentinels {
		if sentinel == nil || sentinel.Error() == "" {
			t.Fatalf("sentinel %d is empty", index)
		}
		for other := index + 1; other < len(sentinels); other++ {
			if errors.Is(sentinel, sentinels[other]) || errors.Is(sentinels[other], sentinel) {
				t.Fatalf("sentinels %d and %d are not distinct", index, other)
			}
		}
	}
}
