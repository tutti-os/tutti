package main

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
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

// replayAgentProviderStatusService keeps status reads inside the isolated
// composition. Replay capability comes from the cassette registry, not from
// installed CLIs, adapters, or credentials on the host machine.
type replayAgentProviderStatusService struct{}

func replayAgentProviderStatusAPI(
	replayComposition bool,
	live tuttiapi.AgentProviderStatusService,
) tuttiapi.AgentProviderStatusService {
	if replayComposition {
		return replayAgentProviderStatusService{}
	}
	return live
}

type agentReplayTransportVerifier struct {
	enabled          bool
	verifyState      func(context.Context, string) error
	verifyCheckpoint func(
		context.Context,
		string,
		int,
	) (tuttiapi.AgentSessionReplayCheckpointState, error)
	transport interface {
		Finalize() error
		ReplayPlaybackState(string) (agentdaemon.ReplayPlaybackState, error)
		SetReplayPlaybackSpeed(string, float64) error
		PauseReplayPlayback(string) error
		ResumeReplayPlayback(string) error
		SetReplayPlaybackFastForward(string, bool) error
		SetReplayProviderCursor(string, []sessionreplay.ProviderUnitPosition) error
		ClearReplayProviderCursor(string) error
		ReplayProviderCursor(string) (map[string]sessionreplay.ProviderUnitPosition, error)
		VerifyComplete(string) error
	}
}

func (v agentReplayTransportVerifier) VerifyCheckpoint(
	ctx context.Context,
	cassetteID string,
	checkpointIndex int,
) (tuttiapi.AgentSessionReplayCheckpointState, error) {
	if !v.enabled || v.verifyCheckpoint == nil {
		return tuttiapi.AgentSessionReplayCheckpointState{},
			errors.New(
				"agent session replay checkpoint verification is unavailable",
			)
	}
	return v.verifyCheckpoint(ctx, cassetteID, checkpointIndex)
}

func (v agentReplayTransportVerifier) SetProviderCursor(
	_ context.Context,
	cassetteID string,
	targets []sessionreplay.ProviderUnitPosition,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.SetReplayProviderCursor(cassetteID, targets); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	return v.PlaybackState(context.Background(), cassetteID)
}

func (v agentReplayTransportVerifier) ClearProviderCursor(
	_ context.Context,
	cassetteID string,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.ClearReplayProviderCursor(cassetteID); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	return v.PlaybackState(context.Background(), cassetteID)
}

func (v agentReplayTransportVerifier) Verify(ctx context.Context, cassetteID string) error {
	if !v.enabled || v.transport == nil {
		return errors.New("agent session replay transport verification is unavailable")
	}
	if err := v.transport.VerifyComplete(cassetteID); err != nil {
		return err
	}
	if v.verifyState == nil {
		return errors.New("agent session replay semantic verification is unavailable")
	}
	return v.verifyState(ctx, cassetteID)
}

func (v agentReplayTransportVerifier) PlaybackState(
	_ context.Context,
	cassetteID string,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	state, err := v.transport.ReplayPlaybackState(cassetteID)
	result := replayPlaybackState(state)
	if err != nil {
		return result, err
	}
	inputPositions, err := v.transport.ReplayProviderCursor(cassetteID)
	if err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	connectionIDs := make([]string, 0, len(inputPositions))
	for connectionID := range inputPositions {
		connectionIDs = append(connectionIDs, connectionID)
	}
	sort.Strings(connectionIDs)
	for _, connectionID := range connectionIDs {
		result.ProviderConnections = append(
			result.ProviderConnections,
			inputPositions[connectionID],
		)
	}
	return result, nil
}

func (v agentReplayTransportVerifier) SetPlaybackSpeed(
	_ context.Context,
	cassetteID string,
	speed float64,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.SetReplayPlaybackSpeed(cassetteID, speed); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState(cassetteID)
	return replayPlaybackState(state), err
}

func (v agentReplayTransportVerifier) SetPlaybackPaused(
	_ context.Context,
	cassetteID string,
	paused bool,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	var err error
	if paused {
		err = v.transport.PauseReplayPlayback(cassetteID)
	} else {
		err = v.transport.ResumeReplayPlayback(cassetteID)
	}
	if err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState(cassetteID)
	return replayPlaybackState(state), err
}

