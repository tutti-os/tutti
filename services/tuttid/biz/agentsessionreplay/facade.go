package agentsessionreplay

import replay "github.com/tutti-os/tutti/packages/agent/session-replay"

var ErrTuttiReplayStateConflict = replay.ErrTuttiReplayStateConflict

const (
	SchemaVersion = replay.SchemaVersion
	StateFormat   = replay.StateFormat
)

type SemanticCassetteArtifact = replay.SemanticCassetteArtifact
type TuttiReplayState = replay.TuttiReplayState
type TuttiReplayAgent = replay.TuttiReplayAgent
type TuttiReplaySession = replay.TuttiReplaySession
type TuttiReplayTurn = replay.TuttiReplayTurn
type TuttiReplayMessage = replay.TuttiReplayMessage
type TuttiReplayInteraction = replay.TuttiReplayInteraction
type TuttiReplayGoal = replay.TuttiReplayGoal
type TuttiReplayTuttiMode = replay.TuttiReplayTuttiMode
type TuttiReplayActivation = replay.TuttiReplayActivation
type TuttiReplayTurnSnapshot = replay.TuttiReplayTurnSnapshot
type TuttiReplayWorkflow = replay.TuttiReplayWorkflow
type TuttiReplayIssue = replay.TuttiReplayIssue
type TuttiReplayIssueTask = replay.TuttiReplayIssueTask
type TuttiReplayStateConflictError = replay.TuttiReplayStateConflictError
type TuttiReplayMergedState = replay.TuttiReplayMergedState

func ProjectPortableAgentState(
	agent TuttiReplayAgent,
	stateDirectory string,
) TuttiReplayAgent {
	return replay.ProjectPortableAgentState(agent, stateDirectory)
}

func ResolvePortableAgentState(
	agent TuttiReplayAgent,
	replayCWD string,
) (TuttiReplayAgent, error) {
	return replay.ResolvePortableAgentState(agent, replayCWD)
}

func ValidateTuttiReplayState(state TuttiReplayState) error {
	return replay.ValidateTuttiReplayState(state)
}

func MergeTuttiReplayStates(
	states []TuttiReplayState,
) (TuttiReplayMergedState, error) {
	return replay.MergeTuttiReplayStates(states)
}

func CompareTuttiReplayState(
	expected, actual TuttiReplayState,
) error {
	return replay.CompareTuttiReplayState(expected, actual)
}
