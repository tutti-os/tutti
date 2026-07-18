package agenthost

import (
	"context"
	"log/slog"
	"time"
)

const defaultWorktreeGCSweepInterval = 5 * time.Minute

func (h *Host) RecoverWorktreeIsolation(ctx context.Context) error {
	if h == nil || h.worktreeGC == nil {
		return nil
	}
	return h.worktreeGC.SweepWorktreeIsolation(ctx)
}

func (h *Host) RunWorktreeGarbageCollectionWorker(ctx context.Context) {
	_ = h.runWorktreeGarbageCollectionWorker(ctx)
}

func (h *Host) runWorktreeGarbageCollectionWorker(ctx context.Context) error {
	if h == nil || h.worktreeGC == nil {
		<-ctx.Done()
		return ctx.Err()
	}
	ticker := time.NewTicker(defaultWorktreeGCSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := h.worktreeGC.SweepWorktreeIsolation(ctx); err != nil {
				slog.Warn("agent worktree garbage collection sweep failed",
					"event", "agent_session.worktree_gc.sweep_failed", "error", err)
			}
		}
	}
}
