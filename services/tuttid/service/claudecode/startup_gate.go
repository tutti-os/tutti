// Package claudecode owns process-wide coordination for operations that may
// read, refresh, or persist Claude Code credentials.
package claudecode

import "context"

type StartupGate struct {
	sem chan struct{}
}

func NewStartupGate() *StartupGate {
	return &StartupGate{sem: make(chan struct{}, 1)}
}

var DefaultStartupGate = NewStartupGate()

func (g *StartupGate) Acquire(ctx context.Context) error {
	select {
	case g.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *StartupGate) Release() {
	select {
	case <-g.sem:
	default:
	}
}
