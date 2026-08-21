package agentruntime

import (
	"errors"
	"strings"
)

const codexProviderTurnIDSourceTurnStartResponse = "turn_start_response"

func codexProviderAcceptanceDiagnostics(
	providerSessionID string,
	providerTurnID string,
	failureReason string,
) *ProviderAcceptanceDiagnostics {
	providerSessionID = strings.TrimSpace(providerSessionID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	diagnostics := &ProviderAcceptanceDiagnostics{
		Status:                   string(DispatchDispositionOutcomeUnknown),
		ProviderSessionIDPresent: providerSessionID != "",
		ProviderTurnIDPresent:    providerTurnID != "",
		ProviderTurnIDSource:     codexProviderTurnIDSourceTurnStartResponse,
		FailureReason:            strings.TrimSpace(failureReason),
	}
	if providerSessionID != "" && providerTurnID != "" {
		diagnostics.Status = string(DispatchDispositionApplied)
	}
	return diagnostics
}

func codexProviderAcceptanceMissingIdentityReason(providerSessionID, providerTurnID string) string {
	hasSessionID := strings.TrimSpace(providerSessionID) != ""
	hasTurnID := strings.TrimSpace(providerTurnID) != ""
	switch {
	case !hasSessionID && !hasTurnID:
		return "missing_provider_session_id_and_provider_turn_id"
	case !hasSessionID:
		return "missing_provider_session_id"
	default:
		return "missing_provider_turn_id"
	}
}

func reportCodexDispatchFailure(report ProviderDispatchSink, err error) {
	if report == nil {
		return
	}
	disposition := DispatchDispositionOutcomeUnknown
	var callErr *acpCallError
	if errors.As(err, &callErr) {
		disposition = DispatchDispositionRejected
	}
	report(ProviderDispatchResult{Disposition: disposition})
}

func reportCodexAppliedWithoutProviderTurn(report ProviderDispatchSink) {
	if report != nil {
		report(ProviderDispatchResult{
			Disposition: DispatchDispositionAppliedWithoutProviderTurn,
		})
	}
}

func reportCodexProviderTurnAccepted(
	report ProviderDispatchSink,
	providerSessionID string,
	providerTurnID string,
) {
	if report == nil {
		return
	}
	providerSessionID = strings.TrimSpace(providerSessionID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	if providerSessionID == "" || providerTurnID == "" {
		report(ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
			AcceptanceDiagnostics: codexProviderAcceptanceDiagnostics(
				providerSessionID,
				providerTurnID,
				codexProviderAcceptanceMissingIdentityReason(providerSessionID, providerTurnID),
			),
		})
		return
	}
	report(ProviderDispatchResult{
		Disposition:           DispatchDispositionApplied,
		AcceptanceDiagnostics: codexProviderAcceptanceDiagnostics(providerSessionID, providerTurnID, ""),
		Acceptance: &ProviderAcceptanceReceipt{
			Source:            AcceptanceSourceTurnStartResponse,
			ProviderSessionID: providerSessionID,
			ProviderTurnID:    providerTurnID,
		},
	})
}

func (options codexTurnExecOptions) confirmProviderTurnAcceptance(
	providerSessionID string,
	providerTurnID string,
) error {
	if options.acceptProviderTurn == nil {
		reportCodexProviderTurnAccepted(
			options.reportDispatch,
			providerSessionID,
			providerTurnID,
		)
		return nil
	}
	providerSessionID = strings.TrimSpace(providerSessionID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	if providerSessionID == "" || providerTurnID == "" {
		options.report(ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
			AcceptanceDiagnostics: codexProviderAcceptanceDiagnostics(
				providerSessionID,
				providerTurnID,
				codexProviderAcceptanceMissingIdentityReason(providerSessionID, providerTurnID),
			),
		})
		return errors.New("codex provider turn acceptance omitted identity")
	}
	return options.acceptProviderTurn(ProviderAcceptanceReceipt{
		Source:            AcceptanceSourceTurnStartResponse,
		ProviderSessionID: providerSessionID,
		ProviderTurnID:    providerTurnID,
	})
}
