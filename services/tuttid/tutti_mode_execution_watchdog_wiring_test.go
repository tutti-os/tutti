package main

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestTuttiModeWatchdogLifecycleStopsBeforeStoreAndAllowsInProcessRestart(
	t *testing.T,
) {
	dbPath := filepath.Join(t.TempDir(), "watchdog-lifecycle.db")
	store, err := workspacedata.OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	var accesses atomic.Int64
	secondSweep := make(chan struct{})
	canceledSweepStoreRead := make(chan error, 1)
	releaseSweep := make(chan struct{})
	worker := tuttimodeexecutionservice.Worker{
		Executions:   &tuttimodeexecutionservice.Service{},
		LeaseOwner:   "watchdog-lifecycle-test",
		ScanInterval: time.Millisecond,
		WorkspaceIDs: func(ctx context.Context) ([]string, error) {
			call := accesses.Add(1)
			if _, err := store.List(context.Background()); err != nil {
				return nil, err
			}
			if call == 2 {
				close(secondSweep)
				<-ctx.Done()
				_, readErr := store.List(context.Background())
				canceledSweepStoreRead <- readErr
				<-releaseSweep
				return nil, ctx.Err()
			}
			return nil, nil
		},
	}
	readyCalls := 0
	wiring := &tuttiWiring{
		workspaceStore:          store,
		tuttiModeWatchdogWorker: &worker,
		tuttiModeWakeRecoveryStarter: func() {
			readyCalls++
		},
	}
	if accesses.Load() != 0 {
		t.Fatalf("watchdog accessed store before listener ready")
	}
	wiring.startTuttiModeWakeRecovery()
	wiring.startTuttiModeWakeRecovery()
	if readyCalls != 1 {
		t.Fatalf("listener-ready calls = %d, want 1", readyCalls)
	}
	select {
	case <-secondSweep:
	case <-time.After(time.Second):
		t.Fatal("watchdog did not reach ticker sweep")
	}

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- wiring.Close()
	}()
	select {
	case readErr := <-canceledSweepStoreRead:
		if readErr != nil {
			t.Fatalf("store closed before watchdog exit: %v", readErr)
		}
	case <-time.After(time.Second):
		t.Fatal("watchdog did not observe lifecycle cancellation")
	}
	select {
	case err := <-closeDone:
		t.Fatalf("Close() returned before watchdog exit: %v", err)
	default:
	}
	close(releaseSweep)
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, err := store.List(context.Background()); err == nil {
		t.Fatal("workspace store remained open after wiring Close")
	}
	stableAccesses := accesses.Load()
	time.Sleep(5 * time.Millisecond)
	if accesses.Load() != stableAccesses {
		t.Fatalf(
			"watchdog accessed store after Close: before=%d after=%d",
			stableAccesses, accesses.Load(),
		)
	}
	if err := wiring.Close(); err != nil {
		t.Fatalf("replayed Close() error = %v", err)
	}

	reopened, err := workspacedata.OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	restarted := make(chan struct{}, 1)
	restartWorker := tuttimodeexecutionservice.Worker{
		Executions:   &tuttimodeexecutionservice.Service{},
		LeaseOwner:   "watchdog-lifecycle-restart",
		ScanInterval: time.Millisecond,
		WorkspaceIDs: func(context.Context) ([]string, error) {
			select {
			case restarted <- struct{}{}:
			default:
			}
			_, err := reopened.List(context.Background())
			return nil, err
		},
	}
	restartWiring := &tuttiWiring{
		workspaceStore:               reopened,
		tuttiModeWatchdogWorker:      &restartWorker,
		tuttiModeWakeRecoveryStarter: func() {},
	}
	restartWiring.startTuttiModeWakeRecovery()
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("new daemon wiring did not restart watchdog")
	}
	if err := restartWiring.Close(); err != nil {
		t.Fatalf("restart wiring Close() error = %v", err)
	}
}

func TestTuttiModeWatchdogCloseBeforeStartPreventsLateStart(t *testing.T) {
	var accesses atomic.Int64
	worker := tuttimodeexecutionservice.Worker{
		Executions:   &tuttimodeexecutionservice.Service{},
		LeaseOwner:   "watchdog-close-before-start",
		ScanInterval: time.Millisecond,
		WorkspaceIDs: func(context.Context) ([]string, error) {
			accesses.Add(1)
			return nil, nil
		},
	}
	wiring := &tuttiWiring{
		tuttiModeWatchdogWorker:      &worker,
		tuttiModeWakeRecoveryStarter: func() {},
	}
	if err := wiring.Close(); err != nil {
		t.Fatal(err)
	}
	wiring.startTuttiModeWakeRecovery()
	time.Sleep(5 * time.Millisecond)
	if accesses.Load() != 0 {
		t.Fatalf("closed lifecycle started late: accesses=%d", accesses.Load())
	}
}
