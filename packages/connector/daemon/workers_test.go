package daemon

import (
	"context"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestOperationSchedulerDeduplicatesActiveOperation(t *testing.T) {
	executor := &blockingExecutor{started: make(chan struct{}), release: make(chan struct{})}
	scheduler := NewOperationScheduler(context.Background())
	if err := scheduler.Bind(executor); err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Schedule(context.Background(), "operation-1"); err != nil {
		t.Fatal(err)
	}
	<-executor.started
	if err := scheduler.Schedule(context.Background(), "operation-1"); err != nil {
		t.Fatal(err)
	}
	close(executor.release)
	scheduler.Wait()
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
}

type blockingExecutor struct {
	mu      sync.Mutex
	calls   int
	started chan struct{}
	release chan struct{}
}

func (executor *blockingExecutor) ExecuteOperation(context.Context, string) error {
	executor.mu.Lock()
	executor.calls++
	executor.mu.Unlock()
	close(executor.started)
	<-executor.release
	return nil
}

func TestOutboxDispatcherMarksOnlyPublishedEvents(t *testing.T) {
	outbox := &memoryOutbox{entries: []market.ChangedEventRecord{{Sequence: 1, Event: market.ChangedEvent{Revision: 2}}}}
	publisher := &memoryPublisher{}
	dispatcher := OutboxDispatcher{Outbox: outbox, Publisher: publisher, Now: func() time.Time { return time.Unix(10, 0) }}
	if err := dispatcher.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 1 || publisher.events[0].Cursor != 1 || len(outbox.marked) != 1 || outbox.marked[0] != 1 {
		t.Fatalf("published=%#v marked=%#v", publisher.events, outbox.marked)
	}
}

func TestLifecycleCleanupWorkerUsesFiniteRetentionCutoffs(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	store := &memoryLifecycleCleanupStore{}
	worker := LifecycleCleanupWorker{
		Store: store,
		Now:   func() time.Time { return now },
		Policy: LifecycleCleanupPolicy{
			TerminalOperationRetention: 24 * time.Hour,
			PublishedEventRetention:    time.Hour,
			BatchSize:                  37,
		},
	}
	if err := worker.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	requests := store.snapshot()
	if len(requests) != 1 || !requests[0].TerminalOperationsUpdatedThrough.Equal(now.Add(-24*time.Hour)) ||
		!requests[0].PublishedEventsPublishedThrough.Equal(now.Add(-time.Hour)) || requests[0].BatchSize != 37 {
		t.Fatalf("cleanup requests = %#v", requests)
	}
}

func TestLifecycleCleanupWorkerRunsAtStartupAndPeriodically(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := &memoryLifecycleCleanupStore{called: make(chan struct{}, 3)}
	worker := LifecycleCleanupWorker{
		Store:  store,
		Policy: LifecycleCleanupPolicy{Interval: 5 * time.Millisecond},
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Run(ctx)
	}()
	for range 2 {
		select {
		case <-store.called:
		case <-time.After(time.Second):
			t.Fatal("lifecycle cleanup worker did not run")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("lifecycle cleanup worker did not stop")
	}
	if len(store.snapshot()) < 2 {
		t.Fatalf("cleanup calls = %d, want startup and periodic calls", len(store.snapshot()))
	}
}

func TestLifecycleCleanupWorkerDrainsBacklogInBoundedTransactions(t *testing.T) {
	store := &memoryLifecycleCleanupStore{results: []market.LifecycleCleanupResult{
		{TerminalOperationsDeleted: 5, PublishedEventsDeleted: 5},
		{TerminalOperationsDeleted: 5},
		{TerminalOperationsDeleted: 1},
	}}
	worker := LifecycleCleanupWorker{Store: store, Policy: LifecycleCleanupPolicy{BatchSize: 5}}
	if err := worker.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	requests := store.snapshot()
	if len(requests) != 3 {
		t.Fatalf("cleanup calls = %d, want 3 bounded transactions", len(requests))
	}
	for _, request := range requests {
		if request.BatchSize != 5 {
			t.Fatalf("cleanup batch size = %d, want 5", request.BatchSize)
		}
	}
}

type memoryLifecycleCleanupStore struct {
	mu       sync.Mutex
	requests []market.LifecycleCleanupRequest
	results  []market.LifecycleCleanupResult
	called   chan struct{}
}

func (store *memoryLifecycleCleanupStore) CleanupLifecycle(_ context.Context, request market.LifecycleCleanupRequest) (market.LifecycleCleanupResult, error) {
	store.mu.Lock()
	store.requests = append(store.requests, request)
	var result market.LifecycleCleanupResult
	if len(store.results) > 0 {
		result = store.results[0]
		store.results = store.results[1:]
	}
	store.mu.Unlock()
	if store.called != nil {
		store.called <- struct{}{}
	}
	return result, nil
}

func (store *memoryLifecycleCleanupStore) snapshot() []market.LifecycleCleanupRequest {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]market.LifecycleCleanupRequest(nil), store.requests...)
}

type memoryOutbox struct {
	entries []market.ChangedEventRecord
	marked  []int64
}

func (outbox *memoryOutbox) PendingChangedEvents(context.Context, int) ([]market.ChangedEventRecord, error) {
	pending := make([]market.ChangedEventRecord, 0, len(outbox.entries))
	for _, entry := range outbox.entries {
		alreadyMarked := false
		for _, sequence := range outbox.marked {
			alreadyMarked = alreadyMarked || sequence == entry.Sequence
		}
		if !alreadyMarked {
			pending = append(pending, entry)
		}
	}
	return pending, nil
}

func (outbox *memoryOutbox) MarkChangedEventPublished(_ context.Context, sequence int64, _ time.Time) error {
	outbox.marked = append(outbox.marked, sequence)
	return nil
}

type memoryPublisher struct{ events []market.ChangedEvent }

func (publisher *memoryPublisher) PublishConnectorMarketChanged(_ context.Context, event market.ChangedEvent) error {
	publisher.events = append(publisher.events, event)
	return nil
}
