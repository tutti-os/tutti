package sessionreplay

// SemanticCassetteArtifact is the validated semantic input consumed by the
// replay application service. Filesystem layout remains a data-layer concern.
type SemanticCassetteArtifact struct {
	Manifest        CassetteManifest
	InitialStateRaw []byte
	InitialState    *TuttiReplayState
	ExpectedState   TuttiReplayState
	CheckpointPlan  CheckpointPlan
}
