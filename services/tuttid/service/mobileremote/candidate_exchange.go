package mobileremote

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/candidateexchange"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
)

var (
	errOwnerCandidateUpdateRejected   = errors.New("control-plane rejected owner candidate update")
	errRemoteCandidateIdentityChanged = errors.New("remote device-link participant changed")
)

// runRemoteCandidateExchange connects the shared transport-neutral Trickle
// coordinator to Tutti's authenticated control-plane and push-hint adapters.
// Attempt ownership, signing, and HTTP remain product policy in this package.
func (s *Service) runRemoteCandidateExchange(
	ctx context.Context,
	cookie string,
	identity mobileremotebiz.DeviceIdentity,
	pairingID string,
	attemptID string,
	callerFingerprint string,
	callerICE DeviceLinkICEParams,
	initialWakeVersion uint64,
	exchange *candidateexchange.Exchange,
	failHandshake context.CancelFunc,
) func() {
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	startedAt := time.Now()
	var workers sync.WaitGroup
	var firstPublish sync.Once
	workers.Add(2)
	go func() {
		defer workers.Done()
		err := exchange.PublishLocal(
			workerCtx,
			func(publishCtx context.Context, description authenticated.Description) error {
				signature := ed25519.Sign(
					identity.PrivateKey,
					deviceLinkProof("update", pairingID, attemptID, description.Fingerprint),
				)
				updated, err := s.ControlPlane.UpdateDeviceLinkParticipant(
					publishCtx,
					cookie,
					pairingID,
					attemptID,
					identity.DeviceID,
					DeviceLinkParticipantInput{
						Fingerprint:     description.Fingerprint,
						ProtocolVersion: deviceLinkProtocolVersion,
						ICE: DeviceLinkICEParams{
							Ufrag: description.Ufrag,
							Pwd:   description.Pwd,
							Candidates: append(
								[]string(nil),
								description.Candidates...,
							),
						},
						IdentitySignature: signature,
					},
				)
				if err != nil {
					return err
				}
				if err := validateOwnerCandidatePublication(
					updated,
					attemptID,
					description,
				); err != nil {
					return errOwnerCandidateUpdateRejected
				}
				firstPublish.Do(func() {
					s.recordRemoteAttempt(RemoteAttemptEvent{
						AttemptID: attemptID,
						PairingID: pairingID,
						Stage:     "owner_candidate_publish",
						Outcome:   "succeeded",
						ElapsedMS: time.Since(startedAt).Milliseconds(),
					})
				})
				return nil
			},
			func(err error) bool {
				return workerCtx.Err() == nil && isRetryableCandidateExchangeError(err)
			},
		)
		if isUnexpectedCandidateWorkerError(workerCtx, err) {
			s.recordRemoteAttempt(RemoteAttemptEvent{
				AttemptID: attemptID,
				PairingID: pairingID,
				Stage:     "owner_candidate_publish",
				Outcome:   "failed",
				ElapsedMS: time.Since(startedAt).Milliseconds(),
				Error:     err.Error(),
			})
			failHandshake()
		}
	}()
	go func() {
		defer workers.Done()
		var firstFetchFailure sync.Once
		var firstRemoteCandidate sync.Once
		firstRefresh := true
		lastCandidateCount := len(callerICE.Candidates)
		wakeVersion := initialWakeVersion
		err := exchange.FeedRemote(
			workerCtx,
			func(waitCtx context.Context) bool {
				if firstRefresh {
					firstRefresh = false
					return true
				}
				wake := s.remoteAttemptWake()
				if wake == nil {
					<-waitCtx.Done()
					return false
				}
				notified := wake.Wait(waitCtx, attemptID, wakeVersion)
				if notified {
					wakeVersion = wake.Version(attemptID)
				}
				return notified
			},
			func(fetchCtx context.Context) ([]string, error) {
				signature := ed25519.Sign(
					identity.PrivateKey,
					deviceLinkProof("list", pairingID, "", ""),
				)
				attempts, err := s.ControlPlane.ListDeviceLinkAttempts(
					fetchCtx,
					cookie,
					pairingID,
					identity.DeviceID,
					signature,
				)
				if err != nil {
					return nil, err
				}
				candidates, err := matchingCallerCandidates(
					attempts,
					attemptID,
					callerFingerprint,
					callerICE,
				)
				if err == nil && len(candidates) > lastCandidateCount {
					lastCandidateCount = len(candidates)
					firstRemoteCandidate.Do(func() {
						s.recordRemoteAttempt(RemoteAttemptEvent{
							AttemptID: attemptID,
							PairingID: pairingID,
							Stage:     "caller_candidate_refetch",
							Outcome:   "succeeded",
							ElapsedMS: time.Since(startedAt).Milliseconds(),
						})
					})
				}
				return candidates, err
			},
			func(fetchErr error) bool {
				return workerCtx.Err() == nil && isRetryableCandidateExchangeError(fetchErr)
			},
			func(fetchErr error) {
				firstFetchFailure.Do(func() {
					s.recordRemoteAttempt(RemoteAttemptEvent{
						AttemptID: attemptID,
						PairingID: pairingID,
						Stage:     "caller_candidate_refetch",
						Outcome:   "failed",
						ElapsedMS: time.Since(startedAt).Milliseconds(),
						Error:     fetchErr.Error(),
					})
				})
			},
		)
		if isUnexpectedCandidateWorkerError(workerCtx, err) {
			failHandshake()
		}
	}()
	return func() {
		cancelWorkers()
		workers.Wait()
	}
}

