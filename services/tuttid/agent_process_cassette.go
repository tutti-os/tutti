package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	agentCassetteModeEnv               = "TUTTI_AGENT_CASSETTE_MODE"
	agentCassettePathEnv               = "TUTTI_AGENT_CASSETTE_PATH"
	agentSessionReplayRegistrationsEnv = "TUTTI_AGENT_SESSION_REPLAY_REGISTRATIONS"

	agentCassetteModeRecord = "record"
	agentCassetteModeReplay = "replay"
)

type agentProcessComposition struct {
	transport           agentdaemon.ProcessTransport
	recorder            *agentdaemon.SessionRecordingProcessTransport
	replay              *agentdaemon.SessionReplayProcessTransport
	replayRegistrations []agentSessionReplayRegistration
	replayModelCatalog  agentservice.AgentModelCatalog
}

type agentSessionReplayRegistration struct {
	CassetteID         string   `json:"cassetteId"`
	RootAgentSessionID string   `json:"rootAgentSessionId"`
	CassetteDirectory  string   `json:"cassetteDirectory"`
	ArtifactDirectory  string   `json:"artifactDirectory"`
	WorkspaceID        string   `json:"workspaceId"`
	Providers          []string `json:"providers"`
	FrozenModel        string   `json:"frozenModel"`
}

func replayAgentModelCatalog(
	replayComposition bool,
	composition agentProcessComposition,
	normalCatalog agentservice.AgentModelCatalog,
) agentservice.AgentModelCatalog {
	if replayComposition && composition.replayModelCatalog != nil {
		return composition.replayModelCatalog
	}
	return normalCatalog
}

func buildAgentProcessComposition(
	sessionRecordingEnabled bool,
) (agentProcessComposition, error) {
	mode := strings.TrimSpace(os.Getenv(agentCassetteModeEnv))
	if mode == agentCassetteModeReplay {
		var registrations []agentSessionReplayRegistration
		if err := json.Unmarshal(
			[]byte(strings.TrimSpace(os.Getenv(agentSessionReplayRegistrationsEnv))),
			&registrations,
		); err != nil {
			return agentProcessComposition{}, fmt.Errorf(
				"decode %s: %w",
				agentSessionReplayRegistrationsEnv,
				err,
			)
		}
		transportRegistrations := make(
			[]agentdaemon.SessionReplayProcessRegistration,
			0,
			len(registrations),
		)
		for _, registration := range registrations {
			transportRegistrations = append(
				transportRegistrations,
				agentdaemon.SessionReplayProcessRegistration{
					CassetteID:         registration.CassetteID,
					RootAgentSessionID: registration.RootAgentSessionID,
					CassetteDirectory:  registration.CassetteDirectory,
				},
			)
		}
		frozenModels := make(map[string][]string)
		for _, registration := range registrations {
			model := strings.TrimSpace(registration.FrozenModel)
			if model == "" {
				continue
			}
			for _, provider := range registration.Providers {
				provider = strings.TrimSpace(provider)
				if provider == "" {
					continue
				}
				frozenModels[provider] = append(frozenModels[provider], model)
			}
		}
		replay, err := agentdaemon.NewSessionReplayProcessTransport(transportRegistrations)
		if err != nil {
			return agentProcessComposition{}, fmt.Errorf(
				"create Agent Session Replay transport: %w",
				err,
			)
		}
		return agentProcessComposition{
			transport: &agentReplayProviderHomeTransport{
				base: replay, stateDir: tuttitypes.DefaultStateDir(),
			},
			replay: replay, replayRegistrations: registrations,
			replayModelCatalog: agentservice.NewFrozenAgentModelCatalog(frozenModels),
		}, nil
	}
	if !sessionRecordingEnabled {
		transport, err := buildAgentProcessTransport()
		if err != nil {
			return agentProcessComposition{}, err
		}
		return agentProcessComposition{transport: transport}, nil
	}
	recorder, err := buildSessionRecordingProcessTransport()
	if err != nil {
		return agentProcessComposition{}, err
	}
	return agentProcessComposition{transport: recorder, recorder: recorder}, nil
}

type agentReplayProviderHomeTransport struct {
	base     agentdaemon.ProcessTransport
	stateDir string
}

func (t *agentReplayProviderHomeTransport) Start(
	ctx context.Context,
	spec agentruntime.ProcessSpec,
) (agentruntime.ProcessConnection, error) {
	if t == nil || t.base == nil {
		return nil, errors.New("agent session replay process transport is unavailable")
	}
	descriptor, found := sessionreplay.FindProviderReplayByProvider(spec.Provider)
	if found && len(descriptor.PortableRuntime.HomeEnvVars) > 0 {
		sessionID := strings.TrimSpace(spec.AgentSessionID)
		if sessionID == "" || filepath.Base(sessionID) != sessionID ||
			strings.ContainsAny(sessionID, `/\\`) {
			return nil, errors.New("agent session replay Provider home requires a safe Session identity")
		}
		stateDir := filepath.Clean(strings.TrimSpace(t.stateDir))
		if stateDir == "." || !filepath.IsAbs(stateDir) {
			return nil, errors.New("agent session replay state directory must be absolute")
		}
		homeDirectory := strings.TrimSpace(
			descriptor.PortableRuntime.SessionHomeDirectory,
		)
		if homeDirectory == "" || filepath.Base(homeDirectory) != homeDirectory ||
			strings.ContainsAny(homeDirectory, `/\\`) {
			return nil, errors.New("agent session replay Provider home directory is invalid")
		}
		home := filepath.Join(stateDir, "agent", "runs", sessionID, homeDirectory)
		for _, name := range descriptor.PortableRuntime.HomeEnvVars {
			name = strings.TrimSpace(name)
			if name == "" {
				return nil, errors.New("agent session replay Provider home environment is invalid")
			}
			spec.Env = replaceProcessEnv(spec.Env, name, home)
		}
	}
	return t.base.Start(ctx, spec)
}

func (t *agentReplayProviderHomeTransport) TracksProviderInputUnits() bool {
	if t == nil {
		return false
	}
	tracking, ok := t.base.(agentruntime.ProviderInputUnitTrackingTransport)
	return ok && tracking.TracksProviderInputUnits()
}

func replaceProcessEnv(env []string, key, value string) []string {
	result := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, found := strings.Cut(entry, "=")
		if found && strings.EqualFold(strings.TrimSpace(name), key) {
			continue
		}
		result = append(result, entry)
	}
	return append(result, key+"="+value)
}

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

func (t *agentSessionCassetteTransport) TracksProviderInputUnits() bool {
	if t == nil {
		return false
	}
	tracking, ok := t.session.(agentruntime.ProviderInputUnitTrackingTransport)
	return ok && tracking.TracksProviderInputUnits()
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
