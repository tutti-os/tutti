package agenthost

// RuntimeProviderAcceptanceDiagnostics carries low-cardinality identity
// evidence from the provider acceptance boundary to terminal telemetry.
type RuntimeProviderAcceptanceDiagnostics struct {
	Status                   string
	ProviderSessionIDPresent bool
	ProviderTurnIDPresent    bool
	ProviderTurnIDSource     string
	FailureReason            string
}

// RuntimeProviderAcceptanceReceipt is positive provider evidence that a
// replacement turn crossed the provider delivery boundary.
type RuntimeProviderAcceptanceReceipt struct {
	ProviderSessionID string
	ProviderTurnID    string
	Source            RuntimeAcceptanceSource
}

// RuntimeProviderDispatchResult separates an explicit provider outcome from a
// transport failure whose effect is unknown. Acceptance is present only when
// the provider supplied positive evidence for the dispatched turn.
type RuntimeProviderDispatchResult struct {
	Disposition           RuntimeDispatchDisposition
	Acceptance            *RuntimeProviderAcceptanceReceipt
	AcceptanceDiagnostics *RuntimeProviderAcceptanceDiagnostics
}
