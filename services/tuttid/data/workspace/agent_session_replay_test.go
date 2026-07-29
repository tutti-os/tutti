package workspace

import (
	"context"
	"errors"
	"testing"

	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
)

func TestAgentSessionReplayMetadataPersistsOneCassetteAndManyRuns(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	recording := agentsessionreplay.Recording{
		ID:                 "recording-1",
		Name:               "2026-07-28T10:00:00.000Z",
		ScopeID:            "workspace-1",
		AgentTargetID:      "local:codex",
		Mode:               agentsessionreplay.ScenarioModeCreateSession,
		RootAgentSessionID: "session-1",
		Status:             agentsessionreplay.StatusRecording,
		CreatedAtUnixMS:    10,
		UpdatedAtUnixMS:    20,
	}
	if err := store.PutRecording(ctx, recording); err != nil {
		t.Fatal(err)
	}
	gotRecording, err := store.GetRecording(ctx, recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotRecording.ArtifactKey != "" || gotRecording.Status != agentsessionreplay.StatusRecording {
		t.Fatalf("recording = %#v", gotRecording)
	}

	recording.Status = agentsessionreplay.StatusComplete
	recording.CassetteID = "cassette-1"
	recording.StoppedAtUnixMS = 30
	recording.UpdatedAtUnixMS = 30
	cassette := agentsessionreplay.Cassette{
		ID:                 recording.CassetteID,
		Name:               recording.Name,
		SourceRecordingID:  recording.ID,
		ScopeID:            recording.ScopeID,
		AgentTargetID:      recording.AgentTargetID,
		RootAgentSessionID: recording.RootAgentSessionID,
		Mode:               recording.Mode,
		TotalBytes:         1234,
		ManifestSHA256:     "manifest-digest",
		CreatedAtUnixMS:    30,
	}
	if err := store.PublishCassette(ctx, recording, cassette); err != nil {
		t.Fatal(err)
	}
	cassettes, err := store.ListCassettes(ctx, recording.ScopeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cassettes) != 1 || cassettes[0].SourceRecordingID != recording.ID {
		t.Fatalf("cassettes = %#v", cassettes)
	}
	recording.Name = "checkout regression"
	recording.UpdatedAtUnixMS = 31
	cassette.Name = recording.Name
	cassette.ManifestSHA256 = "renamed-manifest-digest"
	if err := store.UpdateCassette(ctx, recording, cassette); err != nil {
		t.Fatal(err)
	}
	gotRecording, err = store.GetRecording(ctx, recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	gotCassette, err := store.GetCassette(ctx, cassette.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotRecording.Name != recording.Name ||
		gotCassette.Name != cassette.Name ||
		gotCassette.ManifestSHA256 != cassette.ManifestSHA256 {
		t.Fatalf("recording=%#v cassette=%#v", gotRecording, gotCassette)
	}

	for index, status := range []agentsessionreplay.ReplayRunStatus{
		agentsessionreplay.ReplayRunStatusComplete,
		agentsessionreplay.ReplayRunStatusFailed,
	} {
		run := agentsessionreplay.ReplayRun{
			ID:              "run-" + string(rune('1'+index)),
			CassetteID:      cassette.ID,
			Status:          status,
			CreatedAtUnixMS: int64(40 + index),
			UpdatedAtUnixMS: int64(40 + index),
		}
		if err := store.PutReplayRun(ctx, run); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := store.ListReplayRuns(ctx, cassette.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 || runs[0].CassetteID != cassette.ID || runs[1].CassetteID != cassette.ID {
		t.Fatalf("runs = %#v", runs)
	}
}

func TestAgentSessionReplayMetadataReturnsDomainNotFoundErrors(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if _, err := store.GetRecording(ctx, "missing"); !errors.Is(err, agentsessionreplay.ErrNotFound) {
		t.Fatalf("GetRecording() error = %v", err)
	}
	if _, err := store.GetCassette(ctx, "missing"); !errors.Is(err, agentsessionreplay.ErrCassetteNotFound) {
		t.Fatalf("GetCassette() error = %v", err)
	}
	if _, err := store.GetReplayRun(ctx, "missing"); !errors.Is(err, agentsessionreplay.ErrReplayRunNotFound) {
		t.Fatalf("GetReplayRun() error = %v", err)
	}
}

func TestAgentSessionReplayMetadataDeletesCanceledRecording(t *testing.T) {
	store := openTestSQLiteStore(t)
	ctx := context.Background()
	recording := agentsessionreplay.Recording{
		ID:              "recording-1",
		Name:            "2026-07-28T10:00:00.000Z",
		ScopeID:         "workspace-1",
		AgentTargetID:   "local:codex",
		Mode:            agentsessionreplay.ScenarioModeCreateSession,
		Status:          agentsessionreplay.StatusReady,
		CreatedAtUnixMS: 10,
		UpdatedAtUnixMS: 10,
	}
	if err := store.PutRecording(ctx, recording); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteRecording(ctx, recording.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetRecording(ctx, recording.ID); !errors.Is(err, agentsessionreplay.ErrNotFound) {
		t.Fatalf("GetRecording() error = %v", err)
	}
	recordings, err := store.ListRecordings(ctx, recording.ScopeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(recordings) != 0 {
		t.Fatalf("recordings = %#v", recordings)
	}
}
