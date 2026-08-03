package agenthost

import (
	"errors"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestRuntimeDispatchDispositionContractValues(t *testing.T) {
	tests := []struct {
		name string
		got  RuntimeDispatchDisposition
		want string
	}{
		{name: "applied", got: RuntimeDispatchDispositionApplied, want: "applied"},
		{name: "applied without provider turn", got: RuntimeDispatchDispositionAppliedWithoutProviderTurn, want: "applied_without_provider_turn"},
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
	if got := (EditRetryAvailability{}).ImpactScope(); got != EditRetryImpactScopeSession {
		t.Fatalf("EditRetryAvailability impact scope = %q, want session", got)
	}
	if got := (EditRetryResult{}).ImpactScope(); got != EditRetryImpactScopeSession {
		t.Fatalf("EditRetryResult impact scope = %q, want session", got)
	}
	if !EditRetryAdmissionAllowNew.AllowsNew() || EditRetryAdmissionDenyNew.AllowsNew() {
		t.Fatalf("edit retry admission policy values are not stable")
	}
	if !EditRetryRecoveryDrain.AllowsMutation() || EditRetryRecoveryReconcileOnly.AllowsMutation() {
		t.Fatalf("edit retry recovery policy values are not stable")
	}
	actions := map[EditRetryRecoveryAction]string{
		EditRetryRecoveryActionReconcile:        "reconcile",
		EditRetryRecoveryActionRetryReplacement: "retry_replacement",
		EditRetryRecoveryActionAbandon:          "abandon",
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
		EditRetryReasonCodeRetryWait:                  "retry_wait",
		EditRetryReasonCodeRetryBudgetExhausted:       "retry_budget_exhausted",
		EditRetryReasonCodeLocalStateInconsistent:     "local_state_inconsistent",
		EditRetryReasonCodeProviderUnsupported:        "provider_unsupported",
		EditRetryReasonCodeTurnNotFound:               "turn_not_found",
		EditRetryReasonCodeTurnNotLatest:              "turn_not_latest",
		EditRetryReasonCodeTurnNotSettled:             "turn_not_settled",
		EditRetryReasonCodeHistoryRevisionConflict:    "history_revision_conflict",
		EditRetryReasonCodeOperationConflict:          "operation_conflict",
		EditRetryReasonCodeRecoveryRequired:           "recovery_required",
		EditRetryReasonCodeProviderOutcomeUnknown:     "provider_outcome_unknown",
		EditRetryReasonCodeReplacementNotProvenAbsent: "replacement_not_proven_absent",
		EditRetryReasonCodeRolloutDisabled:            "rollout_disabled",
	}
	for got, want := range reasons {
		if string(got) != want {
			t.Fatalf("EditRetryReasonCode = %q, want %q", got, want)
		}
	}
}

func TestEditRetryRecoveryReasonProjectionContract(t *testing.T) {
	payload, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{
		ClientOperationID: "client-operation", EditedText: "replacement",
		ReplacementTurnID: "replacement-turn", ClientSubmitID: "edit-retry:operation",
		ExpectedRevision: 7, Checkpoint: storesqlite.EditRetryCheckpointPrepared,
	})
	if err != nil {
		t.Fatalf("EncodeEditRetryOperationPayload() error = %v", err)
	}
	tests := []struct {
		name        string
		operation   storesqlite.RuntimeOperation
		history     storesqlite.SessionHistory
		wantReason  EditRetryReasonCode
		automatic   bool
		wantRetry   bool
		wantActions []EditRetryRecoveryAction
	}{
		{
			name: "retry wait is automatic and scheduled",
			operation: storesqlite.RuntimeOperation{
				OperationID: "operation", Kind: storesqlite.RuntimeOperationKindEditRetry,
				Status: storesqlite.RuntimeOperationStatusPrepared, Payload: payload,
				LastError: string(EditRetryReasonCodeRetryWait), NextAttemptAtMS: 100,
			},
			wantReason: EditRetryReasonCodeRetryWait, automatic: true, wantRetry: true,
		},
		{
			name: "budget exhaustion is blocked and unscheduled",
			operation: storesqlite.RuntimeOperation{
				OperationID: "operation", Kind: storesqlite.RuntimeOperationKindEditRetry,
				Status: storesqlite.RuntimeOperationStatusBlocked, Payload: payload,
				LastError: string(EditRetryReasonCodeRetryBudgetExhausted),
			},
			history:     storesqlite.SessionHistory{RecoveryState: storesqlite.SessionHistoryRecoveryRequired},
			wantReason:  EditRetryReasonCodeRetryBudgetExhausted,
			wantActions: []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile},
		},
		{
			name: "local invariant is session local and unscheduled",
			operation: storesqlite.RuntimeOperation{
				OperationID: "operation", Kind: storesqlite.RuntimeOperationKindEditRetry,
				Status: storesqlite.RuntimeOperationStatusBlocked, Payload: payload,
				LastError: string(EditRetryReasonCodeLocalStateInconsistent),
			},
			history:     storesqlite.SessionHistory{RecoveryState: storesqlite.SessionHistoryRecoveryRequired},
			wantReason:  EditRetryReasonCodeLocalStateInconsistent,
			wantActions: []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := editRetryResult(test.operation, test.history)
			if result.ReasonCode != test.wantReason || result.Automatic != test.automatic ||
				(test.wantRetry != (result.NextAttemptAtMS > 0)) {
				t.Fatalf("editRetryResult() = %#v, want reason=%q automatic=%v scheduled=%v", result, test.wantReason, test.automatic, test.wantRetry)
			}
			if len(result.AvailableActions) != len(test.wantActions) {
				t.Fatalf("actions = %v, want %v", result.AvailableActions, test.wantActions)
			}
			for index, action := range test.wantActions {
				if result.AvailableActions[index] != action {
					t.Fatalf("actions = %v, want %v", result.AvailableActions, test.wantActions)
				}
			}
		})
	}
}

