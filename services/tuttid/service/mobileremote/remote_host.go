package mobileremote

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	devicelink "github.com/tutti-os/tutti/packages/device-link"
	authenticatedlink "github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/candidateexchange"
	"github.com/tutti-os/tutti/packages/device-link/linkmanager"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

const (
	defaultRemotePollInterval  = 2 * time.Second
	remoteCallerSettleFallback = 500 * time.Millisecond
	deviceLinkProtocolVersion  = 2
	mobileRemoteRelayDriver    = "mobile-remote"
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
	attemptWake          *AttemptWake
	pollWake             chan struct{}
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
		s.remoteHost.attemptWake = NewAttemptWake()
		s.remoteHost.pollWake = make(chan struct{}, 1)
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

		if s.AttemptEvents != nil {
			s.remoteWG.Add(1)
			go func() {
				defer s.remoteWG.Done()
				s.runRemoteAttemptEvents(ctx)
			}()
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
	s.remoteHost.attemptWake = nil
	s.remoteHost.pollWake = nil
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
		s.remoteHost.mu.Lock()
		pollWake := s.remoteHost.pollWake
		s.remoteHost.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-pollWake:
		}
		if ctx.Err() != nil {
			return
		}
		s.pollRemoteHost(ctx)
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(interval)
	}
}

func (s *Service) runRemoteAttemptEvents(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		session, identity, err := s.readyIdentity(ctx)
		if err == nil {
			s.remoteHost.mu.Lock()
			wake := s.remoteHost.attemptWake
			s.remoteHost.mu.Unlock()
			if wake != nil {
				runErr := s.AttemptEvents.Run(
					ctx, session.Cookie, identity.DeviceID, s.notifyRemoteAttemptChanged,
				)
				if ctx.Err() != nil {
					return
				}
				if runErr == nil {
					backoff = time.Second
				} else {
					backoff = nextAttemptEventBackoff(backoff)
				}
			}
		}
		if !waitRemoteAttemptEventRetry(ctx, backoff) {
			return
		}
	}
}

// notifyRemoteAttemptChanged treats realtime messages as a best-effort wake
// for both stages of owner rendezvous: an attempt may not have a worker yet,
// so the discovery loop must run immediately before the worker can refetch it.
// The HTTP attempt API remains authoritative when either wake is lost.
func (s *Service) notifyRemoteAttemptChanged(attemptID string) {
	s.remoteHost.mu.Lock()
	wake := s.remoteHost.attemptWake
	pollWake := s.remoteHost.pollWake
	s.remoteHost.mu.Unlock()
	if wake != nil {
		wake.Notify(attemptID)
	}
	if pollWake != nil {
		select {
		case pollWake <- struct{}{}:
		default:
		}
	}
}

func nextAttemptEventBackoff(current time.Duration) time.Duration {
	if current <= 0 {
		return time.Second
	}
	if current >= 15*time.Second {
		return 15 * time.Second
	}
	next := current + current/2
	if next > 15*time.Second {
		return 15 * time.Second
	}
	return next
}

func waitRemoteAttemptEventRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
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
	wake := s.remoteHost.attemptWake
	finished := false
	if current, exists := s.remoteHost.attempts[attemptID]; exists &&
		current.generation == generation {
		delete(s.remoteHost.attempts, attemptID)
		finished = true
	}
	s.remoteHost.mu.Unlock()
	if finished && wake != nil {
		wake.Forget(attemptID)
	}
}

