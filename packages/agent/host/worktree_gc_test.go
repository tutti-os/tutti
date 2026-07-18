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

func TestRecoverSweepsWorktreeIsolation(t *testing.T) {
	collector := &recordingWorktreeGarbageCollector{}
	host := New(Config{WorktreeGC: collector})
	if err := host.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if collector.calls != 1 {
		t.Fatalf("sweep calls = %d, want 1", collector.calls)
	}
}

func TestRecoverReturnsWorktreeIsolationSweepFailure(t *testing.T) {
	sweepErr := errors.New("sweep failed")
	host := New(Config{WorktreeGC: &recordingWorktreeGarbageCollector{err: sweepErr}})
	if err := host.Recover(context.Background()); !errors.Is(err, sweepErr) {
		t.Fatalf("Recover error = %v, want %v", err, sweepErr)
	}
}