func TestEditRetryV2WireContract(t *testing.T) {
	if got := storesqlite.EditRetrySagaVersionCurrent; got != 2 {
		t.Fatalf("EditRetrySagaVersionCurrent = %d, want 2", got)
	}

	base := storesqlite.EditRetryOperationPayload{
		ClientOperationID: "client-operation",
		EditedText:        "replacement",
		ReplacementTurnID: "replacement-turn",
		ClientSubmitID:    "edit-retry:operation",
		ExpectedRevision:  7,
	}
	tests := []struct {
		name    string
		payload storesqlite.EditRetryOperationPayload
		want    storesqlite.EditRetryCheckpoint
	}{
		{name: "prepared", payload: base, want: storesqlite.EditRetryCheckpointPrepared},
		{
			name: "prepared snapshot",
			payload: func() storesqlite.EditRetryOperationPayload {
				payload := base
				payload.ProviderSessionID = "provider-session"
				payload.BeforeProviderIDs = []string{"provider-turn"}
				return payload
			}(),
			want: storesqlite.EditRetryCheckpointPrepared,
		},
		{
			name: "rollback dispatched",
			payload: func() storesqlite.EditRetryOperationPayload {
				payload := base
				payload.ProviderSessionID = "provider-session"
				payload.BeforeProviderIDs = []string{"provider-turn"}
				payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackDispatched
				return payload
			}(),
			want: storesqlite.EditRetryCheckpointRollbackDispatched,
		},
		{
			name: "rollback confirmed",
			payload: func() storesqlite.EditRetryOperationPayload {
				payload := base
				payload.ProviderSessionID = "provider-session"
				payload.BeforeProviderIDs = []string{"provider-turn"}
				payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackConfirmed
				return payload
			}(),
			want: storesqlite.EditRetryCheckpointRollbackConfirmed,
		},
		{
			name: "replacement dispatched",
			payload: func() storesqlite.EditRetryOperationPayload {
				payload := base
				payload.ProviderSessionID = "provider-session"
				payload.BeforeProviderIDs = []string{"provider-turn"}
				payload.Checkpoint = storesqlite.EditRetryCheckpointReplacementDispatched
				return payload
			}(),
			want: storesqlite.EditRetryCheckpointReplacementDispatched,
		},
		{
			name: "rollback aborted",
			payload: func() storesqlite.EditRetryOperationPayload {
				payload := base
				payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackAborted
				return payload
			}(),
			want: storesqlite.EditRetryCheckpointRollbackAborted,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := test.payload
			if payload.Checkpoint == "" {
				payload.Checkpoint = storesqlite.EditRetryCheckpointPrepared
			}
			encoded, err := storesqlite.EncodeEditRetryOperationPayload(payload)
			if err != nil {
				t.Fatalf("EncodeEditRetryOperationPayload() error = %v", err)
			}
			decoded, err := storesqlite.DecodeEditRetryOperationPayload(encoded)
			if err != nil {
				t.Fatalf("DecodeEditRetryOperationPayload() error = %v", err)
			}
			if decoded.SagaVersion != storesqlite.EditRetrySagaVersionCurrent || decoded.Checkpoint != test.want {
				t.Fatalf("decoded payload = %#v, want V2 %q", decoded, test.want)
			}
		})
	}

	invalid := base
	invalid.Checkpoint = storesqlite.EditRetryCheckpoint("unknown")
	if err := invalid.Validate("operation"); err == nil {
		t.Fatal("unknown V2 checkpoint validated")
	}
	invalid = base
	invalid.SagaVersion = storesqlite.EditRetrySagaVersionCurrent + 1
	if err := invalid.Validate("operation"); err == nil {
		t.Fatal("unknown edit-retry saga version validated")
	}
}

func TestEditRetryDurableStepDispositionContract(t *testing.T) {
	tests := []struct {
		name        string
		operation   storesqlite.RuntimeOperation
		want        operationStepDisposition
		wantDurable bool
	}{
		{
			name:        "prepared deferred",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusPrepared},
			want:        operationStepDeferred,
			wantDurable: true,
		},
		{
			name:        "blocked local",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusBlocked},
			want:        operationStepBlocked,
			wantDurable: true,
		},
		{
			name:        "completed including abandoned",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusCompleted, Result: storesqlite.RuntimeOperationResultAbandoned},
			want:        operationStepCompleted,
			wantDurable: true,
		},
		{
			name:        "known quarantine only",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusFailed, LastError: "edit_retry disabled; operation quarantined"},
			want:        operationStepQuarantined,
			wantDurable: true,
		},
		{
			name:        "ordinary terminal failure stays distinct",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusFailed, LastError: "ordinary terminal failure"},
			want:        operationStepTerminalFailed,
			wantDurable: true,
		},
		{
			name:        "leased has no durable disposition",
			operation:   storesqlite.RuntimeOperation{Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusLeased},
			wantDurable: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, durable := durableOperationStepResult(test.operation)
			if durable != test.wantDurable || (durable && result.Disposition != test.want) {
				t.Fatalf("durableOperationStepResult(%#v) = (%#v, %v), want disposition %q durable=%v", test.operation, result, durable, test.want, test.wantDurable)
			}
		})
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
