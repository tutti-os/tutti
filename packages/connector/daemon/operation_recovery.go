package daemon

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const operationRecoveryScanInterval = 500 * time.Millisecond

// runOperationRecoveryWorker is the durable-operation anti-entropy loop.
// Scheduling is only a latency hint: accepted/running work is rediscovered
// after a dropped wake, a retryable effect failure, or a daemon restart.
func (host *Host) runOperationRecoveryWorker(ctx context.Context) {
	ticker := time.NewTicker(operationRecoveryScanInterval)
	defer ticker.Stop()
	for {
		if err := host.scheduleRecoverableOperations(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector operation recovery scan failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (host *Host) scheduleRecoverableOperations(ctx context.Context) error {
	operations, err := host.repository.RecoverableOperations(ctx)
	if err != nil {
		return err
	}
	var scheduleErr error
	for _, operation := range operations {
		if err := host.scheduler.Schedule(ctx, operation.OperationID); err != nil {
			scheduleErr = errors.Join(scheduleErr, err)
		}
	}
	return scheduleErr
}
