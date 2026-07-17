package canonical

import "testing"

func TestClosedVocabularyValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		values []string
		known  func(string) bool
	}{
		{"turn phase", TurnPhases(), IsKnownTurnPhase},
		{"turn outcome", TurnOutcomes(), IsKnownTurnOutcome},
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

func TestClosedTurnVocabularyReturnsCopies(t *testing.T) {
	phases := TurnPhases()
	outcomes := TurnOutcomes()
	phases[0] = "mutated"
	outcomes[0] = "mutated"
	if TurnPhases()[0] != TurnPhaseSubmitted {
		t.Fatal("TurnPhases exposed mutable canonical storage")
	}
	if TurnOutcomes()[0] != TurnOutcomeCompleted {
		t.Fatal("TurnOutcomes exposed mutable canonical storage")
	}
}
