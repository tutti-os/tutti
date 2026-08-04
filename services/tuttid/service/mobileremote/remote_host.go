package mobileremote

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	authenticatedlink "github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/linkmanager"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

const (
	defaultRemotePollInterval = 2 * time.Second
	remoteCallerSettleDelay   = 6 * time.Second
	deviceLinkProtocolVersion = 2
	mobileRemoteRelayDriver   = "mobile-remote"
)

type activeRemoteAttempt struct {
	pairingID  string
	cancel     context.CancelFunc
	generation uint64
}

type remoteLinkMetadata struct {
	pairingID  string
	handler    http.Handler
	liveEvents AgentLiveEventSource
}

type remoteManagedLink struct {
	connectionID string
}

type remoteHostState struct {
	mu sync.Mutex

	cancel               context.CancelFunc
	stopping             bool
	stopDone             chan struct{}
	handler              http.Handler
	liveEvents           AgentLiveEventSource
	attempts             map[string]activeRemoteAttempt
	registeredSession    string
	registeredDevice     RegisteredDevice
	registerAfter        time.Time
	nextGeneration       uint64
	linkManager          *linkmanager.Manager[string, remoteLinkMetadata]
	managedLinks         map[string]remoteManagedLink
	observedLinkEvents   map[string]uint64
	relayOwnerAcquired   bool
	remoteHostGeneration uint64
	activePairings       map[string]struct{}
}

func (s *Service) StartRemoteHost(handler http.Handler) {
	if s == nil || handler == nil {
		return
	}
	for {
		s.remoteHost.mu.Lock()
		if s.remoteHost.stopping {
			done := s.remoteHost.stopDone
			s.remoteHost.mu.Unlock()
			<-done
			continue
		}
		if s.remoteHost.cancel != nil {
			s.remoteHost.handler = handler
			s.remoteHost.liveEvents = s.AgentLiveEvents
			s.remoteHost.mu.Unlock()
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		s.remoteWG.Add(1)
		s.remoteHost.cancel = cancel
		s.remoteHost.handler = handler
		s.remoteHost.liveEvents = s.AgentLiveEvents
		s.remoteHost.attempts = make(map[string]activeRemoteAttempt)
		s.remoteHost.managedLinks = make(map[string]remoteManagedLink)
		s.remoteHost.observedLinkEvents = make(map[string]uint64)
		s.remoteHost.activePairings = make(map[string]struct{})
		s.remoteHost.linkManager = s.newRemoteLinkManager()
		s.remoteHost.remoteHostGeneration++
		remoteHostGeneration := s.remoteHost.remoteHostGeneration
		relayOwner := s.RelayOwner
		s.remoteHost.mu.Unlock()

		if relayOwner != nil {
			if err := relayOwner.Acquire(ctx, mobileRemoteRelayDriver); err == nil {
				s.remoteHost.mu.Lock()
				if s.remoteHost.remoteHostGeneration == remoteHostGeneration && !s.remoteHost.stopping {
					s.remoteHost.relayOwnerAcquired = true
					relayOwner = nil
				}
				s.remoteHost.mu.Unlock()
				if relayOwner != nil {
					_ = relayOwner.Release(mobileRemoteRelayDriver)
				}
			}
		}

		go func() {
			defer s.remoteWG.Done()
			s.runRemoteHost(ctx)
		}()
		return
	}
}

func (s *Service) Close() {
	s.StopRemoteHost()
}

func (s *Service) StopRemoteHost() {
	if s == nil {
		return
	}
	s.remoteHost.mu.Lock()
	if s.remoteHost.stopping {
		done := s.remoteHost.stopDone
		s.remoteHost.mu.Unlock()
		<-done
		return
	}
	cancel := s.remoteHost.cancel
	manager := s.remoteHost.linkManager
	if cancel == nil && manager == nil {
		s.remoteHost.mu.Unlock()
		return
	}
	done := make(chan struct{})
	s.remoteHost.stopping = true
	s.remoteHost.stopDone = done
	relayOwner := s.RelayOwner
	relayOwnerAcquired := s.remoteHost.relayOwnerAcquired
	s.remoteHost.relayOwnerAcquired = false
	for _, attempt := range s.remoteHost.attempts {
		attempt.cancel()
	}
	s.remoteHost.mu.Unlock()
	if manager != nil {
		manager.BeginQuiescence()
	}
	if cancel != nil {
		cancel()
	}
	s.remoteWG.Wait()
	if manager != nil {
		_ = manager.WaitForQuiescence(context.Background())
	}
	if relayOwnerAcquired && relayOwner != nil {
		_ = relayOwner.Release(mobileRemoteRelayDriver)
	}
	s.remoteHost.mu.Lock()
	s.remoteHost.cancel = nil
	s.remoteHost.linkManager = nil
	s.remoteHost.attempts = nil
	s.remoteHost.managedLinks = nil
	s.remoteHost.observedLinkEvents = nil
	s.remoteHost.activePairings = nil
	s.remoteHost.stopping = false
	s.remoteHost.stopDone = nil
	close(done)
	s.remoteHost.mu.Unlock()
}

func (s *Service) runRemoteHost(ctx context.Context) {
	interval := s.RemotePollInterval
	if interval <= 0 {
		interval = defaultRemotePollInterval
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.pollRemoteHost(ctx)
			timer.Reset(interval)
		}
	}
}

