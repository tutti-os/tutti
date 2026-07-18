package agenthost

import (
	"context"
	"errors"
)

// Run supervises every durable Host worker as one lifecycle. Per-item step
// errors remain retryable inside their worker; an infrastructure-level worker
// exit cancels its siblings so adapters cannot silently continue with a
// partially running Host.
func (h *Host) Run(ctx context.Context) error {
	if h == nil {
		return nil
	}
	return runSupervisedWorkers(ctx, []func(context.Context) error{
		h.runRuntimeOperationWorker,
		h.runGoalOperationWorker,
		h.runGoalReconcileInboxWorker,
	})
}

func runSupervisedWorkers(ctx context.Context, workers []func(context.Context) error) error {
	runCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	results := make(chan error, len(workers))
	for _, worker := range workers {
		worker := worker
		go func() {
			results <- worker(runCtx)
		}()
	}

	var workerErr error
	for range workers {
		err := <-results
		if err == nil || (runCtx.Err() != nil && errors.Is(err, runCtx.Err())) {
			continue
		}
		if workerErr == nil {
			workerErr = err
			cancel(err)
		}
	}
	if workerErr != nil {
		return workerErr
	}
	return ctx.Err()
}
