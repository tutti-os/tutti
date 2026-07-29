package sessionreplay

import (
	"errors"
	"testing"
)

func TestRecordingLifecycle(t *testing.T) {
	recording := &Recording{
		ID:                 "recording-1",
		RootAgentSessionID: "session-1",
		Status:             RecordingStatusPreparing,
		CreatedAtUnixMS:    1,
		UpdatedAtUnixMS:    1,
	}
	for _, transition := range []RecordingTransition{
		{Status: RecordingStatusReady, AtUnixMS: 2},
		{Status: RecordingStatusRecording, AtUnixMS: 3},
		{Status: RecordingStatusFinalizing, AtUnixMS: 4},
		{Status: RecordingStatusComplete, AtUnixMS: 5, CassetteID: "cassette-1"},
	} {
		if err := TransitionRecording(recording, transition); err != nil {
			t.Fatalf("TransitionRecording(%s): %v", transition.Status, err)
		}
	}
	if recording.CassetteID != "cassette-1" ||
		recording.RecordingAtUnixMS != 3 ||
		recording.StoppedAtUnixMS != 4 ||
		recording.UpdatedAtUnixMS != 5 {
		t.Fatalf("recording = %#v", recording)
	}
	if IsRecordingActive(recording.Status) {
		t.Fatal("completed recording is active")
	}
}

func TestRecordingRejectsCompleteWithoutCassette(t *testing.T) {
	recording := &Recording{
		RootAgentSessionID: "session-1",
		Status:             RecordingStatusFinalizing,
	}
	err := TransitionRecording(recording, RecordingTransition{
		Status:   RecordingStatusComplete,
		AtUnixMS: 1,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("error = %v", err)
	}
}

func TestReplayRunLifecycleAndMonotonicCheckpoint(t *testing.T) {
	run := &ReplayRun{
		ID:              "run-1",
		CassetteID:      "cassette-1",
		Status:          ReplayRunStatusStarting,
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 1,
	}
	if err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   2,
		Checkpoint: 0,
	}); err != nil {
		t.Fatal(err)
	}
	if err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   3,
		Checkpoint: 3,
	}); err != nil {
		t.Fatal(err)
	}
	err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   4,
		Checkpoint: 2,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("backward checkpoint error = %v", err)
	}
	if err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusComplete,
		AtUnixMS:   5,
		Checkpoint: 5,
	}); err != nil {
		t.Fatal(err)
	}
	if run.CompletedAtUnixMS != 5 || run.Checkpoint != 5 {
		t.Fatalf("run = %#v", run)
	}
}

func TestReplayRunRejectsFailedTransitionWithoutPartialMutation(t *testing.T) {
	run := &ReplayRun{
		ID:              "run-1",
		CassetteID:      "cassette-1",
		Status:          ReplayRunStatusRunning,
		Checkpoint:      2,
		CreatedAtUnixMS: 1,
		StartedAtUnixMS: 2,
		UpdatedAtUnixMS: 2,
	}
	err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusFailed,
		AtUnixMS:   3,
		Checkpoint: 3,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("error = %v", err)
	}
	if run.Status != ReplayRunStatusRunning ||
		run.Checkpoint != 2 ||
		run.CompletedAtUnixMS != 0 ||
		run.UpdatedAtUnixMS != 2 {
		t.Fatalf("run mutated after rejected transition: %#v", run)
	}
}

func TestReplayRunStartingCannotSkipBootstrapCheckpoint(t *testing.T) {
	run := &ReplayRun{
		ID:              "run-1",
		CassetteID:      "cassette-1",
		Status:          ReplayRunStatusStarting,
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 1,
	}
	err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   2,
		Checkpoint: 1,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("error = %v", err)
	}
	if run.Status != ReplayRunStatusStarting || run.Checkpoint != 0 {
		t.Fatalf("run mutated after rejected transition: %#v", run)
	}
}

func TestReplayRunTerminalCheckpointIsImmutable(t *testing.T) {
	run := &ReplayRun{
		ID:                "run-1",
		CassetteID:        "cassette-1",
		Status:            ReplayRunStatusComplete,
		Checkpoint:        2,
		CreatedAtUnixMS:   1,
		StartedAtUnixMS:   2,
		CompletedAtUnixMS: 3,
		UpdatedAtUnixMS:   3,
	}
	err := TransitionReplayRun(run, ReplayRunTransition{
		Status:     ReplayRunStatusComplete,
		AtUnixMS:   4,
		Checkpoint: 3,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("error = %v", err)
	}
	if run.Checkpoint != 2 || run.UpdatedAtUnixMS != 3 {
		t.Fatalf("terminal run mutated: %#v", run)
	}
}