func (s *Service) pollRemoteHost(ctx context.Context) {
	session, identity, err := s.readyIdentity(ctx)
	if err != nil {
		s.stopRemoteAttempts(nil)
		return
	}
	s.setRemoteLinkEnabled(true)
	registered, err := s.ensureRegisteredDevice(ctx, session.SessionID, session.Cookie, identity)
	if err != nil {
		if isControlPlaneUnauthorized(err) {
			s.stopRemoteAttempts(nil)
		}
		return
	}
	pairings, err := s.ControlPlane.ListPairings(ctx, session.Cookie)
	if err != nil {
		if isControlPlaneUnauthorized(err) {
			s.stopRemoteAttempts(nil)
		}
		return
	}
	validPairings := make(map[string]struct{})
	for _, pairing := range pairings {
		if pairing.State != "active" || pairing.TargetUserDeviceID != registered.UserDeviceID {
			continue
		}
		validPairings[pairing.PairingID] = struct{}{}
		signature := ed25519.Sign(identity.PrivateKey, deviceLinkProof("list", pairing.PairingID, "", ""))
		attempts, err := s.ControlPlane.ListDeviceLinkAttempts(
			ctx, session.Cookie, pairing.PairingID, identity.DeviceID, signature,
		)
		if err != nil {
			if isControlPlaneUnauthorized(err) {
				s.stopRemoteAttempts(nil)
				return
			}
			continue
		}
		for _, attempt := range attempts {
			if attempt.State != "awaiting_owner" || attempt.OwnerDeviceID != identity.DeviceID ||
				attempt.OwnerFingerprint != "" || attempt.OwnerICE != nil {
				continue
			}
			s.startRemoteAttempt(ctx, session.Cookie, identity, pairing.PairingID, attempt)
		}
	}
	s.stopRemoteAttempts(validPairings)
}

func (s *Service) ensureRegisteredDevice(
	ctx context.Context,
	sessionID string,
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
) (RegisteredDevice, error) {
	now := s.now()
	s.remoteHost.mu.Lock()
	if strings.TrimSpace(sessionID) != "" &&
		s.remoteHost.registeredSession == sessionID &&
		s.remoteHost.registeredDevice.UserDeviceID != "" &&
		now.Before(s.remoteHost.registerAfter) {
		registered := s.remoteHost.registeredDevice
		s.remoteHost.mu.Unlock()
		return registered, nil
	}
	s.remoteHost.mu.Unlock()

	registered, err := s.registerIdentityResult(ctx, cookie, identity)
	if err != nil {
		return RegisteredDevice{}, err
	}
	s.remoteHost.mu.Lock()
	s.remoteHost.registeredSession = strings.TrimSpace(sessionID)
	s.remoteHost.registeredDevice = registered
	s.remoteHost.registerAfter = now.Add(5 * time.Minute)
	s.remoteHost.mu.Unlock()
	return registered, nil
}

