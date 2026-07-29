package main

import (
	"context"
	"errors"
	"strings"
	"time"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
	tuttiagentservice "github.com/tutti-os/tutti/services/tuttid/service/tuttiagent"
)

// replayProviderAvailabilityChecker is part of the isolated replay
// composition. Cassette playback must not probe installed CLIs, adapters, or
// credentials on the host machine.
type replayProviderAvailabilityChecker struct{}

type agentReplayTransportVerifier struct {
	enabled   bool
	transport interface {
		Finalize() error
		ReplayPlaybackState() (agentdaemon.ReplayPlaybackState, error)
		SetReplayPlaybackSpeed(float64) error
		PauseReplayPlayback() error
		ResumeReplayPlayback() error
		SetReplayPlaybackFastForward(bool) error
	}
}

func (v agentReplayTransportVerifier) Verify(context.Context) error {
	if !v.enabled || v.transport == nil {
		return errors.New("agent session replay transport verification is unavailable")
	}
	return v.transport.Finalize()
}

func (v agentReplayTransportVerifier) PlaybackState(
	context.Context,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	state, err := v.transport.ReplayPlaybackState()
	return replayPlaybackState(state), err
}

func (v agentReplayTransportVerifier) SetPlaybackSpeed(
	_ context.Context,
	speed float64,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.SetReplayPlaybackSpeed(speed); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState()
	return replayPlaybackState(state), err
}

func (v agentReplayTransportVerifier) SetPlaybackPaused(
	_ context.Context,
	paused bool,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	var err error
	if paused {
		err = v.transport.PauseReplayPlayback()
	} else {
		err = v.transport.ResumeReplayPlayback()
	}
	if err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState()
	return replayPlaybackState(state), err
}

func (v agentReplayTransportVerifier) SetPlaybackFastForward(
	_ context.Context,
	enabled bool,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.SetReplayPlaybackFastForward(enabled); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState()
	return replayPlaybackState(state), err
}

func replayPlaybackState(
	state agentdaemon.ReplayPlaybackState,
) tuttiapi.AgentSessionReplayPlaybackState {
	return tuttiapi.AgentSessionReplayPlaybackState{
		Speed:             state.Speed,
		PlaybackElapsedMS: state.PlaybackElapsedMS,
		Drained:           state.Drained,
		Paused:            state.Paused,
		FastForward:       state.FastForward,
	}
}

func agentProviderCommandResolver(
	status *agentstatusservice.Service,
) agentdaemon.ProviderCommandResolver {
	return func(ctx context.Context, provider string) (agentdaemon.ProviderCommand, error) {
		resolved, err := status.ResolveProviderCommand(ctx, provider)
		if err != nil {
			return agentdaemon.ProviderCommand{}, err
		}
		return agentdaemon.ProviderCommand{Command: resolved.Command, Env: resolved.Env}, nil
	}
}

func applyAgentReplayRuntimeComposition(
	config agentdaemon.Config,
	replay bool,
) agentdaemon.Config {
	if replay {
		config.AdapterResolver = nil
		config.ProviderCommandResolver = nil
	}
	return config
}

func startProviderAuthWatcher(
	replay bool,
	onChange func([]string),
) *agentservice.ProviderAuthWatcher {
	if replay {
		return nil
	}
	watcher := &agentservice.ProviderAuthWatcher{
		Entries:  agentservice.DefaultProviderAuthWatchEntries(),
		OnChange: onChange,
	}
	watcher.Start()
	return watcher
}

func configureReplayAwareTuttiAgentReadiness(
	replay bool,
	account *accountservice.Service,
	status *agentstatusservice.Service,
	targets agenttargetservice.Service,
) *tuttiagentservice.ReadinessCoordinator {
	readiness := tuttiagentservice.NewReadinessCoordinator(status, targets)
	if replay {
		return readiness
	}
	account.OnLoginCompleted = func(context.Context) {
		readiness.Trigger("account_login_completed")
	}
	// A completed Account logout is the only automatic source authorized to
	// delete and revoke the durable Tutti Agent credential.
	account.OnLogoutCompleted = func(ctx context.Context) {
		tuttiagentservice.LogoutTuttiAgentUserAuth(ctx)
	}
	readiness.Trigger("daemon_started")
	return readiness
}

func (replayProviderAvailabilityChecker) ListProviderAvailability(
	_ context.Context,
	providers []string,
) ([]agentservice.ProviderAvailability, error) {
	now := time.Now().UTC()
	result := make([]agentservice.ProviderAvailability, 0, len(providers))
	for _, provider := range providers {
		result = append(result, agentservice.ProviderAvailability{
			Provider:   strings.TrimSpace(provider),
			Status:     agentservice.ProviderAvailabilityAvailable,
			CapturedAt: now,
		})
	}
	return result, nil
}
