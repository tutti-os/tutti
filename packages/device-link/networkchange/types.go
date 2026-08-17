package networkchange

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrWatcherUnavailable tells a Monitor to use polling because the platform
// source cannot provide a kernel notification stream.
var ErrWatcherUnavailable = errors.New("network change watcher unavailable")

// Fingerprint is an opaque digest of one sampled local network environment.
// Its bytes are never sent to subscribers and callers should not interpret
// them as an address or route representation.
type Fingerprint [32]byte

// Source samples the local network environment and, when available, provides
// a channel that is signalled after a kernel-level network event. Watch must
// return ErrWatcherUnavailable when polling is the only supported mechanism.
// A watcher channel that closes unexpectedly is treated as a watcher failure
// and causes the Monitor to fall back to polling.
type Source interface {
	Sample(context.Context) (Fingerprint, error)
	Watch(context.Context) (<-chan struct{}, error)
}

// Change is the only value delivered to subscribers. Generation is strictly
// greater than the previous generation for a running Monitor. No network
// address, gateway, interface name, or fingerprint is included.
type Change struct {
	Generation         uint64
	PreviousGeneration uint64
}

// ObservationMode is the monitor's read-only source mode. Consumers should
// use ObservationWatching to report an active kernel watcher and ObservationPolling to
// report a deliberate fallback; there is intentionally no mutable or
// caller-supplied watcherHealthy flag.
type ObservationMode string

const (
	ObservationStopped  ObservationMode = "stopped"
	ObservationStarting ObservationMode = "starting"
	ObservationWatching ObservationMode = "watching"
	ObservationPolling  ObservationMode = "polling"
)

// PollReason identifies why a monitor is polling. It contains no platform
// error text or network material.
type PollReason string

const (
	PollReasonNone               PollReason = ""
	PollReasonWatcherUnavailable PollReason = "watcher_unavailable"
	PollReasonWatcherClosed      PollReason = "watcher_closed"
	PollReasonWatcherDisabled    PollReason = "watcher_disabled"
)

// Status is a read-only diagnostic snapshot. ObservationWatching means the
// source returned a live watcher; ObservationPolling means samples are being
// driven by the polling ticker. SampleHealthy and ConsecutiveSampleFailures
// report bounded health without exposing source errors or network material.
type Status struct {
	Mode                      ObservationMode
	PollReason                PollReason
	Generation                uint64
	SampleHealthy             bool
	ConsecutiveSampleFailures uint64
	LastSampleAt              time.Time
}

// Config controls Monitor timing. Zero values select the platform defaults:
// 500ms debounce, 2s fallback polling, and a 30s Darwin watcher safety
// recheck. SafetyRecheck is ignored while the source is in polling mode.
type Config struct {
	Debounce      time.Duration
	PollInterval  time.Duration
	SafetyRecheck time.Duration
}

// Monitor observes one Source and broadcasts environment changes to all
// subscribers. A Monitor starts at generation 1. The first successful sample
// establishes its baseline and does not advance that generation; later
// distinct successful samples advance it once each.
type Monitor struct {
	source Source
	cfg    Config

	mu             sync.Mutex
	generation     uint64
	baseline       Fingerprint
	hasBaseline    bool
	running        bool
	mode           ObservationMode
	pollReason     PollReason
	sampleHealthy  bool
	sampleFailures uint64
	lastSampleAt   time.Time
	nextSubscriber uint64
	subscribers    map[uint64]*subscription
}

type subscription struct {
	channel chan Change
	done    chan struct{}
}

// NewMonitor creates an idle monitor for source. Call Run to begin sampling.
// It returns an error for a nil source.
func NewMonitor(source Source) (*Monitor, error) {
	return NewMonitorWithConfig(source, Config{})
}

// NewMonitorWithConfig creates an idle monitor with explicit timing. Values
// below one millisecond are rejected to prevent busy loops in callers and
// tests.
func NewMonitorWithConfig(source Source, cfg Config) (*Monitor, error) {
	if source == nil {
		return nil, errors.New("network change source is required")
	}
	if cfg.Debounce <= 0 {
		cfg.Debounce = 500 * time.Millisecond
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 2 * time.Second
	}
	if cfg.SafetyRecheck <= 0 {
		cfg.SafetyRecheck = defaultSafetyRecheck
	}
	if cfg.Debounce < time.Millisecond || cfg.PollInterval < time.Millisecond ||
		(cfg.SafetyRecheck > 0 && cfg.SafetyRecheck < time.Millisecond) {
		return nil, errors.New("network change monitor intervals are too short")
	}
	return &Monitor{
		source:      source,
		cfg:         cfg,
		generation:  1,
		mode:        ObservationStopped,
		subscribers: make(map[uint64]*subscription),
	}, nil
}

// NewSystemMonitor creates a monitor backed by the current platform's local
// network source.
func NewSystemMonitor() (*Monitor, error) {
	return NewMonitor(NewSystemSource())
}

// NewSystemSource returns the process-local platform source. Darwin uses a
// native route socket as a change trigger; other platforms intentionally
// return ErrWatcherUnavailable and use polling.
func NewSystemSource() Source { return systemSource{} }

// Generation returns the latest committed generation. It returns 1 before the
// first successful sample and after a sample failure.
func (m *Monitor) Generation() uint64 {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.generation
}

