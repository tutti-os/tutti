package main

import (
	"context"
	"errors"
	"testing"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type replayVerifierTransport struct {
	err               error
	calls             int
	speed             float64
	playbackElapsedMS float64
	paused            bool
	fastForward       bool
	setSpeed          float64
}

func (t *replayVerifierTransport) Finalize() error {
	t.calls++
	return t.err
}

func (t *replayVerifierTransport) ReplayPlaybackState() (agentdaemon.ReplayPlaybackState, error) {
	return agentdaemon.ReplayPlaybackState{
		Drained:           true,
		Speed:             t.speed,
		PlaybackElapsedMS: t.playbackElapsedMS,
		Paused:            t.paused,
		FastForward:       t.fastForward,
	}, t.err
}

func (t *replayVerifierTransport) SetReplayPlaybackSpeed(speed float64) error {
	t.setSpeed = speed
	t.speed = speed
	return t.err
}

func (t *replayVerifierTransport) PauseReplayPlayback() error {
	t.paused = true
	return t.err
}

func (t *replayVerifierTransport) ResumeReplayPlayback() error {
	t.paused = false
	return t.err
}

func (t *replayVerifierTransport) SetReplayPlaybackFastForward(enabled bool) error {
	t.fastForward = enabled
	return t.err
}

func TestReplayProviderAvailabilityCheckerDoesNotProbeHost(t *testing.T) {
	got, err := (replayProviderAvailabilityChecker{}).ListProviderAvailability(
		context.Background(),
		[]string{"codex"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 ||
		got[0].Provider != "codex" ||
		got[0].Status != agentservice.ProviderAvailabilityAvailable {
		t.Fatalf("availability = %#v, want replay-local available", got)
	}
}

func TestAgentReplayTransportVerifierFailsClosedAndPropagatesMismatch(t *testing.T) {
	transport := &replayVerifierTransport{err: errors.New("leftover frame")}
	disabled := agentReplayTransportVerifier{transport: transport}
	if err := disabled.Verify(context.Background()); err == nil {
		t.Fatal("disabled verifier succeeded")
	}
	if transport.calls != 0 {
		t.Fatalf("disabled verifier finalized %d times", transport.calls)
	}
	enabled := agentReplayTransportVerifier{enabled: true, transport: transport}
	if err := enabled.Verify(context.Background()); err == nil ||
		err.Error() != "leftover frame" {
		t.Fatalf("enabled verifier error = %v", err)
	}
	if transport.calls != 1 {
		t.Fatalf("enabled verifier finalized %d times, want 1", transport.calls)
	}
}

func TestAgentReplayTransportVerifierControlsPlaybackOnlyWhenEnabled(t *testing.T) {
	transport := &replayVerifierTransport{speed: 1}
	disabled := agentReplayTransportVerifier{transport: transport}
	if _, err := disabled.PlaybackState(context.Background()); err == nil {
		t.Fatal("disabled playback read succeeded")
	}
	enabled := agentReplayTransportVerifier{enabled: true, transport: transport}
	state, err := enabled.SetPlaybackSpeed(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if state.Speed != 2 || !state.Drained || transport.setSpeed != 2 {
		t.Fatalf("playback = %#v / %v, want 2 drained", state, transport.setSpeed)
	}
	state, err = enabled.SetPlaybackPaused(context.Background(), true)
	if err != nil || !state.Paused {
		t.Fatalf("paused playback = %#v, err=%v", state, err)
	}
	state, err = enabled.SetPlaybackPaused(context.Background(), false)
	if err != nil || state.Paused {
		t.Fatalf("resumed playback = %#v, err=%v", state, err)
	}
	state, err = enabled.SetPlaybackFastForward(context.Background(), true)
	if err != nil || !state.FastForward {
		t.Fatalf("fast-forward playback = %#v, err=%v", state, err)
	}
}
