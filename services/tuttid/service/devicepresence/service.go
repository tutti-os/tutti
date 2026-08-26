package devicepresence

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

const (
	defaultHeartbeatInterval = 30 * time.Second
	defaultRetryMinimum      = time.Second
	defaultRetryMaximum      = 15 * time.Second
	defaultCloseTimeout      = 2 * time.Second
)

type AccountSessionSource interface {
	ReadSession() (*authbridge.Session, error)
}

type Service struct {
	Account          AccountSessionSource
	Control          ControlPlane
	Metadata         DeviceMetadata
	SessionID        string
	HeartbeatEvery   time.Duration
	AccountPollEvery time.Duration
	RetryMin         time.Duration
	RetryMax         time.Duration
	CloseAfter       time.Duration

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

func NewService(account AccountSessionSource, control ControlPlane, metadata DeviceMetadata) *Service {
	return &Service{Account: account, Control: control, Metadata: metadata, SessionID: uuid.NewString()}
}

func (s *Service) Start() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.cancel, s.done = cancel, done
	s.mu.Unlock()
	go s.run(ctx, done)
}

func (s *Service) Stop(ctx context.Context) {
	if s == nil {
		return
	}
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.mu.Unlock()
	if cancel == nil || done == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (s *Service) run(ctx context.Context, done chan struct{}) {
	defer func() {
		s.mu.Lock()
		if s.done == done {
			s.cancel, s.done = nil, nil
		}
		s.mu.Unlock()
		close(done)
	}()
	retry := s.retryMinimum()
	for {
		cookie, lease, err := s.openAndActivate(ctx)
		if err != nil {
			if isStatus(err, http.StatusUnauthorized) && cookie != "" {
				if !s.waitForAccountChange(ctx, cookie) {
					return
				}
				retry = s.retryMinimum()
				continue
			}
			if !wait(ctx, retry) {
				return
			}
			retry = nextRetry(retry, s.retryMaximum())
			continue
		}
		retry = s.retryMinimum()
		stopped, heartbeatErr := s.renew(ctx, cookie, lease)
		if stopped {
			s.close(cookie, lease.PresenceLeaseID)
			return
		}
		if heartbeatErr != nil {
			slog.Warn("device presence lease will be reopened", "event", "tutti.device_presence.reopen", "error", heartbeatErr)
			if isStatus(heartbeatErr, http.StatusUnauthorized) {
				if !s.waitForAccountChange(ctx, cookie) {
					return
				}
				retry = s.retryMinimum()
				continue
			}
			if !isStatus(heartbeatErr, http.StatusNotFound) && !wait(ctx, retry) {
				return
			}
		}
	}
}

func (s *Service) openAndActivate(ctx context.Context) (string, Lease, error) {
	if s.Account == nil || s.Control == nil || strings.TrimSpace(s.Metadata.DeviceID) == "" || uuid.Validate(s.SessionID) != nil {
		return "", Lease{}, errors.New("device presence service is not configured")
	}
	session, err := s.Account.ReadSession()
	if err != nil || session == nil || strings.TrimSpace(session.Cookie) == "" {
		return "", Lease{}, errors.New("device presence account session is unavailable")
	}
	cookie := strings.TrimSpace(session.Cookie)
	if err := s.Control.RegisterCurrentDevice(ctx, cookie, s.Metadata); err != nil {
		return cookie, Lease{}, err
	}
	lease, err := s.Control.OpenSession(ctx, cookie, s.Metadata.DeviceID, s.SessionID)
	if err != nil {
		return cookie, Lease{}, err
	}
	if err := s.Control.Heartbeat(ctx, cookie, lease.PresenceLeaseID); err != nil {
		return cookie, Lease{}, err
	}
	return cookie, lease, nil
}

func (s *Service) renew(ctx context.Context, cookie string, lease Lease) (bool, error) {
	interval := time.Duration(lease.HeartbeatIntervalSeconds) * time.Second
	if s.HeartbeatEvery > 0 {
		interval = s.HeartbeatEvery
	}
	if interval <= 0 {
		interval = defaultHeartbeatInterval
	}
	timer := time.NewTimer(jitter(interval))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return true, nil
		case <-timer.C:
			if err := s.Control.Heartbeat(ctx, cookie, lease.PresenceLeaseID); err != nil {
				return false, err
			}
			timer.Reset(jitter(interval))
		}
	}
}

func (s *Service) close(cookie, leaseID string) {
	if cookie == "" || leaseID == "" || s.Control == nil {
		return
	}
	timeout := s.CloseAfter
	if timeout <= 0 {
		timeout = defaultCloseTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := s.Control.CloseSession(ctx, cookie, leaseID); err != nil && !isStatus(err, http.StatusNotFound) {
		slog.Warn("device presence close failed; lease will expire", "event", "tutti.device_presence.close_failed", "error", err)
	}
}

func (s *Service) waitForAccountChange(ctx context.Context, rejectedCookie string) bool {
	interval := s.AccountPollEvery
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			session, err := s.Account.ReadSession()
			if err == nil && session != nil && strings.TrimSpace(session.Cookie) != "" && strings.TrimSpace(session.Cookie) != rejectedCookie {
				return true
			}
		}
	}
}

func (s *Service) retryMinimum() time.Duration {
	if s.RetryMin > 0 {
		return s.RetryMin
	}
	return defaultRetryMinimum
}

func (s *Service) retryMaximum() time.Duration {
	if s.RetryMax > 0 {
		return s.RetryMax
	}
	return defaultRetryMaximum
}

func nextRetry(current, maximum time.Duration) time.Duration {
	if next := current * 2; next < maximum {
		return next
	}
	return maximum
}

func jitter(interval time.Duration) time.Duration {
	delta := interval / 10
	if delta <= 0 {
		return interval
	}
	return interval - delta + time.Duration(rand.Int63n(int64(delta*2)+1))
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func isStatus(err error, statusCode int) bool {
	var controlErr *ControlPlaneError
	return errors.As(err, &controlErr) && controlErr.IsStatus(statusCode)
}
