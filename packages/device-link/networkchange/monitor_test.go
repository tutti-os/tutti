package networkchange

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestMonitorStartsAtOneAndAdvancesOnlyForDistinctSuccessfulSamples(t *testing.T) {
	source := newTestSource(Fingerprint{1})
	monitor, err := NewMonitorWithConfig(source, Config{
		Debounce:      time.Millisecond,
		PollInterval:  time.Hour,
		SafetyRecheck: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes, unsubscribe, err := monitor.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	runDone := make(chan error, 1)
	go func() { runDone <- monitor.Run(ctx) }()
	source.WaitForSamples(t, 1)
	if got := monitor.Generation(); got != 1 {
		t.Fatalf("initial generation = %d, want 1", got)
	}
	waitForMode(t, monitor, ObservationWatching)
	status := monitor.Status()
	if status.Mode != ObservationWatching || status.PollReason != PollReasonNone || status.Generation != 1 ||
		!status.SampleHealthy || status.ConsecutiveSampleFailures != 0 || status.LastSampleAt.IsZero() {
		t.Fatalf("watching status = %#v, want active watcher at generation 1", status)
	}

	source.Trigger()
	assertNoChange(t, changes)

	source.SetFingerprint(Fingerprint{2})
	source.Trigger()
	change := waitForChange(t, changes)
	if change.PreviousGeneration != 1 || change.Generation != 2 {
		t.Fatalf("change = %#v, want 1 -> 2", change)
	}
	if got := monitor.Generation(); got != 2 {
		t.Fatalf("generation after first change = %d, want 2", got)
	}

	source.SetError(errors.New("sample unavailable"))
	source.SetFingerprint(Fingerprint{3})
	source.Trigger()
	assertNoChange(t, changes)
	if got := monitor.Generation(); got != 2 {
		t.Fatalf("generation after failed sample = %d, want 2", got)
	}
	status = monitor.Status()
	if status.SampleHealthy || status.ConsecutiveSampleFailures != 1 {
		t.Fatalf("failed sample status = %#v, want one consecutive failure", status)
	}

	source.SetError(nil)
	source.Trigger()
	change = waitForChange(t, changes)
	if change.PreviousGeneration != 2 || change.Generation != 3 {
		t.Fatalf("change after recovery = %#v, want 2 -> 3", change)
	}
	status = monitor.Status()
	if !status.SampleHealthy || status.ConsecutiveSampleFailures != 0 {
		t.Fatalf("recovered sample status = %#v, want healthy", status)
	}
	cancel()
	if err := <-runDone; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if status := monitor.Status(); status.Mode != ObservationStopped {
		t.Fatalf("stopped status = %#v, want stopped", status)
	}
}

func TestMonitorFallsBackToPollingAfterWatcherFailure(t *testing.T) {
	source := newTestSource(Fingerprint{1})
	source.watch = make(chan struct{})
	close(source.watch)
	monitor, err := NewMonitorWithConfig(source, Config{
		Debounce:      time.Millisecond,
		PollInterval:  2 * time.Millisecond,
		SafetyRecheck: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes, unsubscribe, err := monitor.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	runDone := make(chan error, 1)
	go func() { runDone <- monitor.Run(ctx) }()
	source.WaitForSamples(t, 1)
	waitForMode(t, monitor, ObservationPolling)
	status := monitor.Status()
	if status.Mode != ObservationPolling || status.PollReason != PollReasonWatcherClosed {
		t.Fatalf("fallback status = %#v, want closed-watcher polling", status)
	}
	source.SetFingerprint(Fingerprint{2})
	change := waitForChange(t, changes)
	if change.Generation != 2 {
		t.Fatalf("polling change generation = %d, want 2", change.Generation)
	}
	cancel()
	if err := <-runDone; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if status := monitor.Status(); status.Mode != ObservationStopped {
		t.Fatalf("stopped fallback status = %#v, want stopped", status)
	}
}

func TestMonitorCoalescesSlowSubscriberToNewestGeneration(t *testing.T) {
	source := newTestSource(Fingerprint{1})
	monitor, err := NewMonitorWithConfig(source, Config{
		Debounce:      time.Millisecond,
		PollInterval:  time.Hour,
		SafetyRecheck: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes, unsubscribe, err := monitor.Subscribe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	runDone := make(chan error, 1)
	go func() { runDone <- monitor.Run(ctx) }()
	source.WaitForSamples(t, 1)
	for value := byte(2); value < 12; value++ {
		source.SetFingerprint(Fingerprint{value})
		source.Trigger()
		// Each trigger is debounced and sampled synchronously by the monitor;
		// waiting for the generation makes this test independent of scheduler
		// ordering while intentionally leaving the subscription unread.
		waitForGeneration(t, monitor, uint64(value))
	}
	change := waitForChange(t, changes)
	if change.Generation < 2 || change.Generation > 11 {
		t.Fatalf("first queued generation = %d, want a retained generation", change.Generation)
	}
	for {
		select {
		case change = <-changes:
		default:
			if change.Generation != 11 {
				t.Fatalf("newest queued generation = %d, want 11", change.Generation)
			}
			cancel()
			if err := <-runDone; err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			return
		}
	}
}

type testSource struct {
	mu          sync.Mutex
	fingerprint Fingerprint
	err         error
	watch       chan struct{}
	samples     int
	sampleSeen  chan struct{}
}

func newTestSource(fingerprint Fingerprint) *testSource {
	return &testSource{
		fingerprint: fingerprint,
		watch:       make(chan struct{}, 32),
		sampleSeen:  make(chan struct{}, 32),
	}
}

func (s *testSource) Sample(context.Context) (Fingerprint, error) {
	s.mu.Lock()
	s.samples++
	fingerprint, err := s.fingerprint, s.err
	s.mu.Unlock()
	select {
	case s.sampleSeen <- struct{}{}:
	default:
	}
	return fingerprint, err
}

func (s *testSource) Watch(context.Context) (<-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.watch, nil
}

func (s *testSource) SetFingerprint(fingerprint Fingerprint) {
	s.mu.Lock()
	s.fingerprint = fingerprint
	s.mu.Unlock()
}

func (s *testSource) SetError(err error) {
	s.mu.Lock()
	s.err = err
	s.mu.Unlock()
}

func (s *testSource) Trigger() {
	s.mu.Lock()
	watch := s.watch
	s.mu.Unlock()
	select {
	case watch <- struct{}{}:
	default:
	}
}

func (s *testSource) WaitForSamples(t *testing.T, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		select {
		case <-s.sampleSeen:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for network sample")
		}
	}
}

func waitForChange(t *testing.T, changes <-chan Change) Change {
	t.Helper()
	select {
	case change := <-changes:
		return change
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for network change")
		return Change{}
	}
}

func waitForGeneration(t *testing.T, monitor *Monitor, generation uint64) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if monitor.Generation() == generation {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("generation = %d, want %d", monitor.Generation(), generation)
}

func waitForMode(t *testing.T, monitor *Monitor, mode ObservationMode) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if monitor.Status().Mode == mode {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("monitor mode = %q, want %q", monitor.Status().Mode, mode)
}

func assertNoChange(t *testing.T, changes <-chan Change) {
	t.Helper()
	select {
	case change := <-changes:
		t.Fatalf("unexpected network change: %#v", change)
	case <-time.After(15 * time.Millisecond):
	}
}
