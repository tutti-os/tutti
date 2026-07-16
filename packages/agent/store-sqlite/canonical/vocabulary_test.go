package canonical

import "testing"

func TestClosedVocabularyValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		values []string
		known  func(string) bool
	}{
		{"turn phase", []string{TurnPhaseSubmitted, TurnPhaseRunning, TurnPhaseWaiting, TurnPhaseSettling, TurnPhaseSettled}, IsKnownTurnPhase},
		{"turn outcome", []string{TurnOutcomeCompleted, TurnOutcomeFailed, TurnOutcomeCanceled, TurnOutcomeInterrupted}, IsKnownTurnOutcome},
		{"turn origin", []string{TurnOriginUserPrompt, TurnOriginGoalArm, TurnOriginGoalContinuation, TurnOriginProviderInitiated, TurnOriginLegacyUnknown}, IsKnownTurnOrigin},
		{"interaction kind", []string{InteractionKindApproval, InteractionKindQuestion, InteractionKindPlan}, IsKnownInteractionKind},
		{"interaction status", []string{InteractionStatusPending, InteractionStatusAnswered, InteractionStatusSuperseded}, IsKnownInteractionStatus},
	}
	for _, test := range tests {
		for _, value := range test.values {
			if !test.known(value) {
				t.Errorf("%s validator rejected %q", test.name, value)
			}
		}
		if test.known("unknown") {
			t.Errorf("%s validator accepted unknown value", test.name)
		}
	}
}
