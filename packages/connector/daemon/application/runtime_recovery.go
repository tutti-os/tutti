package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"
)

const runtimePlanningTimeout = 30 * time.Second

type runtimePlanningResult struct {
	connectorKey string
	planned      bool
	err          error
}

func (host *Host) notifyRuntimeRecovery() {
	select {
	case host.runtimeRecoveryWake <- struct{}{}:
	default:
	}
}

func (host *Host) runRuntimeRecoveryWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-host.runtimeRecoveryWake:
		}
		retry := time.Second
		for {
			pending, err := host.planPendingRuntimes(ctx)
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector runtime planning failed", "error", err)
			}
			if !pending {
				break
			}
			timer := time.NewTimer(retry)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-host.runtimeRecoveryWake:
				timer.Stop()
				retry = time.Second
			case <-timer.C:
				if retry < time.Minute {
					retry *= 2
				}
			}
		}
	}
}

// planPendingRuntimes makes durable Desired state visible without waiting for
// any runtime process. The convergence worker owns slow host interaction with
// bounded cross-Connector concurrency, so this method never holds the global
// bootstrap/fence mutex while one Connector is inspected.
func (host *Host) planPendingRuntimes(ctx context.Context) (bool, error) {
	host.bootstrapMu.Lock()
	if !host.bootstrapped || len(host.runtimeRecoveryPending) == 0 {
		host.bootstrapMu.Unlock()
		return false, nil
	}
	scope := host.bootstrapScope
	connectorKeys := make([]string, 0, len(host.runtimeRecoveryPending))
	for connectorKey := range host.runtimeRecoveryPending {
		connectorKeys = append(connectorKeys, connectorKey)
	}
	host.bootstrapMu.Unlock()
	sort.Strings(connectorKeys)

	semaphore := make(chan struct{}, runtimeConvergenceParallelism)
	results := make(chan runtimePlanningResult, len(connectorKeys))
	var wait sync.WaitGroup
	for _, connectorKey := range connectorKeys {
		connectorKey := connectorKey
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				results <- runtimePlanningResult{connectorKey: connectorKey, err: ctx.Err()}
				return
			}
			planContext, cancel := context.WithTimeout(ctx, runtimePlanningTimeout)
			planned, err := host.Application.PrepareInstalledRuntimeForScope(planContext, scope, connectorKey)
			cancel()
			results <- runtimePlanningResult{connectorKey: connectorKey, planned: planned, err: err}
		}()
	}
	go func() {
		wait.Wait()
		close(results)
	}()

	var resultErr error
	for result := range results {
		if result.err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("%s: %w", result.connectorKey, result.err))
		}
		host.bootstrapMu.Lock()
		if host.bootstrapped && host.bootstrapScope == scope && (result.planned || result.err == nil) {
			delete(host.runtimeRecoveryPending, result.connectorKey)
		}
		host.bootstrapMu.Unlock()
		if result.planned {
			host.notifyRuntimeConvergence()
		}
	}
	host.bootstrapMu.Lock()
	pending := len(host.runtimeRecoveryPending) > 0
	host.bootstrapMu.Unlock()
	return pending, resultErr
}