func (v agentReplayTransportVerifier) SetPlaybackFastForward(
	_ context.Context,
	cassetteID string,
	enabled bool,
) (tuttiapi.AgentSessionReplayPlaybackState, error) {
	if !v.enabled || v.transport == nil {
		return tuttiapi.AgentSessionReplayPlaybackState{},
			errors.New("agent session replay transport playback is unavailable")
	}
	if err := v.transport.SetReplayPlaybackFastForward(cassetteID, enabled); err != nil {
		return tuttiapi.AgentSessionReplayPlaybackState{}, err
	}
	state, err := v.transport.ReplayPlaybackState(cassetteID)
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
	onChangeDetailed func([]agentservice.ProviderAuthChange),
) *agentservice.ProviderAuthWatcher {
	if replay {
		return nil
	}
	watcher := &agentservice.ProviderAuthWatcher{
		Entries:          agentservice.DefaultProviderAuthWatchEntries(),
		OnChange:         onChange,
		OnChangeDetailed: onChangeDetailed,
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

func (replayAgentProviderStatusService) List(
	_ context.Context,
	input agentstatusservice.ListInput,
) (agentstatusservice.Snapshot, error) {
	providers := append([]string(nil), input.Providers...)
	if len(providers) == 0 {
		providers = []string{"codex", "claude-code"}
	}
	now := time.Now().UTC()
	statuses := make([]agentstatusservice.ProviderStatus, 0, len(providers))
	for _, provider := range providers {
		provider = strings.TrimSpace(provider)
		availability := agentstatusservice.AvailabilityUnsupported
		reasonCode := "replay_provider_unsupported"
		installed := false
		auth := agentstatusservice.AuthUnknown
		if _, ok := sessionreplay.FindProviderReplayByProvider(provider); ok {
			availability = agentstatusservice.AvailabilityReady
			reasonCode = ""
			installed = true
			auth = agentstatusservice.AuthAuthenticated
		}
		statuses = append(statuses, agentstatusservice.ProviderStatus{
			Provider: provider,
			Availability: agentstatusservice.Availability{
				Status: availability, ReasonCode: reasonCode, CheckedAt: &now,
			},
			CLI:     agentstatusservice.CLIStatus{Installed: installed},
			Adapter: agentstatusservice.AdapterStatus{Installed: installed},
			Auth:    agentstatusservice.AuthInfo{Status: auth},
			Update: agentstatusservice.UpdateStatus{
				Capability:        agentstatusservice.UpdateCapabilityUnsupported,
				UnsupportedReason: "agent session replay composition",
			},
		})
	}
	return agentstatusservice.Snapshot{CapturedAt: now, Providers: statuses}, nil
}

func (replayAgentProviderStatusService) Probe(
	_ context.Context,
	input agentstatusservice.ProbeInput,
) (agentstatusservice.ProbeResult, error) {
	provider := strings.TrimSpace(input.Provider)
	if _, ok := sessionreplay.FindProviderReplayByProvider(provider); !ok {
		return agentstatusservice.ProbeResult{}, agentstatusservice.ErrInvalidProvider
	}
	return agentstatusservice.ProbeResult{
		Provider:      provider,
		Status:        agentstatusservice.ProbeSkipped,
		CheckedAt:     time.Now().UTC(),
		ReasonCode:    "agent_session_replay",
		ProtocolReady: true,
	}, nil
}

func (replayAgentProviderStatusService) RunAction(
	context.Context,
	agentstatusservice.RunActionInput,
) (agentstatusservice.RunActionResult, error) {
	return agentstatusservice.RunActionResult{}, agentstatusservice.ErrInvalidAction
}

func (replayAgentProviderStatusService) GetCodexRuntimeCatalog(
	context.Context,
	string,
) (agentstatusservice.CodexRuntimeCatalog, error) {
	return agentstatusservice.CodexRuntimeCatalog{}, agentstatusservice.ErrInvalidProvider
}

func (replayAgentProviderStatusService) SetCodexRuntimeSelection(
	context.Context,
	agentstatusservice.SetCodexRuntimeSelectionInput,
) (agentstatusservice.CodexRuntimeCatalog, error) {
	return agentstatusservice.CodexRuntimeCatalog{}, agentstatusservice.ErrInvalidProvider
}

func (replayAgentProviderStatusService) DiscoverManagedProviderUpdates(context.Context) error {
	return nil
}
