package api

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
)

type replayVerifierStub struct {
	err         error
	state       AgentSessionReplayPlaybackState
	lastCommand string
}

type replayCassetteListServiceStub struct {
	AgentSessionRecordingService
	workspaceID string
	cassettes   []agentsessionreplay.Cassette
	err         error
}

type replayRunControlServiceStub struct {
	AgentSessionRecordingService
	run                agentsessionreplay.ReplayRun
	cassette           agentsessionreplay.Cassette
	advancedCheckpoint int64
	canceled           bool
}

func (s *replayRunControlServiceStub) GetReplayRun(
	context.Context,
	string,
) (agentsessionreplay.ReplayRun, error) {
	return s.run, nil
}

func (s *replayRunControlServiceStub) GetCassette(
	context.Context,
	string,
) (agentsessionreplay.Cassette, error) {
	return s.cassette, nil
}

func (s *replayRunControlServiceStub) AdvanceReplayRunCheckpoint(
	_ context.Context,
	_ string,
	checkpoint int64,
) (agentsessionreplay.ReplayRun, error) {
	s.advancedCheckpoint = checkpoint
	s.run.Checkpoint = checkpoint
	return s.run, nil
}

func (s *replayRunControlServiceStub) CancelReplayRun(
	context.Context,
	string,
) (agentsessionreplay.ReplayRun, error) {
	s.canceled = true
	s.run.Status = agentsessionreplay.ReplayRunStatusCanceled
	return s.run, nil
}

func (s *replayCassetteListServiceStub) ListCassettes(
	_ context.Context,
	workspaceID string,
) ([]agentsessionreplay.Cassette, error) {
	s.workspaceID = workspaceID
	return s.cassettes, s.err
}

func (v replayVerifierStub) Verify(context.Context) error {
	return v.err
}

func (v *replayVerifierStub) PlaybackState(
	context.Context,
) (AgentSessionReplayPlaybackState, error) {
	return v.state, v.err
}

func (v *replayVerifierStub) SetPlaybackSpeed(
	_ context.Context,
	speed float64,
) (AgentSessionReplayPlaybackState, error) {
	v.lastCommand = "speed"
	v.state.Speed = speed
	return v.state, v.err
}

func (v *replayVerifierStub) SetPlaybackPaused(
	_ context.Context,
	paused bool,
) (AgentSessionReplayPlaybackState, error) {
	v.lastCommand = "paused"
	v.state.Paused = paused
	return v.state, v.err
}

func (v *replayVerifierStub) SetPlaybackFastForward(
	_ context.Context,
	enabled bool,
) (AgentSessionReplayPlaybackState, error) {
	v.lastCommand = "timing"
	v.state.FastForward = enabled
	return v.state, v.err
}

