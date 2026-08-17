package daemon

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

const (
	runtimeConvergenceScanInterval = 500 * time.Millisecond
	runtimeConvergenceBatchSize    = 32
	runtimeConvergenceParallelism  = 4
	runtimeConvergenceTimeout      = 2 * time.Minute
)

// runRuntimeConvergenceWorker continuously repairs durable Desired/Observed
// drift. The periodic scan is authoritative; command scheduling only reduces
// latency and is therefore not required for crash recovery.
func (host *Host) runRuntimeConvergenceWorker(ctx context.Context) {
	ticker := time.NewTicker(runtimeConvergenceScanInterval)
	defer ticker.Stop()
	for {
		if err := host.convergeDueRuntimes(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector runtime convergence scan failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (host *Host) convergeDueRuntimes(ctx context.Context) error {
	host.bootstrapMu.Lock()
	bootstrapped, scope := host.bootstrapped, host.bootstrapScope
	host.bootstrapMu.Unlock()
	if !bootstrapped {
		return nil
	}
	due, err := host.Application.DueRuntimeConvergences(ctx, scope, runtimeConvergenceBatchSize)
	if err != nil || len(due) == 0 {
		return err
	}
	semaphore := make(chan struct{}, runtimeConvergenceParallelism)
	errorsFound := make(chan error, len(due))
	var wait sync.WaitGroup
	for _, convergence := range due {
		connectorKey := convergence.Desired.ConnectorKey
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				errorsFound <- ctx.Err()
				return
			}
			convergeContext, cancel := context.WithTimeout(ctx, runtimeConvergenceTimeout)
			err := host.Application.ConvergeRuntime(convergeContext, scope, connectorKey)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				errorsFound <- err
			}
		}()
	}
	wait.Wait()
	close(errorsFound)
	var result error
	for err := range errorsFound {
		result = errors.Join(result, err)
	}
	return result
}
