package daemon

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

type OperationExecutor interface {
	ExecuteOperation(context.Context, string) error
}

type OperationScheduler struct {
	ctx      context.Context
	executor OperationExecutor
	mu       sync.RWMutex
	active   map[string]struct{}
	wait     sync.WaitGroup
}

var _ market.OperationScheduler = (*OperationScheduler)(nil)

func NewOperationScheduler(ctx context.Context) *OperationScheduler {
	if ctx == nil {
		ctx = context.Background()
	}
	return &OperationScheduler{ctx: ctx, active: make(map[string]struct{})}
}

func (scheduler *OperationScheduler) Bind(executor OperationExecutor) error {
	if executor == nil {
		return errors.New("connector market operation executor is required")
	}
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.executor != nil {
		return errors.New("connector market operation executor is already bound")
	}
	scheduler.executor = executor
	return nil
}

func (scheduler *OperationScheduler) Schedule(_ context.Context, operationID string) error {
	scheduler.mu.Lock()
	if scheduler.executor == nil {
		scheduler.mu.Unlock()
		return errors.New("connector market operation executor is not bound")
	}
	if _, running := scheduler.active[operationID]; running {
		scheduler.mu.Unlock()
		return nil
	}
	scheduler.active[operationID] = struct{}{}
	executor := scheduler.executor
	scheduler.wait.Add(1)
	scheduler.mu.Unlock()

	go func() {
		defer scheduler.wait.Done()
		defer func() {
			scheduler.mu.Lock()
			delete(scheduler.active, operationID)
			scheduler.mu.Unlock()
		}()
		if err := executor.ExecuteOperation(scheduler.ctx, operationID); err != nil {
			slog.Warn("connector market operation failed", "operationId", operationID, "error", err)
		}
	}()
	return nil
}

func (scheduler *OperationScheduler) Wait() {
	scheduler.wait.Wait()
}

type ChangedEventPublisher interface {
	PublishConnectorMarketChanged(context.Context, market.ChangedEvent) error
}

const (
	DefaultTerminalOperationRetention = 24 * time.Hour
	DefaultPublishedEventRetention    = time.Hour
	DefaultLifecycleCleanupInterval   = time.Hour
	DefaultLifecycleCleanupBatchSize  = 500
)

type LifecycleCleanupPolicy struct {
	TerminalOperationRetention time.Duration
	PublishedEventRetention    time.Duration
	Interval                   time.Duration
	BatchSize                  int
}

type LifecycleCleanupWorker struct {
	Store  market.LifecycleCleanupStore
	Now    func() time.Time
	Policy LifecycleCleanupPolicy
}

func (worker LifecycleCleanupWorker) Run(ctx context.Context) {
	policy := normalizedLifecycleCleanupPolicy(worker.Policy)
	worker.Policy = policy
	if err := worker.Cleanup(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.Warn("connector market lifecycle cleanup failed", "error", err)
	}
	ticker := time.NewTicker(policy.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := worker.Cleanup(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector market lifecycle cleanup failed", "error", err)
			}
		}
	}
}

func (worker LifecycleCleanupWorker) Cleanup(ctx context.Context) error {
	if worker.Store == nil {
		return errors.New("connector market lifecycle cleanup store is required")
	}
	policy := normalizedLifecycleCleanupPolicy(worker.Policy)
	now := time.Now().UTC()
	if worker.Now != nil {
		now = worker.Now().UTC()
	}
	request := market.LifecycleCleanupRequest{
		TerminalOperationsUpdatedThrough: now.Add(-policy.TerminalOperationRetention),
		PublishedEventsPublishedThrough:  now.Add(-policy.PublishedEventRetention),
		BatchSize:                        policy.BatchSize,
	}
	var total market.LifecycleCleanupResult
	for {
		result, err := worker.Store.CleanupLifecycle(ctx, request)
		if err != nil {
			return err
		}
		total.TerminalOperationsDeleted += result.TerminalOperationsDeleted
		total.PublishedEventsDeleted += result.PublishedEventsDeleted
		if result.TerminalOperationsDeleted < int64(policy.BatchSize) &&
			result.PublishedEventsDeleted < int64(policy.BatchSize) {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if total.TerminalOperationsDeleted > 0 || total.PublishedEventsDeleted > 0 {
		slog.Info("connector market lifecycle cleanup completed",
			"terminalOperationsDeleted", total.TerminalOperationsDeleted,
			"publishedEventsDeleted", total.PublishedEventsDeleted,
			"terminalOperationRetention", policy.TerminalOperationRetention,
			"publishedEventRetention", policy.PublishedEventRetention)
	}
	return nil
}

func normalizedLifecycleCleanupPolicy(policy LifecycleCleanupPolicy) LifecycleCleanupPolicy {
	if policy.TerminalOperationRetention <= 0 {
		policy.TerminalOperationRetention = DefaultTerminalOperationRetention
	}
	if policy.PublishedEventRetention <= 0 {
		policy.PublishedEventRetention = DefaultPublishedEventRetention
	}
	if policy.Interval <= 0 {
		policy.Interval = DefaultLifecycleCleanupInterval
	}
	if policy.BatchSize <= 0 || policy.BatchSize > DefaultLifecycleCleanupBatchSize {
		policy.BatchSize = DefaultLifecycleCleanupBatchSize
	}
	return policy
}

type OutboxDispatcher struct {
	Outbox    market.ChangedEventOutbox
	Publisher ChangedEventPublisher
	Now       func() time.Time
	Interval  time.Duration
}

func (dispatcher OutboxDispatcher) Run(ctx context.Context) {
	interval := dispatcher.Interval
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := dispatcher.Flush(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector market outbox delivery failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (dispatcher OutboxDispatcher) Flush(ctx context.Context) error {
	if dispatcher.Outbox == nil || dispatcher.Publisher == nil {
		return errors.New("connector market outbox dependencies are required")
	}
	now := dispatcher.Now
	if now == nil {
		now = time.Now
	}
	for {
		entries, err := dispatcher.Outbox.PendingChangedEvents(ctx, 100)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		for _, entry := range entries {
			event := entry.Event
			event.Cursor = entry.Sequence
			if err := dispatcher.Publisher.PublishConnectorMarketChanged(ctx, event); err != nil {
				return err
			}
			if err := dispatcher.Outbox.MarkChangedEventPublished(ctx, entry.Sequence, now().UTC()); err != nil {
				return err
			}
		}
	}
}
