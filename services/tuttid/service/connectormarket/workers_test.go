package connectormarket

import (
	"context"
	"sync"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
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
	if len(publisher.events) != 1 || len(outbox.marked) != 1 || outbox.marked[0] != 1 {
		t.Fatalf("published=%#v marked=%#v", publisher.events, outbox.marked)
	}
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
