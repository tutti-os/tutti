package agentruntime

import "testing"

func TestConfirmCodexProviderTurnAcceptanceReportsMissingTurnIdentity(t *testing.T) {
	var reported ProviderDispatchResult
	options := codexTurnExecOptions{
		reportDispatch: func(result ProviderDispatchResult) {
			reported = result
		},
		acceptProviderTurn: func(ProviderAcceptanceReceipt) error {
			t.Fatal("acceptance barrier should not be called for missing identity")
			return nil
		},
	}

	err := options.confirmProviderTurnAcceptance("codex-thread-1", "")
	if err == nil || err.Error() != "codex provider turn acceptance omitted identity" {
		t.Fatalf("error = %v, want omitted identity error", err)
	}
	if reported.Disposition != DispatchDispositionOutcomeUnknown {
		t.Fatalf("disposition = %q, want outcome_unknown", reported.Disposition)
	}
	if reported.AcceptanceDiagnostics == nil {
		t.Fatal("acceptance diagnostics are nil")
	}
	diagnostics := reported.AcceptanceDiagnostics
	if diagnostics.Status != string(DispatchDispositionOutcomeUnknown) ||
		diagnostics.ProviderSessionIDPresent != true ||
		diagnostics.ProviderTurnIDPresent != false ||
		diagnostics.ProviderTurnIDSource != codexProviderTurnIDSourceTurnStartResponse ||
		diagnostics.FailureReason != "missing_provider_turn_id" {
		t.Fatalf("acceptance diagnostics = %#v", diagnostics)
	}
}