func (s *Service) stopRemotePairing(pairingID string) {
	pairingID = strings.TrimSpace(pairingID)
	s.remoteHost.mu.Lock()
	finishedAttemptIDs := make([]string, 0)
	for attemptID, attempt := range s.remoteHost.attempts {
		if attempt.pairingID != pairingID {
			continue
		}
		attempt.cancel()
		delete(s.remoteHost.attempts, attemptID)
		finishedAttemptIDs = append(finishedAttemptIDs, attemptID)
	}
	manager := s.remoteHost.linkManager
	wake := s.remoteHost.attemptWake
	s.remoteHost.mu.Unlock()
	if wake != nil {
		for _, attemptID := range finishedAttemptIDs {
			wake.Forget(attemptID)
		}
	}
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
	startedAt := time.Now()
	if len(attempt.STUNEndpoints) == 0 {
		s.recordRemoteAttempt(RemoteAttemptEvent{
			AttemptID: attempt.AttemptID, PairingID: pairingID,
			Stage: "rendezvous_wait", Outcome: "skipped",
			ElapsedMS: time.Since(startedAt).Milliseconds(),
		})
		return attempt, true
	}
	s.remoteHost.mu.Lock()
	wake := s.remoteHost.attemptWake
	var wakeVersion uint64
	if wake != nil {
		wakeVersion = wake.Version(attempt.AttemptID)
	}
	s.remoteHost.mu.Unlock()
	if wake != nil {
		settleCtx, cancel := context.WithTimeout(ctx, remoteCallerSettleFallback)
		wake.Wait(settleCtx, attempt.AttemptID, wakeVersion)
		cancel()
	} else if !waitRemoteAttemptEventRetry(ctx, remoteCallerSettleFallback) {
		return DeviceLinkAttempt{}, false
	}
	if ctx.Err() != nil {
		s.recordRemoteAttempt(RemoteAttemptEvent{
			AttemptID: attempt.AttemptID, PairingID: pairingID,
			Stage: "rendezvous_wait", Outcome: "cancelled",
			ElapsedMS: time.Since(startedAt).Milliseconds(),
		})
		return DeviceLinkAttempt{}, false
	}
	signature := ed25519.Sign(identity.PrivateKey, deviceLinkProof("list", pairingID, "", ""))
	attempts, err := s.ControlPlane.ListDeviceLinkAttempts(
		ctx, cookie, pairingID, identity.DeviceID, signature,
	)
	if err != nil {
		s.recordRemoteAttempt(RemoteAttemptEvent{
			AttemptID: attempt.AttemptID, PairingID: pairingID,
			Stage: "rendezvous_refetch", Outcome: "failed",
			ElapsedMS: time.Since(startedAt).Milliseconds(), Error: err.Error(),
		})
		return DeviceLinkAttempt{}, false
	}
	for _, latest := range attempts {
		if latest.AttemptID == attempt.AttemptID && latest.State == "awaiting_owner" &&
			latest.OwnerFingerprint == "" && latest.OwnerICE == nil {
			s.recordRemoteAttempt(RemoteAttemptEvent{
				AttemptID: attempt.AttemptID, PairingID: pairingID,
				Stage: "rendezvous_wait", Outcome: "succeeded",
				ElapsedMS: time.Since(startedAt).Milliseconds(),
			})
			return latest, true
		}
	}
	s.recordRemoteAttempt(RemoteAttemptEvent{
		AttemptID: attempt.AttemptID, PairingID: pairingID,
		Stage: "rendezvous_wait", Outcome: "superseded",
		ElapsedMS: time.Since(startedAt).Milliseconds(),
	})
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
	deadline, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(attempt.ExpiresAt))
	if err != nil {
		return
	}
	handshakeCtx, cancelHandshake := context.WithDeadline(ctx, deadline)
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
	exchange, description, err := candidateexchange.Start(
		participant,
		candidateexchange.Config{},
	)
	if err != nil {
		return
	}
	signature := ed25519.Sign(
		identity.PrivateKey,
		deviceLinkProof("update", pairingID, attempt.AttemptID, description.Fingerprint),
	)
	var callerWakeVersion uint64
	if wake := s.remoteAttemptWake(); wake != nil {
		callerWakeVersion = wake.Version(attempt.AttemptID)
	}
	participantStartedAt := time.Now()
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
	if err == nil {
		err = validateOwnerCandidatePublication(
			updated,
			attempt.AttemptID,
			description,
		)
	}
	if err != nil {
		s.recordRemoteAttempt(RemoteAttemptEvent{
			AttemptID: attempt.AttemptID, PairingID: pairingID,
			Stage: "owner_participant", Outcome: "failed",
			ElapsedMS: time.Since(participantStartedAt).Milliseconds(),
		})
		return
	}
	s.recordRemoteAttempt(RemoteAttemptEvent{
		AttemptID: attempt.AttemptID, PairingID: pairingID,
		Stage: "owner_participant", Outcome: "succeeded",
		ElapsedMS: time.Since(participantStartedAt).Milliseconds(),
	})
	peer := updated.CallerICE
	if peer == nil {
		return
	}
	stopCandidateExchange := s.runRemoteCandidateExchange(
		handshakeCtx,
		cookie,
		identity,
		pairingID,
		attempt.AttemptID,
		updated.CallerFingerprint,
		*peer,
		callerWakeVersion,
		exchange,
		cancelHandshake,
	)
	defer stopCandidateExchange()
	connectStartedAt := time.Now()
	link, err := participant.Connect(handshakeCtx, authenticatedlink.Description{
		Fingerprint: updated.CallerFingerprint,
		Ufrag:       peer.Ufrag,
		Pwd:         peer.Pwd,
		Candidates:  append([]string(nil), peer.Candidates...),
	}, authenticatedlink.RoleOwner)
	if err != nil {
		s.recordRemoteAttempt(RemoteAttemptEvent{
			AttemptID: attempt.AttemptID, PairingID: pairingID,
			Stage: "direct_connect", Outcome: "failed",
			ElapsedMS: time.Since(connectStartedAt).Milliseconds(), Error: err.Error(),
		})
		return
	}
	s.recordRemoteAttempt(RemoteAttemptEvent{
		AttemptID: attempt.AttemptID, PairingID: pairingID,
		Stage: "direct_connect", Outcome: "succeeded",
		ElapsedMS: time.Since(connectStartedAt).Milliseconds(),
	})
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
	finishedAttemptIDs := make([]string, 0)
	for attemptID, attempt := range s.remoteHost.attempts {
		if validPairings != nil {
			if _, valid := validPairings[attempt.pairingID]; valid {
				continue
			}
		}
		attempt.cancel()
		delete(s.remoteHost.attempts, attemptID)
		invalidPairingSet[attempt.pairingID] = struct{}{}
		finishedAttemptIDs = append(finishedAttemptIDs, attemptID)
	}
	manager := s.remoteHost.linkManager
	wake := s.remoteHost.attemptWake
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
	if wake != nil {
		for _, attemptID := range finishedAttemptIDs {
			wake.Forget(attemptID)
		}
	}
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
	return devicelink.ServeStreamProbe(ctx, incoming.Stream, func(
		ctx context.Context,
		stream net.Conn,
	) error {
		return serveRemoteStreamWithAgentLive(
			ctx,
			stream,
			metadata.handler,
			metadata.pairingID,
			metadata.liveEvents,
		)
	})
}

func deviceLinkProof(action, pairingID, attemptID, fingerprint string) []byte {
	return []byte("tutti-device-link/1\n" + strings.TrimSpace(action) + "\n" +
		strings.TrimSpace(pairingID) + "\n" + strings.TrimSpace(attemptID) + "\n" +
		strings.TrimSpace(fingerprint))
}

func (s *Service) recordRemoteAttempt(event RemoteAttemptEvent) {
	if s != nil && s.Diagnostics != nil {
		s.Diagnostics.Record(event)
	}
}
