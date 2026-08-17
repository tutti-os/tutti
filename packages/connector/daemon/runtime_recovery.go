package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func (host *Host) reconcilePendingRuntimesLocked(ctx context.Context, scope market.OperationScope) error {
	connectorKeys := make([]string, 0, len(host.runtimeRecoveryPending))
	for connectorKey := range host.runtimeRecoveryPending {
		connectorKeys = append(connectorKeys, connectorKey)
	}
	sort.Strings(connectorKeys)
	var reconcileErr error
	for _, connectorKey := range connectorKeys {
		if err := host.reconcileRuntimeForScopeLocked(ctx, scope, connectorKey); err != nil {
			reconcileErr = errors.Join(reconcileErr, fmt.Errorf("%s: %w", connectorKey, err))
			continue
		}
		delete(host.runtimeRecoveryPending, connectorKey)
	}
	return reconcileErr
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
			timer := time.NewTimer(retry)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-host.runtimeRecoveryWake:
				timer.Stop()
				retry = time.Second
				continue
			case <-timer.C:
			}
			reconcileContext, cancel := context.WithTimeout(ctx, 45*time.Second)
			host.bootstrapMu.Lock()
			if !host.bootstrapped || len(host.runtimeRecoveryPending) == 0 {
				host.bootstrapMu.Unlock()
				cancel()
				break
			}
			err := host.reconcilePendingRuntimesLocked(reconcileContext, host.bootstrapScope)
			pending := len(host.runtimeRecoveryPending) > 0
			host.bootstrapMu.Unlock()
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector runtime recovery retry failed", "error", err)
			}
			if !pending {
				break
			}
			if retry < time.Minute {
				retry *= 2
			}
		}
	}
}