func (s *Service) startRemoteAttempt(
	parent context.Context,
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
	pairingID string,
	attempt DeviceLinkAttempt,
) {
	s.remoteHost.mu.Lock()
	if s.remoteHost.stopping || s.remoteHost.cancel == nil || parent.Err() != nil {
		s.remoteHost.mu.Unlock()
		return
	}
	if _, exists := s.remoteHost.attempts[attempt.AttemptID]; exists {
		s.remoteHost.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.remoteHost.nextGeneration++
	generation := s.remoteHost.nextGeneration
	s.remoteHost.attempts[attempt.AttemptID] = activeRemoteAttempt{
		pairingID: pairingID, cancel: cancel, generation: generation,
	}
	handler := s.remoteHost.handler
	liveEvents := s.remoteHost.liveEvents
	s.remoteWG.Add(1)
	s.remoteHost.mu.Unlock()

	go func() {
		defer s.remoteWG.Done()
		defer cancel()
		defer s.finishRemoteAttempt(attempt.AttemptID, generation)
		var ok bool
		attempt, ok = s.settledRemoteAttempt(ctx, cookie, identity, pairingID, attempt)
		if !ok {
			return
		}
		s.serveRemoteAttempt(ctx, handler, liveEvents, cookie, identity, pairingID, attempt)
	}()
}

func (s *Service) finishRemoteAttempt(attemptID string, generation uint64) {
	s.remoteHost.mu.Lock()
	defer s.remoteHost.mu.Unlock()
	if current, exists := s.remoteHost.attempts[attemptID]; exists &&
		current.generation == generation {
		delete(s.remoteHost.attempts, attemptID)
	}
}

func (s *Service) stopRemotePairing(pairingID string) {
	pairingID = strings.TrimSpace(pairingID)
	s.remoteHost.mu.Lock()
	for attemptID, attempt := range s.remoteHost.attempts {
		if attempt.pairingID != pairingID {
			continue
		}
		attempt.cancel()
		delete(s.remoteHost.attempts, attemptID)
	}
	manager := s.remoteHost.linkManager
	s.remoteHost.mu.Unlock()
	if manager != nil {
		manager.Invalidate(pairingID)
	}
}

func isControlPlaneUnauthorized(err error) bool {
	var controlPlaneErr *ControlPlaneError
	return errors.As(err, &controlPlaneErr) &&
		(controlPlaneErr.StatusCode == http.StatusUnauthorized ||
			controlPlaneErr.StatusCode == http.StatusForbidden)
}

func (s *Service) settledRemoteAttempt(
	ctx context.Context,
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
	pairingID string,
	attempt DeviceLinkAttempt,
) (DeviceLinkAttempt, bool) {
	if len(attempt.STUNEndpoints) == 0 {
		return attempt, true
	}
	timer := time.NewTimer(remoteCallerSettleDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return DeviceLinkAttempt{}, false
	case <-timer.C:
	}
	signature := ed25519.Sign(identity.PrivateKey, deviceLinkProof("list", pairingID, "", ""))
	attempts, err := s.ControlPlane.ListDeviceLinkAttempts(
		ctx, cookie, pairingID, identity.DeviceID, signature,
	)
	if err != nil {
		return DeviceLinkAttempt{}, false
	}
	for _, latest := range attempts {
		if latest.AttemptID == attempt.AttemptID && latest.State == "awaiting_owner" &&
			latest.OwnerFingerprint == "" && latest.OwnerICE == nil {
			return latest, true
		}
	}
	return DeviceLinkAttempt{}, false
}

func (s *Service) serveRemoteAttempt(
	ctx context.Context,
	handler http.Handler,
	liveEvents AgentLiveEventSource,
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
	pairingID string,
	attempt DeviceLinkAttempt,
) {
	handshakeCtx := ctx
	cancelHandshake := func() {}
	if deadline, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(attempt.ExpiresAt)); err == nil {
		handshakeCtx, cancelHandshake = context.WithDeadline(ctx, deadline)
	}
	defer cancelHandshake()
	s.remoteHost.mu.Lock()
	manager := s.remoteHost.linkManager
	s.remoteHost.mu.Unlock()
	if manager == nil {
		return
	}
	admission, err := manager.Admit(handshakeCtx, pairingID)
	if err != nil {
		return
	}
	defer admission.Close()
	participant, err := authenticatedlink.NewParticipant(authenticatedlink.ParticipantConfig{
		STUNEndpoints:   append([]string(nil), attempt.STUNEndpoints...),
		IncludeLoopback: s.includeLoopback,
	})
	if err != nil {
		return
	}
	transferred := false
	defer func() {
		if !transferred {
			_ = participant.Close()
		}
	}()
	description, err := participant.LocalDescription(handshakeCtx)
	if err != nil {
		return
	}
	signature := ed25519.Sign(
		identity.PrivateKey,
		deviceLinkProof("update", pairingID, attempt.AttemptID, description.Fingerprint),
	)
	updated, err := s.ControlPlane.UpdateDeviceLinkParticipant(
		handshakeCtx, cookie, pairingID, attempt.AttemptID, identity.DeviceID,
		DeviceLinkParticipantInput{
			Fingerprint:     description.Fingerprint,
			ProtocolVersion: deviceLinkProtocolVersion,
			ICE: DeviceLinkICEParams{
				Ufrag: description.Ufrag, Pwd: description.Pwd,
				Candidates: append([]string(nil), description.Candidates...),
			},
			IdentitySignature: signature,
		},
	)
	if err != nil || updated.State != "ready" {
		return
	}
	peer := updated.CallerICE
	if peer == nil {
		return
	}
	link, err := participant.Connect(handshakeCtx, authenticatedlink.Description{
		Fingerprint: updated.CallerFingerprint,
		Ufrag:       peer.Ufrag,
		Pwd:         peer.Pwd,
		Candidates:  append([]string(nil), peer.Candidates...),
	}, authenticatedlink.RoleOwner)
	if err != nil {
		return
	}
	_, err = manager.Register(admission, linkmanager.Registration[string, remoteLinkMetadata]{
		Key:          pairingID,
		ConnectionID: attempt.AttemptID,
		Link:         link,
		Metadata: remoteLinkMetadata{
			pairingID: pairingID, handler: handler, liveEvents: liveEvents,
		},
		HandleIncoming: serveManagedRemoteStream,
	})
	transferred = true
	if err != nil {
		return
	}
	cancelHandshake()
}

