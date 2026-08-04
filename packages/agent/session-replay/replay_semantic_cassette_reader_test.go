package sessionreplay

import (
	"context"
	"testing"
)

func TestSemanticCassetteReaderReturnsValidatedArtifact(t *testing.T) {
	store := &Store{StateDir: t.TempDir()}
	recording := Recording{
		ID:                  "recording-reader",
		ScopeID:             "workspace-reader",
		AgentTargetID:       "local:codex",
		ReplayPrerequisites: replayPrerequisitesForTest(),
		Name:                "semantic reader",
		RootAgentSessionID:  "session-1",
		Mode:                ScenarioModeCreateSession,
	}
	completeArtifactCandidate(t, store, recording)
	published, err := store.Publish(
		context.Background(),
		recording,
		"cassette-reader",
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewSemanticCassetteReader(map[string]string{
		"cassette-reader": published.Layout.StorageKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := reader.ReadSemanticCassette(
		context.Background(),
		"cassette-reader",
	)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Manifest.ID != "cassette-reader" ||
		artifact.ExpectedState.Agent.RootSessionID != "session-1" ||
		artifact.InitialState != nil ||
		len(artifact.InitialStateRaw) != 0 ||
		len(artifact.CheckpointPlan.Checkpoints) != 2 {
		t.Fatalf("semantic artifact = %#v", artifact)
	}
}

func TestSemanticCassetteReaderRejectsUnregisteredCassette(t *testing.T) {
	reader, err := NewSemanticCassetteReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.ReadSemanticCassette(
		context.Background(),
		"missing",
	); err == nil {
		t.Fatal("unregistered semantic cassette was accepted")
	}
}
