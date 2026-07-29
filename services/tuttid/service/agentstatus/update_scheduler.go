package agentstatus

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const (
	defaultProviderUpdateStartupDelay  = 90 * time.Second
	defaultProviderUpdateCheckInterval = 6 * time.Hour
	defaultProviderUpdateRetryDelay    = 5 * time.Minute
	defaultProviderUpdateMaxRetryDelay = time.Hour
)

type ManagedProviderUpdateDiscoverer interface {
	DiscoverManagedProviderUpdates(context.Context) error
}

type ProviderUpdateSchedulerConfig struct {
	Discoverer    ManagedProviderUpdateDiscoverer
	StartupDelay  time.Duration
	Interval      time.Duration
	RetryDelay    time.Duration
	MaxRetryDelay time.Duration
	Logger        *slog.Logger
}

// ProviderUpdateScheduler owns only periodic release discovery. It never
// authorizes or invokes an update action.
type ProviderUpdateScheduler struct {
	discoverer    ManagedProviderUpdateDiscoverer
	startupDelay  time.Duration
	interval      time.Duration
	retryDelay    time.Duration
	maxRetryDelay time.Duration
	logger        *slog.Logger

	mu          sync.Mutex
	enabled     bool
	started     bool
	cancel      context.CancelFunc
	checkCancel context.CancelFunc
	wake        chan struct{}
	done        chan struct{}
}

func NewProviderUpdateScheduler(config ProviderUpdateSchedulerConfig) *ProviderUpdateScheduler {
	startupDelay := config.StartupDelay
	if startupDelay <= 0 {
		startupDelay = defaultProviderUpdateStartupDelay
	}
	interval := config.Interval
	if interval <= 0 {
		interval = defaultProviderUpdateCheckInterval
	}
	retryDelay := config.RetryDelay
	if retryDelay <= 0 {
		retryDelay = defaultProviderUpdateRetryDelay
	}
	maxRetryDelay := config.MaxRetryDelay
	if maxRetryDelay <= 0 {
		maxRetryDelay = defaultProviderUpdateMaxRetryDelay
	}
	if maxRetryDelay < retryDelay {
		maxRetryDelay = retryDelay
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ProviderUpdateScheduler{
		discoverer:    config.Discoverer,
		startupDelay:  startupDelay,
		interval:      interval,
		retryDelay:    retryDelay,
		maxRetryDelay: maxRetryDelay,
		logger:        logger,
		wake:          make(chan struct{}, 1),
		done:          make(chan struct{}),
	}
}

func (s *ProviderUpdateScheduler) Start(enabled bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		s.SetEnabled(enabled)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.started = true
	s.enabled = enabled
	s.cancel = cancel
	s.mu.Unlock()
	go s.run(ctx)
}

func (s *ProviderUpdateScheduler) SetEnabled(enabled bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	changed := s.enabled != enabled
	s.enabled = enabled
	if !enabled && s.checkCancel != nil {
		s.checkCancel()
	}
	started := s.started
	s.mu.Unlock()
	if changed && started {
		s.signal()
	}
}

func (s *ProviderUpdateScheduler) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	done := s.done
	if s.checkCancel != nil {
		s.checkCancel()
	}
	s.mu.Unlock()
	cancel()
	<-done
}

func (s *ProviderUpdateScheduler) run(ctx context.Context) {
	defer close(s.done)
	var timer *time.Timer
	var timerC <-chan time.Time
	nextRetryDelay := s.retryDelay
	resetTimer := func(delay time.Duration) {
		if timer == nil {
			timer = time.NewTimer(delay)
		} else {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(delay)
		}
		timerC = timer.C
	}
	stopTimer := func() {
		if timer != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}
	defer stopTimer()
	if s.isEnabled() {
		resetTimer(s.startupDelay)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
			stopTimer()
			nextRetryDelay = s.retryDelay
			if s.isEnabled() {
				resetTimer(s.startupDelay)
			}
		case <-timerC:
			timerC = nil
			if s.discoverer == nil {
				continue
			}
			checkCtx, cancel, ok := s.beginCheck(ctx)
			if !ok {
				continue
			}
			err := s.discoverer.DiscoverManagedProviderUpdates(checkCtx)
			cancel()
			s.setCheckCancel(nil)
			if !s.isEnabled() || ctx.Err() != nil {
				continue
			}
			if err != nil {
				s.logger.Warn("agent CLI update discovery failed",
					"event", "tutti.agent_provider.update_scheduler.discovery_failed",
					"retry_after", nextRetryDelay,
					"error", err,
				)
				resetTimer(nextRetryDelay)
				nextRetryDelay = boundedDoubleDuration(nextRetryDelay, s.maxRetryDelay)
				continue
			}
			nextRetryDelay = s.retryDelay
			resetTimer(s.interval)
		}
	}
}

func (s *ProviderUpdateScheduler) isEnabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

func (s *ProviderUpdateScheduler) beginCheck(parent context.Context) (context.Context, context.CancelFunc, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.enabled {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(parent)
	s.checkCancel = cancel
	return ctx, cancel, true
}

func (s *ProviderUpdateScheduler) setCheckCancel(cancel context.CancelFunc) {
	s.mu.Lock()
	s.checkCancel = cancel
	s.mu.Unlock()
}

func (s *ProviderUpdateScheduler) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func boundedDoubleDuration(value time.Duration, maximum time.Duration) time.Duration {
	if value >= maximum || value > maximum/2 {
		return maximum
	}
	return value * 2
}