// Status returns a read-only diagnostic snapshot of the monitor source mode.
// It never exposes source errors, interface names, addresses, gateways, or
// route contents.
func (m *Monitor) Status() Status {
	if m == nil {
		return Status{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{
		Mode:                      m.mode,
		PollReason:                m.pollReason,
		Generation:                m.generation,
		SampleHealthy:             m.sampleHealthy,
		ConsecutiveSampleFailures: m.sampleFailures,
		LastSampleAt:              m.lastSampleAt,
	}
}

// Subscribe registers a buffered change subscription. The returned cancel
// function is idempotent. Changes are coalesced when a subscriber is slower
// than the monitor; the newest generation replaces an older queued change.
// The subscription is closed when ctx is canceled or Run exits.
func (m *Monitor) Subscribe(ctx context.Context) (<-chan Change, func(), error) {
	if m == nil {
		return nil, func() {}, errors.New("network change monitor is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, func() {}, err
	}
	subscriber := &subscription{channel: make(chan Change, 8), done: make(chan struct{})}
	m.mu.Lock()
	m.nextSubscriber++
	id := m.nextSubscriber
	m.subscribers[id] = subscriber
	m.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			m.removeSubscriber(id)
		})
	}
	if done := ctx.Done(); done != nil {
		go func() {
			select {
			case <-done:
				cancel()
			case <-subscriber.done:
			}
		}()
	}
	return subscriber.channel, cancel, nil
}

// Run starts monitoring until ctx is canceled. A Monitor may be run again
// after it stops; each run establishes no new baseline unless the source has
// successfully sampled one during the previous run.
func (m *Monitor) Run(ctx context.Context) error {
	if m == nil {
		return errors.New("network change monitor is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return errors.New("network change monitor is already running")
	}
	m.running = true
	m.mode = ObservationStarting
	m.pollReason = PollReasonNone
	m.mu.Unlock()
	defer m.finishRun()

	_ = m.sample(ctx)

	watch, watchErr := m.source.Watch(ctx)
	watching := watchErr == nil && watch != nil
	if watching {
		if m.cfg.SafetyRecheck <= 0 {
			watching = false
			m.setMode(ObservationPolling, PollReasonWatcherDisabled)
		} else {
			watch = nonNilWatch(watch)
			m.setMode(ObservationWatching, PollReasonNone)
		}
	} else {
		m.setMode(ObservationPolling, PollReasonWatcherUnavailable)
	}
	interval := m.cfg.PollInterval
	if watching {
		interval = m.cfg.SafetyRecheck
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var debounce *time.Timer
	var debounceC <-chan time.Time
	resetDebounce := func() {
		if debounce == nil {
			debounce = time.NewTimer(m.cfg.Debounce)
			debounceC = debounce.C
			return
		}
		if !debounce.Stop() {
			select {
			case <-debounce.C:
			default:
			}
		}
		debounce.Reset(m.cfg.Debounce)
		debounceC = debounce.C
	}
	defer func() {
		if debounce != nil {
			debounce.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case _, ok := <-watch:
			if !watching {
				watch = nil
				continue
			}
			if !ok {
				watching = false
				watch = nil
				m.setMode(ObservationPolling, PollReasonWatcherClosed)
				interval = m.cfg.PollInterval
				ticker.Stop()
				ticker = time.NewTicker(interval)
				continue
			}
			resetDebounce()
		case <-debounceC:
			debounceC = nil
			_ = m.sample(ctx)
		case <-ticker.C:
			_ = m.sample(ctx)
		}
	}
}

func (m *Monitor) sample(ctx context.Context) error {
	fingerprint, err := m.source.Sample(ctx)
	sampledAt := time.Now().UTC()
	if err != nil {
		m.mu.Lock()
		m.lastSampleAt = sampledAt
		m.sampleHealthy = false
		if m.sampleFailures != ^uint64(0) {
			m.sampleFailures++
		}
		m.mu.Unlock()
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastSampleAt = sampledAt
	m.sampleHealthy = true
	m.sampleFailures = 0
	if !m.hasBaseline {
		m.baseline = fingerprint
		m.hasBaseline = true
		return nil
	}
	if fingerprint == m.baseline {
		return nil
	}
	previous := m.generation
	if previous == ^uint64(0) {
		return nil
	}
	m.baseline = fingerprint
	m.generation++
	change := Change{Generation: m.generation, PreviousGeneration: previous}
	for _, subscriber := range m.subscribers {
		select {
		case subscriber.channel <- change:
		default:
			select {
			case <-subscriber.channel:
			default:
			}
			select {
			case subscriber.channel <- change:
			default:
			}
		}
	}
	return nil
}

func (m *Monitor) removeSubscriber(id uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if subscriber, ok := m.subscribers[id]; ok {
		delete(m.subscribers, id)
		close(subscriber.done)
		close(subscriber.channel)
	}
}

func (m *Monitor) setMode(mode ObservationMode, reason PollReason) {
	m.mu.Lock()
	m.mode = mode
	m.pollReason = reason
	m.mu.Unlock()
}

func (m *Monitor) finishRun() {
	m.mu.Lock()
	m.running = false
	m.mode = ObservationStopped
	m.pollReason = PollReasonNone
	for id, subscriber := range m.subscribers {
		delete(m.subscribers, id)
		close(subscriber.done)
		close(subscriber.channel)
	}
	m.mu.Unlock()
}

func nonNilWatch(watch <-chan struct{}) <-chan struct{} {
	if watch != nil {
		return watch
	}
	closed := make(chan struct{})
	close(closed)
	return closed
}