func (s *Service) stopRemoteAttempts(validPairings map[string]struct{}) {
	s.remoteHost.mu.Lock()
	invalidPairingSet := make(map[string]struct{})
	for attemptID, attempt := range s.remoteHost.attempts {
		if validPairings != nil {
			if _, valid := validPairings[attempt.pairingID]; valid {
				continue
			}
		}
		attempt.cancel()
		delete(s.remoteHost.attempts, attemptID)
		invalidPairingSet[attempt.pairingID] = struct{}{}
	}
	manager := s.remoteHost.linkManager
	for pairingID := range s.remoteHost.managedLinks {
		if validPairings != nil {
			if _, valid := validPairings[pairingID]; valid {
				continue
			}
		}
		invalidPairingSet[pairingID] = struct{}{}
	}
	if validPairings == nil {
		s.remoteHost.activePairings = nil
	} else {
		s.remoteHost.activePairings = make(map[string]struct{}, len(validPairings))
		for pairingID := range validPairings {
			s.remoteHost.activePairings[pairingID] = struct{}{}
		}
	}
	if validPairings == nil {
		s.remoteHost.registeredSession = ""
		s.remoteHost.registeredDevice = RegisteredDevice{}
		s.remoteHost.registerAfter = time.Time{}
	}
	s.remoteHost.mu.Unlock()
	if manager == nil {
		return
	}
	if validPairings == nil {
		_ = manager.SetEnabled(false)
		return
	}
	for pairingID := range invalidPairingSet {
		manager.Invalidate(pairingID)
	}
}

func (s *Service) setRemoteLinkEnabled(enabled bool) {
	s.remoteHost.mu.Lock()
	manager := s.remoteHost.linkManager
	s.remoteHost.mu.Unlock()
	if manager != nil {
		_ = manager.SetEnabled(enabled)
	}
}

func (s *Service) newRemoteLinkManager() *linkmanager.Manager[string, remoteLinkMetadata] {
	return linkmanager.NewManager(linkmanager.ManagerConfig[string, remoteLinkMetadata]{
		Observe: func(event linkmanager.LinkEvent[string, remoteLinkMetadata]) {
			s.remoteHost.mu.Lock()
			defer s.remoteHost.mu.Unlock()
			if s.remoteHost.observedLinkEvents == nil {
				s.remoteHost.observedLinkEvents = make(map[string]uint64)
			}
			if event.Sequence <= s.remoteHost.observedLinkEvents[event.ConnectionID] {
				return
			}
			s.remoteHost.observedLinkEvents[event.ConnectionID] = event.Sequence
			switch event.State {
			case linkmanager.LinkReady:
				if s.remoteHost.managedLinks != nil {
					s.remoteHost.managedLinks[event.Key] = remoteManagedLink{
						connectionID: event.ConnectionID,
					}
				}
			case linkmanager.LinkDisconnected:
				if s.remoteHost.managedLinks[event.Key].connectionID == event.ConnectionID {
					delete(s.remoteHost.managedLinks, event.Key)
				}
			}
		},
	})
}

func serveManagedRemoteStream(
	ctx context.Context,
	incoming linkmanager.IncomingStream[string, remoteLinkMetadata],
) error {
	metadata := incoming.Metadata
	return serveRemoteStreamWithAgentLive(
		ctx,
		incoming.Stream,
		metadata.handler,
		metadata.pairingID,
		metadata.liveEvents,
	)
}

func deviceLinkProof(action, pairingID, attemptID, fingerprint string) []byte {
	return []byte("tutti-device-link/1\n" + strings.TrimSpace(action) + "\n" +
		strings.TrimSpace(pairingID) + "\n" + strings.TrimSpace(attemptID) + "\n" +
		strings.TrimSpace(fingerprint))
}
