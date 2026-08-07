package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"sort"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

// SessionReplayProcessRegistration binds one Replay Cassette and root Session to
// one immutable process Cassette. Registrations are fixed when the transport
// is constructed.
type SessionReplayProcessRegistration struct {
	CassetteID         string
	RootAgentSessionID string
	CassetteDirectory  string
}

// SessionReplayProcessTransport routes each provider process launch to the
// ReplayProcessTransport registered for its root Session.
type SessionReplayProcessTransport struct {
	playersByCassetteID       map[string]*ReplayProcessTransport
	cassetteIDByRootSessionID map[string]string
}

func NewSessionReplayProcessTransport(
	registrations []SessionReplayProcessRegistration,
) (*SessionReplayProcessTransport, error) {
	if len(registrations) == 0 {
		return nil, errors.New("session replay process transport requires at least one registration")
	}

	playersByCassetteID := make(map[string]*ReplayProcessTransport, len(registrations))
	cassetteIDByRootSessionID := make(map[string]string, len(registrations))
	normalized := make([]SessionReplayProcessRegistration, 0, len(registrations))
	for _, registration := range registrations {
		cassetteID := normalizeProcessCassetteIdentity(registration.CassetteID)
		rootID := normalizeProcessCassetteIdentity(registration.RootAgentSessionID)
		if cassetteID == "" || rootID == "" || registration.CassetteDirectory == "" {
			return nil, errors.New("session replay process registration requires cassette, root Session, and Cassette directory")
		}
		if _, exists := playersByCassetteID[cassetteID]; exists {
			return nil, fmt.Errorf("duplicate session replay cassette %q", cassetteID)
		}
		if existingCassetteID, exists := cassetteIDByRootSessionID[rootID]; exists {
			return nil, fmt.Errorf(
				"duplicate session replay root Session %q for cassettes %q and %q",
				rootID,
				existingCassetteID,
				cassetteID,
			)
		}
		playersByCassetteID[cassetteID] = nil
		cassetteIDByRootSessionID[rootID] = cassetteID
		normalized = append(normalized, SessionReplayProcessRegistration{
			CassetteID:         cassetteID,
			RootAgentSessionID: rootID,
			CassetteDirectory:  registration.CassetteDirectory,
		})
	}

	for _, registration := range normalized {
		player, err := NewReplayProcessTransport(registration.CassetteDirectory)
		if err != nil {
			return nil, fmt.Errorf(
				"load process Cassette for replay cassette %q: %w",
				registration.CassetteID,
				err,
			)
		}
		playersByCassetteID[registration.CassetteID] = player
	}
	return &SessionReplayProcessTransport{
		playersByCassetteID:       playersByCassetteID,
		cassetteIDByRootSessionID: cassetteIDByRootSessionID,
	}, nil
}

func (t *SessionReplayProcessTransport) Start(
	ctx context.Context,
	spec ProcessSpec,
) (ProcessConnection, error) {
	if t == nil {
		return nil, errors.New("session replay process transport is unavailable")
	}
	rootID := rootProcessSessionID(spec)
	cassetteID, ok := t.cassetteIDByRootSessionID[rootID]
	if !ok {
		return nil, fmt.Errorf(
			"session replay process transport has no registered root Session %q",
			rootID,
		)
	}
	return t.playersByCassetteID[cassetteID].Start(ctx, spec)
}

func (t *SessionReplayProcessTransport) ReplayPlaybackState(
	cassetteID string,
) (ReplayPlaybackState, error) {
	player, err := t.player(cassetteID)
	if err != nil {
		return ReplayPlaybackState{}, err
	}
	return player.ReplayPlaybackState(), nil
}

func (t *SessionReplayProcessTransport) ReplayFailure(cassetteID string) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.ReplayFailure()
}

func (t *SessionReplayProcessTransport) SetReplayPlaybackSpeed(
	cassetteID string,
	speed float64,
) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.SetReplayPlaybackSpeed(speed)
}

func (t *SessionReplayProcessTransport) PauseReplayPlayback(cassetteID string) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.PauseReplayPlayback()
}

func (t *SessionReplayProcessTransport) ResumeReplayPlayback(cassetteID string) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.ResumeReplayPlayback()
}

func (t *SessionReplayProcessTransport) SetReplayPlaybackFastForward(
	cassetteID string,
	enabled bool,
) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.SetReplayPlaybackFastForward(enabled)
}

func (t *SessionReplayProcessTransport) SetReplayProviderCursor(
	cassetteID string,
	targets []sessionreplay.ProviderUnitPosition,
) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.SetReplayProviderCursor(targets)
}

func (t *SessionReplayProcessTransport) ClearReplayProviderCursor(
	cassetteID string,
) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	player.ClearReplayProviderCursor()
	return nil
}

func (t *SessionReplayProcessTransport) ReplayProviderCursor(
	cassetteID string,
) (map[string]sessionreplay.ProviderUnitPosition, error) {
	player, err := t.player(cassetteID)
	if err != nil {
		return nil, err
	}
	return player.ReplayProviderCursor(), nil
}

func (t *SessionReplayProcessTransport) VerifyComplete(cassetteID string) error {
	player, err := t.player(cassetteID)
	if err != nil {
		return err
	}
	return player.VerifyComplete()
}

func (t *SessionReplayProcessTransport) Finalize() error {
	if t == nil {
		return nil
	}
	cassetteIDs := make([]string, 0, len(t.playersByCassetteID))
	for cassetteID := range t.playersByCassetteID {
		cassetteIDs = append(cassetteIDs, cassetteID)
	}
	sort.Strings(cassetteIDs)
	var result error
	for _, cassetteID := range cassetteIDs {
		if err := t.playersByCassetteID[cassetteID].Finalize(); err != nil {
			result = errors.Join(result, fmt.Errorf("finalize replay cassette %q: %w", cassetteID, err))
		}
	}
	return result
}

func (t *SessionReplayProcessTransport) player(
	cassetteID string,
) (*ReplayProcessTransport, error) {
	if t == nil {
		return nil, errors.New("session replay process transport is unavailable")
	}
	cassetteID = normalizeProcessCassetteIdentity(cassetteID)
	player, ok := t.playersByCassetteID[cassetteID]
	if !ok {
		return nil, fmt.Errorf("session replay process transport has no registered cassette %q", cassetteID)
	}
	return player, nil
}
