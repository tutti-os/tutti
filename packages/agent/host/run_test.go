package agenthost

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRunSupervisedWorkersStartsAllAndStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{}, 3)
	worker := func(ctx context.Context) error {
		started <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}
	done := make(chan error, 1)
	go func() {
		done <- runSupervisedWorkers(ctx, []func(context.Context) error{worker, worker, worker})
	}()
	for range 3 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("not every Host worker started")
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run() error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run() did not stop after context cancellation")
	}
}

func TestRunSupervisedWorkersCancelsSiblingsWhenOneWorkerFails(t *testing.T) {
	wantErr := errors.New("worker infrastructure failed")
	started := make(chan struct{}, 2)
	var canceled sync.WaitGroup
	canceled.Add(2)
	sibling := func(ctx context.Context) error {
		started <- struct{}{}
		<-ctx.Done()
		canceled.Done()
		return ctx.Err()
	}
	failing := func(context.Context) error {
		for range 2 {
			<-started
		}
		return wantErr
	}

	err := runSupervisedWorkers(context.Background(), []func(context.Context) error{sibling, failing, sibling})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Run() error = %v, want %v", err, wantErr)
	}
	done := make(chan struct{})
	go func() {
		canceled.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker failure did not cancel sibling workers")
	}
}

func TestNilHostRunIsNoop(t *testing.T) {
	var host *Host
	if err := host.Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v, want nil", err)
	}
}

func TestHostRunPropagatesWorkerInfrastructureFailure(t *testing.T) {
	wantErr := errors.New("scheduler unavailable")
	host := New(Config{Scheduler: failingRunScheduler{err: wantErr}})
	if err := host.Run(context.Background()); !errors.Is(err, wantErr) {
		t.Fatalf("Run() error = %v, want %v", err, wantErr)
	}
}

type failingRunScheduler struct{ err error }

func (scheduler failingRunScheduler) Sleep(context.Context, time.Duration) error {
	return scheduler.err
}