func (s *Service) remoteAttemptWake() *AttemptWake {
	if s == nil {
		return nil
	}
	s.remoteHost.mu.Lock()
	defer s.remoteHost.mu.Unlock()
	return s.remoteHost.attemptWake
}

func matchingCallerCandidates(
	attempts []DeviceLinkAttempt,
	attemptID string,
	fingerprint string,
	ice DeviceLinkICEParams,
) ([]string, error) {
	for _, attempt := range attempts {
		if attempt.AttemptID != attemptID {
			continue
		}
		if attempt.State != "ready" || attempt.CallerICE == nil ||
			attempt.CallerFingerprint != fingerprint ||
			attempt.CallerICE.Ufrag != ice.Ufrag ||
			attempt.CallerICE.Pwd != ice.Pwd {
			return nil, errRemoteCandidateIdentityChanged
		}
		return append([]string(nil), attempt.CallerICE.Candidates...), nil
	}
	return nil, fmt.Errorf("device-link attempt %s is unavailable", attemptID)
}

func validateOwnerCandidatePublication(
	attempt DeviceLinkAttempt,
	attemptID string,
	description authenticated.Description,
) error {
	if attempt.AttemptID != attemptID || attempt.State != "ready" ||
		attempt.OwnerICE == nil ||
		attempt.OwnerFingerprint != description.Fingerprint ||
		attempt.OwnerICE.Ufrag != description.Ufrag ||
		attempt.OwnerICE.Pwd != description.Pwd {
		return errOwnerCandidateUpdateRejected
	}
	for _, candidate := range description.Candidates {
		if !containsCandidate(attempt.OwnerICE.Candidates, candidate) {
			return errOwnerCandidateUpdateRejected
		}
	}
	return nil
}

func containsCandidate(candidates []string, expected string) bool {
	for _, candidate := range candidates {
		if candidate == expected {
			return true
		}
	}
	return false
}

func isRetryableCandidateExchangeError(err error) bool {
	if err == nil || errors.Is(err, errOwnerCandidateUpdateRejected) ||
		errors.Is(err, errRemoteCandidateIdentityChanged) ||
		errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var controlPlaneErr *ControlPlaneError
	if errors.As(err, &controlPlaneErr) {
		return controlPlaneErr.StatusCode == http.StatusRequestTimeout ||
			controlPlaneErr.StatusCode == http.StatusTooManyRequests ||
			controlPlaneErr.StatusCode >= http.StatusInternalServerError
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func isUnexpectedCandidateWorkerError(ctx context.Context, err error) bool {
	return err != nil && ctx.Err() == nil && !errors.Is(err, io.EOF)
}
