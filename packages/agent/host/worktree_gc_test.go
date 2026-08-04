package agenthost

import (
	"context"
	"errors"
	"testing"
)

type recordingWorktreeGarbageCollector struct {
	calls int
	err   error
}

func (c *recordingWorktreeGarbageCollector) SweepWorktreeIsolation(context.Context) error {
	c.calls++
	return c.err
}

func TestRecoverCoreDoesNotSweepWorktreeIsolation(t *testing.T) {
	collector := &recordingWorktreeGarbageCollector{}
	host := New(Config{WorktreeGC: collector})
	if err := host.RecoverCore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if collector.calls != 0 {
		t.Fatalf("RecoverCore sweep calls = %d, want 0", collector.calls)
	}
}

func TestExplicitWorktreeRecoveryReturnsSweepFailure(t *testing.T) {
	sweepErr := errors.New("sweep failed")
	host := New(Config{WorktreeGC: &recordingWorktreeGarbageCollector{err: sweepErr}})
	if err := host.RecoverWorktreeIsolation(context.Background()); !errors.Is(err, sweepErr) {
		t.Fatalf("RecoverWorktreeIsolation error = %v, want %v", err, sweepErr)
	}
}
