// Package canonical defines the closed activity vocabulary persisted by the
// SQLite canonical store. Packages that exchange activity snapshots should
// import this package instead of duplicating these values.
package canonical

const (
	SessionKindRoot  = "root"
	SessionKindChild = "child"
)

const (
	TurnPhaseSubmitted = "submitted"
	TurnPhaseRunning   = "running"
	TurnPhaseWaiting   = "waiting"
	TurnPhaseSettling  = "settling"
	TurnPhaseSettled   = "settled"
)

const (
	TurnOutcomeCompleted   = "completed"
	TurnOutcomeFailed      = "failed"
	TurnOutcomeCanceled    = "canceled"
	TurnOutcomeInterrupted = "interrupted"
)

var (
	turnPhases = [...]string{
		TurnPhaseSubmitted,
		TurnPhaseRunning,
		TurnPhaseWaiting,
		TurnPhaseSettling,
		TurnPhaseSettled,
	}
	turnOutcomes = [...]string{
		TurnOutcomeCompleted,
		TurnOutcomeFailed,
		TurnOutcomeCanceled,
		TurnOutcomeInterrupted,
	}
)

const (
	TurnOriginUserPrompt        = "user_prompt"
	TurnOriginGoalArm           = "goal_arm"
	TurnOriginGoalContinuation  = "goal_continuation"
	TurnOriginProviderInitiated = "provider_initiated"
	TurnOriginLegacyUnknown     = "legacy_unknown"
)

const (
	RootProviderTurnPhaseRunning   = "running"
	RootProviderTurnPhaseCompleted = "completed"
)

const (
	InteractionKindApproval = "approval"
	InteractionKindQuestion = "question"
	InteractionKindPlan     = "plan"
)

const (
	InteractionStatusPending    = "pending"
	InteractionStatusAnswered   = "answered"
	InteractionStatusSuperseded = "superseded"
)

func IsKnownTurnPhase(phase string) bool {
	for _, known := range turnPhases {
		if phase == known {
			return true
		}
	}
	return false
}

func IsKnownTurnOutcome(outcome string) bool {
	for _, known := range turnOutcomes {
		if outcome == known {
			return true
		}
	}
	return false
}

// TurnPhases returns the complete closed phase vocabulary. Callers receive a
// copy so the canonical package remains the only owner of the set.
func TurnPhases() []string {
	return append([]string(nil), turnPhases[:]...)
}

// TurnOutcomes returns the complete closed outcome vocabulary. Callers receive
// a copy so the canonical package remains the only owner of the set.
func TurnOutcomes() []string {
	return append([]string(nil), turnOutcomes[:]...)
}

func IsKnownTurnOrigin(origin string) bool {
	switch origin {
	case TurnOriginUserPrompt, TurnOriginGoalArm, TurnOriginGoalContinuation,
		TurnOriginProviderInitiated, TurnOriginLegacyUnknown:
		return true
	default:
		return false
	}
}

func IsKnownInteractionKind(kind string) bool {
	switch kind {
	case InteractionKindApproval, InteractionKindQuestion, InteractionKindPlan:
		return true
	default:
		return false
	}
}

func IsKnownInteractionStatus(status string) bool {
	switch status {
	case InteractionStatusPending, InteractionStatusAnswered, InteractionStatusSuperseded:
		return true
	default:
		return false
	}
}
