package daemon

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	operationRecoveryScanInterval = 500 * time.Millisecond
	operationRetryBaseDelay       = 500 * time.Millisecond
	operationRetryMaxDelay        = 60 * time.Second
	operationRetryMaxShift        = 8
)

// operationRetryDelay spaces out repeated attempts for the same operation. The
// scan interval stays a latency hint for fresh work; without this delay a
// permanently failing effect would be replayed twice per second and would
// broadcast one market-changed event per replay.
func operationRetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return 0
	}
	shift := attempt - 2
	if shift > operationRetryMaxShift {
		return operationRetryMaxDelay
	}
	delay := operationRetryBaseDelay << shift
	if delay > operationRetryMaxDelay {
		return operationRetryMaxDelay
	}
	return delay
}

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
	now := time.Now().UTC()
	for _, operation := range operations {
		if delay := operationRetryDelay(int(operation.Attempt)); delay > 0 &&
			!operation.UpdatedAt.IsZero() && now.Sub(operation.UpdatedAt) < delay {
			continue
		}
		if err := host.scheduler.Schedule(ctx, operation.OperationID); err != nil {
			scheduleErr = errors.Join(scheduleErr, err)
		}
	}
	return scheduleErr
}