func TestVerifyAgentSessionReplayTransportFailsClosed(t *testing.T) {
	request := tuttigenerated.VerifyAgentSessionReplayTransportRequestObject{}
	unavailable, err := (DaemonAPI{}).VerifyAgentSessionReplayTransport(
		context.Background(),
		request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := unavailable.(tuttigenerated.VerifyAgentSessionReplayTransport503JSONResponse); !ok {
		t.Fatalf("unavailable response = %T, want 503", unavailable)
	}

	mismatch, err := (DaemonAPI{
		AgentSessionReplayVerifier: &replayVerifierStub{err: errors.New("leftover frame")},
	}).VerifyAgentSessionReplayTransport(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := mismatch.(tuttigenerated.VerifyAgentSessionReplayTransport409JSONResponse); !ok {
		t.Fatalf("mismatch response = %T, want 409", mismatch)
	}

	verified, err := (DaemonAPI{
		AgentSessionReplayVerifier: &replayVerifierStub{},
	}).VerifyAgentSessionReplayTransport(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := verified.(tuttigenerated.VerifyAgentSessionReplayTransport204Response); !ok {
		t.Fatalf("verified response = %T, want 204", verified)
	}
}

func TestAgentSessionReplayTransportPlaybackFailsClosedAndRunsTypedCommands(t *testing.T) {
	unavailable, err := (DaemonAPI{}).GetAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.GetAgentSessionReplayTransportPlaybackRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := unavailable.(tuttigenerated.GetAgentSessionReplayTransportPlayback503JSONResponse); !ok {
		t.Fatalf("unavailable response = %T, want 503", unavailable)
	}

	verifier := &replayVerifierStub{
		state: AgentSessionReplayPlaybackState{
			Speed:             1,
			PlaybackElapsedMS: 42,
			Drained:           true,
		},
	}
	ready := DaemonAPI{AgentSessionReplayVerifier: verifier}
	current, err := ready.GetAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.GetAgentSessionReplayTransportPlaybackRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := current.(tuttigenerated.GetAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		response.Speed != 1 || response.PlaybackElapsedMs != 42 ||
		!response.Drained || response.Paused ||
		response.TimingMode != tuttigenerated.AgentSessionReplayTransportPlaybackTimingModeRealtime {
		t.Fatalf("current response = %#v, want speed 1", current)
	}

	speed := tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestSpeedN2
	updated, err := ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command: tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetSpeed,
				Speed:   &speed,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := updated.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		response.Speed != 2 || !response.Drained || verifier.lastCommand != "speed" {
		t.Fatalf("updated response = %#v, want speed 2", updated)
	}

	paused, err := ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command: tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandPause,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := paused.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		!response.Paused || verifier.lastCommand != "paused" {
		t.Fatalf("paused response = %#v", paused)
	}
	resumed, err := ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command: tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandResume,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := resumed.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		response.Paused || verifier.lastCommand != "paused" {
		t.Fatalf("resumed response = %#v", resumed)
	}

	fastForward := tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestTimingModeFastForward
	timing, err := ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command:    tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetTimingMode,
				TimingMode: &fastForward,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := timing.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		response.TimingMode != tuttigenerated.AgentSessionReplayTransportPlaybackTimingModeFastForward ||
		verifier.lastCommand != "timing" {
		t.Fatalf("timing response = %#v", timing)
	}
	realtime := tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestTimingModeRealtime
	timing, err = ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command:    tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetTimingMode,
				TimingMode: &realtime,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := timing.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse); !ok ||
		response.TimingMode != tuttigenerated.AgentSessionReplayTransportPlaybackTimingModeRealtime ||
		verifier.lastCommand != "timing" {
		t.Fatalf("timing response = %#v", timing)
	}

	invalid, err := ready.UpdateAgentSessionReplayTransportPlayback(
		context.Background(),
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject{
			Body: &tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest{
				Command: tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandPause,
				Speed:   &speed,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := invalid.(tuttigenerated.UpdateAgentSessionReplayTransportPlayback400JSONResponse); !ok {
		t.Fatalf("invalid response = %T, want 400", invalid)
	}
}

func TestListAgentSessionCassettesScopesAndMapsCatalogEntries(t *testing.T) {
	const workspaceID = "934219f8-5fa2-4d28-aaf0-420a73d45847"
	service := &replayCassetteListServiceStub{
		cassettes: []agentsessionreplay.Cassette{{
			ID:                 "277377ed-af34-454f-a8b9-1047b4064e74",
			Name:               "checkout regression",
			SourceRecordingID:  "54f46b5c-34e5-40e2-8147-361bb0d046dc",
			ScopeID:            workspaceID,
			AgentTargetID:      "local:codex",
			RootAgentSessionID: "session-1",
			Mode:               agentsessionreplay.ScenarioModeCreateSession,
			TotalBytes:         42,
			CreatedAtUnixMS:    123,
		}},
	}
	response, err := (DaemonAPI{
		AgentSessionRecordingService: service,
	}).ListAgentSessionCassettes(
		context.Background(),
		tuttigenerated.ListAgentSessionCassettesRequestObject{
			WorkspaceID: workspaceID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	listed, ok := response.(tuttigenerated.ListAgentSessionCassettes200JSONResponse)
	if !ok || len(listed.Cassettes) != 1 {
		t.Fatalf("response = %#v, want one cassette", response)
	}
	if service.workspaceID != workspaceID ||
		listed.Cassettes[0].Name != "checkout regression" ||
		listed.Cassettes[0].WorkspaceId != workspaceID ||
		listed.Cassettes[0].TotalBytes != 42 {
		t.Fatalf("workspace=%q cassette=%#v", service.workspaceID, listed.Cassettes[0])
	}
}

func TestAgentSessionReplayRunCheckpointAndCancelStayWorkspaceScoped(t *testing.T) {
	const workspaceID = "934219f8-5fa2-4d28-aaf0-420a73d45847"
	runID := uuid.MustParse("f7da3c5f-c900-46c1-b1d4-9111f263af06")
	service := &replayRunControlServiceStub{
		run: agentsessionreplay.ReplayRun{
			ID:              runID.String(),
			CassetteID:      "277377ed-af34-454f-a8b9-1047b4064e74",
			Status:          agentsessionreplay.ReplayRunStatusRunning,
			CreatedAtUnixMS: 1,
			UpdatedAtUnixMS: 1,
		},
		cassette: agentsessionreplay.Cassette{ScopeID: workspaceID},
	}
	api := DaemonAPI{AgentSessionRecordingService: service}
	advanced, err := api.AdvanceAgentSessionReplayRunCheckpoint(
		context.Background(),
		tuttigenerated.AdvanceAgentSessionReplayRunCheckpointRequestObject{
			WorkspaceID: workspaceID,
			RunID:       runID,
			Body: &tuttigenerated.AdvanceAgentSessionReplayRunCheckpointRequest{
				Checkpoint: 2,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := advanced.(tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint200JSONResponse); !ok ||
		response.Checkpoint != 2 || service.advancedCheckpoint != 2 {
		t.Fatalf("advanced response=%#v checkpoint=%d", advanced, service.advancedCheckpoint)
	}

	canceled, err := api.CancelAgentSessionReplayRun(
		context.Background(),
		tuttigenerated.CancelAgentSessionReplayRunRequestObject{
			WorkspaceID: workspaceID,
			RunID:       runID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := canceled.(tuttigenerated.CancelAgentSessionReplayRun200JSONResponse); !ok ||
		response.Status != tuttigenerated.AgentSessionReplayRunStatusCanceled ||
		!service.canceled {
		t.Fatalf("canceled response=%#v canceled=%v", canceled, service.canceled)
	}

	invalid, err := api.AdvanceAgentSessionReplayRunCheckpoint(
		context.Background(),
		tuttigenerated.AdvanceAgentSessionReplayRunCheckpointRequestObject{
			WorkspaceID: workspaceID,
			RunID:       runID,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := invalid.(tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint400JSONResponse); !ok {
		t.Fatalf("invalid response=%T, want 400", invalid)
	}
}
