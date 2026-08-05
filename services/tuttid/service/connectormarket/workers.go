package connectormarket

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
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
			if err := dispatcher.Publisher.PublishConnectorMarketChanged(ctx, entry.Event); err != nil {
				return err
			}
			if err := dispatcher.Outbox.MarkChangedEventPublished(ctx, entry.Sequence, now().UTC()); err != nil {
				return err
			}
		}
	}
}
