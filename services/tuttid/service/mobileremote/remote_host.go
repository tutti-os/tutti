package mobileremote

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"strings"
	"sync"
	"time"

	authenticatedlink "github.com/tutti-os/tutti/packages/device-link/authenticated"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

const (
	defaultRemotePollInterval = 2 * time.Second
	remoteCallerSettleDelay   = 6 * time.Second
	deviceLinkProtocolVersion = 2
)

type activeRemoteAttempt struct {
	pairingID string
	cancel    context.CancelFunc
}

type remoteHostState struct {
	mu sync.Mutex

	cancel            context.CancelFunc
	handler           http.Handler
	attempts          map[string]activeRemoteAttempt
	registeredSession string
	registeredDevice  RegisteredDevice
	registerAfter     time.Time
}

func (s *Service) StartRemoteHost(handler http.Handler) {
	if s == nil || handler == nil {
		return
	}
	s.remoteHost.mu.Lock()
	if s.remoteHost.cancel != nil {
		s.remoteHost.handler = handler
		s.remoteHost.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.remoteHost.cancel = cancel
	s.remoteHost.handler = handler
	s.remoteHost.attempts = make(map[string]activeRemoteAttempt)
	s.remoteHost.mu.Unlock()

	s.remoteWG.Add(1)
	go func() {
		defer s.remoteWG.Done()
		s.runRemoteHost(ctx)
	}()
}

func (s *Service) Close() {
	if s == nil {
		return
	}
	s.remoteHost.mu.Lock()
	cancel := s.remoteHost.cancel
	s.remoteHost.cancel = nil
	for _, attempt := range s.remoteHost.attempts {
		attempt.cancel()
	}
	s.remoteHost.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.remoteWG.Wait()
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
	registered, err := s.ensureRegisteredDevice(ctx, session.SessionID, session.Cookie, identity)
	if err != nil {
		return
	}
	pairings, err := s.ControlPlane.ListPairings(ctx, session.Cookie)
	if err != nil {
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
	if _, exists := s.remoteHost.attempts[attempt.AttemptID]; exists {
		s.remoteHost.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.remoteHost.attempts[attempt.AttemptID] = activeRemoteAttempt{pairingID: pairingID, cancel: cancel}
	handler := s.remoteHost.handler
	s.remoteHost.mu.Unlock()

	s.remoteWG.Add(1)
	go func() {
		defer s.remoteWG.Done()
		defer cancel()
		defer func() {
			s.remoteHost.mu.Lock()
			delete(s.remoteHost.attempts, attempt.AttemptID)
			s.remoteHost.mu.Unlock()
		}()
		var ok bool
		attempt, ok = s.settledRemoteAttempt(ctx, cookie, identity, pairingID, attempt)
		if !ok {
			return
		}
		s.serveRemoteAttempt(ctx, handler, cookie, identity, pairingID, attempt)
	}()
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
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
	pairingID string,
	attempt DeviceLinkAttempt,
) {
	if deadline, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(attempt.ExpiresAt)); err == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	participant, err := authenticatedlink.NewParticipant(authenticatedlink.ParticipantConfig{
		STUNEndpoints:   append([]string(nil), attempt.STUNEndpoints...),
		IncludeLoopback: s.includeLoopback,
	})
	if err != nil {
		return
	}
	defer participant.Close()
	description, err := participant.LocalDescription(ctx)
	if err != nil {
		return
	}
	signature := ed25519.Sign(
		identity.PrivateKey,
		deviceLinkProof("update", pairingID, attempt.AttemptID, description.Fingerprint),
	)
	updated, err := s.ControlPlane.UpdateDeviceLinkParticipant(
		ctx, cookie, pairingID, attempt.AttemptID, identity.DeviceID,
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
	link, err := participant.Connect(ctx, authenticatedlink.Description{
		Fingerprint: updated.CallerFingerprint,
		Ufrag:       peer.Ufrag,
		Pwd:         peer.Pwd,
		Candidates:  append([]string(nil), peer.Candidates...),
	}, authenticatedlink.RoleOwner)
	if err != nil {
		return
	}
	defer link.Close()

	for {
		stream, err := link.AcceptStream(ctx)
		if err != nil {
			return
		}
		s.remoteWG.Add(1)
		go func() {
			defer s.remoteWG.Done()
			_ = serveRemoteStream(ctx, stream, handler)
		}()
	}
}

func (s *Service) stopRemoteAttempts(validPairings map[string]struct{}) {
	s.remoteHost.mu.Lock()
	defer s.remoteHost.mu.Unlock()
	for attemptID, attempt := range s.remoteHost.attempts {
		if validPairings != nil {
			if _, valid := validPairings[attempt.pairingID]; valid {
				continue
			}
		}
		attempt.cancel()
		delete(s.remoteHost.attempts, attemptID)
	}
	if validPairings == nil {
		s.remoteHost.registeredSession = ""
		s.remoteHost.registeredDevice = RegisteredDevice{}
		s.remoteHost.registerAfter = time.Time{}
	}
}

func deviceLinkProof(action, pairingID, attemptID, fingerprint string) []byte {
	return []byte("tutti-device-link/1\n" + strings.TrimSpace(action) + "\n" +
		strings.TrimSpace(pairingID) + "\n" + strings.TrimSpace(attemptID) + "\n" +
		strings.TrimSpace(fingerprint))
}
