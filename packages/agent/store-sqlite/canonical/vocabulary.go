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
	switch phase {
	case TurnPhaseSubmitted, TurnPhaseRunning, TurnPhaseWaiting, TurnPhaseSettling, TurnPhaseSettled:
		return true
	default:
		return false
	}
}

func IsKnownTurnOutcome(outcome string) bool {
	switch outcome {
	case TurnOutcomeCompleted, TurnOutcomeFailed, TurnOutcomeCanceled, TurnOutcomeInterrupted:
		return true
	default:
		return false
	}
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
