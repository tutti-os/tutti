package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const (
	agentCassetteModeEnv = "TUTTI_AGENT_CASSETTE_MODE"
	agentCassettePathEnv = "TUTTI_AGENT_CASSETTE_PATH"

	agentCassetteModeRecord = "record"
	agentCassetteModeReplay = "replay"
)

func buildAgentProcessTransport() (agentdaemon.ProcessTransport, error) {
	return newAgentProcessTransport(
		strings.TrimSpace(os.Getenv(agentCassetteModeEnv)),
		strings.TrimSpace(os.Getenv(agentCassettePathEnv)),
		agentdaemon.NewLocalProcessTransport(),
	)
}

func agentCassetteReplayActive() bool {
	return strings.TrimSpace(os.Getenv(agentCassetteModeEnv)) == agentCassetteModeReplay
}

func buildSessionRecordingProcessTransport() (*agentdaemon.SessionRecordingProcessTransport, error) {
	base, err := buildAgentProcessTransport()
	if err != nil {
		return nil, fmt.Errorf("create agent process transport: %w", err)
	}
	transport, err := agentdaemon.NewSessionRecordingProcessTransport(base)
	if err != nil {
		return nil, fmt.Errorf("create agent session recording transport: %w", err)
	}
	return transport, nil
}

func newAgentProcessTransport(
	mode string,
	cassettePath string,
	local agentdaemon.ProcessTransport,
) (agentdaemon.ProcessTransport, error) {
	if local == nil {
		return nil, errors.New("local agent process transport is required")
	}
	switch mode {
	case "":
		return local, nil
	case agentCassetteModeRecord:
		if cassettePath == "" {
			return nil, fmt.Errorf("%s is required in record mode", agentCassettePathEnv)
		}
		recording, err := agentdaemon.NewRecordingProcessTransport(local, cassettePath)
		if err != nil {
			return nil, err
		}
		return &agentSessionCassetteTransport{
			fallback: local,
			session:  recording,
			finalize: recording.Finalize,
		}, nil
	case agentCassetteModeReplay:
		if cassettePath == "" {
			return nil, fmt.Errorf("%s is required in replay mode", agentCassettePathEnv)
		}
		replay, err := agentdaemon.NewReplayProcessTransport(cassettePath)
		if err != nil {
			return nil, err
		}
		return &agentSessionCassetteTransport{
			session:  replay,
			finalize: replay.Finalize,
		}, nil
	default:
		return nil, fmt.Errorf(
			"unsupported %s value %q; want %q or %q",
			agentCassetteModeEnv,
			mode,
			agentCassetteModeRecord,
			agentCassetteModeReplay,
		)
	}
}

type agentSessionCassetteTransport struct {
	fallback agentdaemon.ProcessTransport
	session  agentdaemon.ProcessTransport
	finalize func() error
}

func (t *agentSessionCassetteTransport) Start(
	ctx context.Context,
	spec agentruntime.ProcessSpec,
) (agentruntime.ProcessConnection, error) {
	if strings.TrimSpace(spec.AgentSessionID) == "" {
		if t.fallback == nil {
			return nil, errors.New("replay composition rejected a non-session process launch")
		}
		return t.fallback.Start(ctx, spec)
	}
	return t.session.Start(ctx, spec)
}

func (t *agentSessionCassetteTransport) Finalize() error {
	if t == nil || t.finalize == nil {
		return nil
	}
	return t.finalize()
}

func (t *agentSessionCassetteTransport) ReplayPlaybackState() agentruntime.ReplayPlaybackState {
	controller, ok := t.session.(interface {
		ReplayPlaybackState() agentruntime.ReplayPlaybackState
	})
	if !ok {
		return agentruntime.ReplayPlaybackState{}
	}
	return controller.ReplayPlaybackState()
}

func (t *agentSessionCassetteTransport) SetReplayPlaybackSpeed(speed float64) error {
	controller, ok := t.session.(interface {
		SetReplayPlaybackSpeed(float64) error
	})
	if !ok {
		return agentruntime.ErrReplayPlaybackUnavailable
	}
	return controller.SetReplayPlaybackSpeed(speed)
}

func (t *agentSessionCassetteTransport) PauseReplayPlayback() error {
	controller, ok := t.session.(interface {
		PauseReplayPlayback() error
	})
	if !ok {
		return agentruntime.ErrReplayPlaybackUnavailable
	}
	return controller.PauseReplayPlayback()
}

func (t *agentSessionCassetteTransport) ResumeReplayPlayback() error {
	controller, ok := t.session.(interface {
		ResumeReplayPlayback() error
	})
	if !ok {
		return agentruntime.ErrReplayPlaybackUnavailable
	}
	return controller.ResumeReplayPlayback()
}

func (t *agentSessionCassetteTransport) SetReplayPlaybackFastForward(enabled bool) error {
	controller, ok := t.session.(interface {
		SetReplayPlaybackFastForward(bool) error
	})
	if !ok {
		return agentruntime.ErrReplayPlaybackUnavailable
	}
	return controller.SetReplayPlaybackFastForward(enabled)
}
