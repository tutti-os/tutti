package agentstatus

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type schedulerDiscovererStub struct {
	mu      sync.Mutex
	errors  []error
	calls   chan time.Time
	started chan struct{}
	block   bool
}

func (s *schedulerDiscovererStub) DiscoverManagedProviderUpdates(ctx context.Context) error {
	if s.started != nil {
		select {
		case s.started <- struct{}{}:
		default:
		}
	}
	if s.calls != nil {
		s.calls <- time.Now()
	}
	if s.block {
		<-ctx.Done()
		return ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.errors) == 0 {
		return nil
	}
	err := s.errors[0]
	s.errors = s.errors[1:]
	return err
}

func TestProviderUpdateSchedulerDisabledMakesNoChecksAndCanBeRescheduled(t *testing.T) {
	discoverer := &schedulerDiscovererStub{calls: make(chan time.Time, 4)}
	scheduler := NewProviderUpdateScheduler(ProviderUpdateSchedulerConfig{
		Discoverer:    discoverer,
		StartupDelay:  5 * time.Millisecond,
		Interval:      10 * time.Millisecond,
		RetryDelay:    5 * time.Millisecond,
		MaxRetryDelay: 10 * time.Millisecond,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	scheduler.Start(false)
	defer scheduler.Close()

	assertNoSchedulerCall(t, discoverer.calls, 20*time.Millisecond)
	scheduler.SetEnabled(true)
	assertSchedulerCall(t, discoverer.calls)
	scheduler.SetEnabled(false)
	assertNoSchedulerCall(t, discoverer.calls, 30*time.Millisecond)
}

func TestProviderUpdateSchedulerRetriesFailuresWithBoundedBackoff(t *testing.T) {
	discoverer := &schedulerDiscovererStub{
		calls:  make(chan time.Time, 4),
		errors: []error{errors.New("first"), errors.New("second")},
	}
	scheduler := NewProviderUpdateScheduler(ProviderUpdateSchedulerConfig{
		Discoverer:    discoverer,
		StartupDelay:  time.Millisecond,
		Interval:      time.Hour,
		RetryDelay:    8 * time.Millisecond,
		MaxRetryDelay: 12 * time.Millisecond,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	scheduler.Start(true)
	defer scheduler.Close()

	first := assertSchedulerCall(t, discoverer.calls)
	second := assertSchedulerCall(t, discoverer.calls)
	third := assertSchedulerCall(t, discoverer.calls)
	if gap := second.Sub(first); gap < 5*time.Millisecond {
		t.Fatalf("first retry gap = %s, want backoff", gap)
	}
	if gap := third.Sub(second); gap < 9*time.Millisecond {
		t.Fatalf("second retry gap = %s, want increased bounded backoff", gap)
	}
	assertNoSchedulerCall(t, discoverer.calls, 20*time.Millisecond)
	if got := boundedDoubleDuration(8*time.Millisecond, 12*time.Millisecond); got != 12*time.Millisecond {
		t.Fatalf("boundedDoubleDuration() = %s, want 12ms", got)
	}
}

func TestProviderUpdateSchedulerCloseCancelsInFlightDiscovery(t *testing.T) {
	discoverer := &schedulerDiscovererStub{
		started: make(chan struct{}, 1),
		block:   true,
	}
	scheduler := NewProviderUpdateScheduler(ProviderUpdateSchedulerConfig{
		Discoverer:   discoverer,
		StartupDelay: time.Millisecond,
	})
	scheduler.Start(true)

	select {
	case <-discoverer.started:
	case <-time.After(time.Second):
		t.Fatal("scheduler discovery did not start")
	}
	done := make(chan struct{})
	go func() {
		scheduler.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler Close() did not cancel in-flight discovery")
	}
}

func assertSchedulerCall(t *testing.T, calls <-chan time.Time) time.Time {
	t.Helper()
	select {
	case calledAt := <-calls:
		return calledAt
	case <-time.After(time.Second):
		t.Fatal("scheduler discovery was not called")
		return time.Time{}
	}
}

func assertNoSchedulerCall(t *testing.T, calls <-chan time.Time, duration time.Duration) {
	t.Helper()
	select {
	case calledAt := <-calls:
		t.Fatalf("unexpected scheduler discovery at %s", calledAt)
	case <-time.After(duration):
	}
}
