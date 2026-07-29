package main

import (
	"context"
	"errors"
	"log/slog"

	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func newTuttiModeWatchdogWorker(
	ctx context.Context,
	executions *tuttimodeexecutionservice.Service,
	leaseOwner string,
	workspaceIDs tuttimodeexecutionservice.WorkspaceLister,
) tuttimodeexecutionservice.Worker {
	return tuttimodeexecutionservice.Worker{
		Executions: executions, WorkspaceIDs: workspaceIDs, LeaseOwner: leaseOwner,
		OnError: func(err error) {
			slog.WarnContext(
				ctx,
				"Tutti mode watchdog sweep failed",
				"event", "tutti_mode_execution.watchdog_sweep_failed",
				"error", err,
			)
		},
	}
}

func startTuttiModeWatchdogWorker(
	ctx context.Context,
	worker tuttimodeexecutionservice.Worker,
) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := worker.Run(ctx); err != nil &&
			!errors.Is(err, context.Canceled) {
			slog.ErrorContext(
				ctx,
				"Tutti mode watchdog worker stopped",
				"event", "tutti_mode_execution.watchdog_worker_stopped",
				"error", err,
			)
		}
	}()
	return done
}
