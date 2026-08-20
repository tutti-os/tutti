package linkmanager

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testMetadata struct {
	Peer string
}

type blockingCloseLink struct {
	*fakeLink
	closeStarted chan struct{}
	releaseClose chan struct{}
	startOnce    sync.Once
}

func newBlockingCloseLink() *blockingCloseLink {
	return &blockingCloseLink{
		fakeLink:     newFakeLink(),
		closeStarted: make(chan struct{}),
		releaseClose: make(chan struct{}),
	}
}

func (link *blockingCloseLink) Close() error {
	link.startOnce.Do(func() { close(link.closeStarted) })
	<-link.releaseClose
	return link.fakeLink.Close()
}

func TestManagerReusesLinkAndExpiresOnlyAfterLastStreamCloses(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: 30 * time.Millisecond,
	})
	link := newFakeLink()
	registerTestLink(t, manager, "peer", "connection", link, nil)

	stream, err := manager.OpenStream(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if !manager.Ready("peer") {
		t.Fatal("active stream did not keep the pooled link ready")
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		return !manager.Ready("peer") && link.closeCount.Load() == 1
	})
}

func TestManagerRejectsLateLinkAfterGenerationInvalidation(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	admission, err := manager.Admit(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	manager.Invalidate("peer")
	if !errors.Is(context.Cause(admission.Context()), ErrAdmissionInvalidated) {
		t.Fatalf("admission cause = %v, want invalidated", context.Cause(admission.Context()))
	}
	link := newFakeLink()
	_, err = manager.Register(admission, Registration[string, testMetadata]{
		Key: "peer", ConnectionID: "late", Link: link,
	})
	if !errors.Is(err, ErrAdmissionInvalidated) {
		t.Fatalf("Register error = %v, want invalidated", err)
	}
	if link.closeCount.Load() != 1 || manager.Ready("peer") {
		t.Fatalf("late link close=%d ready=%v", link.closeCount.Load(), manager.Ready("peer"))
	}
	admission.Close()
}

func TestManagerRetireDoesNotMakeReplacementWaitForOldClose(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
	})
	old := newBlockingCloseLink()
	registerTestLink(t, manager, "peer", "old", old, nil)

	retired := manager.Retire("peer")
	if manager.Ready("peer") {
		t.Fatal("retired link remained ready")
	}
	closeDone := make(chan error, 1)
	go func() { closeDone <- retired.Close() }()
	select {
	case <-old.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("old physical close did not start")
	}

	replacement := newFakeLink()
	registerTestLink(t, manager, "peer", "replacement", replacement, nil)
	if !manager.Ready("peer") {
		t.Fatal("replacement did not become ready while old close was blocked")
	}
	stream, err := manager.OpenStream(context.Background(), "peer")
	if err != nil {
		t.Fatalf("OpenStream through replacement: %v", err)
	}
	_ = stream.Close()

	close(old.releaseClose)
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("old retirement close: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("old retirement close did not finish")
	}
	if !manager.Ready("peer") {
		t.Fatal("late old close removed the replacement")
	}
	if replacement.closeCount.Load() != 0 {
		t.Fatalf("late old close closed replacement %d times", replacement.closeCount.Load())
	}
	manager.Invalidate("peer")
}

func TestManagerRetireAllReturnsExactIndependentHandles(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
	})
	first := newFakeLink()
	second := newFakeLink()
	registerTestLink(t, manager, "first", "first-old", first, nil)
	registerTestLink(t, manager, "second", "second-old", second, nil)

	retirements := manager.RetireAll()
	if len(retirements) != 2 {
		t.Fatalf("RetireAll returned %d handles, want 2", len(retirements))
	}
	if manager.Ready("first") || manager.Ready("second") {
		t.Fatal("RetireAll left an old link ready")
	}
	replacement := newFakeLink()
	registerTestLink(t, manager, "first", "first-new", replacement, nil)
	for index := range retirements {
		if err := retirements[index].Close(); err != nil {
			t.Fatalf("close retirement: %v", err)
		}
	}
	if !manager.Ready("first") || replacement.closeCount.Load() != 0 {
		t.Fatal("retired handle affected the replacement")
	}
	manager.Invalidate("first")
}

func TestManagerRejectsLinkAfterAdmissionContextCancellation(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	ctx, cancel := context.WithCancel(context.Background())
	admission, err := manager.Admit(ctx, "peer")
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	cancel()
	link := newFakeLink()
	_, err = manager.Register(admission, Registration[string, testMetadata]{
		Key: "peer", ConnectionID: "late", Link: link,
	})
	if !errors.Is(err, ErrAdmissionInvalidated) {
		t.Fatalf("Register error = %v, want invalidated", err)
	}
	if link.closeCount.Load() != 1 || manager.Ready("peer") {
		t.Fatalf("canceled link close=%d ready=%v", link.closeCount.Load(), manager.Ready("peer"))
	}
}

func TestManagerDisableFencesAttemptsUntilReenabled(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	admission, err := manager.Admit(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	if err := manager.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(context.Cause(admission.Context()), ErrAdmissionInvalidated) {
		t.Fatalf("disabled admission cause = %v, want invalidated", context.Cause(admission.Context()))
	}
	if _, err := manager.Admit(context.Background(), "peer"); !errors.Is(err, ErrManagerDisabled) {
		t.Fatalf("Admit while disabled error = %v, want disabled", err)
	}
	late := newFakeLink()
	if _, err := manager.Register(admission, Registration[string, testMetadata]{
		Key: "peer", ConnectionID: "late", Link: late,
	}); !errors.Is(err, ErrAdmissionInvalidated) {
		t.Fatalf("late Register error = %v, want invalidated", err)
	}
	if late.closeCount.Load() != 1 {
		t.Fatalf("late link close count = %d, want 1", late.closeCount.Load())
	}
	if err := manager.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	replacement := newFakeLink()
	registerTestLink(t, manager, "peer", "replacement", replacement, nil)
	if !manager.Ready("peer") {
		t.Fatal("manager did not admit a link after re-enable")
	}
	manager.InvalidateAll()
}

func TestManagerReenableDoesNotWaitForStaleEstablishmentFlight(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
	})
	oldStarted := make(chan struct{})
	releaseOld := make(chan struct{})
	oldResult := make(chan error, 1)
	go func() {
		stream, err := manager.OpenOrConnect(
			context.Background(),
			"peer",
			func(context.Context, *Admission[string, testMetadata]) (Registration[string, testMetadata], error) {
				close(oldStarted)
				<-releaseOld
				return Registration[string, testMetadata]{
					Key: "peer", ConnectionID: "old", Link: newFakeLink(),
				}, nil
			},
		)
		if stream != nil {
			_ = stream.Close()
		}
		oldResult <- err
	}()
	<-oldStarted
	if err := manager.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if err := manager.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	freshResult := make(chan error, 1)
	go func() {
		stream, err := manager.OpenOrConnect(
			context.Background(),
			"peer",
			func(context.Context, *Admission[string, testMetadata]) (Registration[string, testMetadata], error) {
				return Registration[string, testMetadata]{
					Key: "peer", ConnectionID: "fresh", Link: newFakeLink(),
				}, nil
			},
		)
		if stream != nil {
			_ = stream.Close()
		}
		freshResult <- err
	}()
	select {
	case err := <-freshResult:
		if err != nil {
			t.Fatalf("fresh establishment: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("fresh establishment waited for stale flight")
	}
	close(releaseOld)
	if err := <-oldResult; !errors.Is(err, ErrAdmissionInvalidated) {
		t.Fatalf("stale establishment error = %v, want invalidated", err)
	}
	manager.InvalidateAll()
}

func TestManagerResolvesCollisionDeterministically(t *testing.T) {
	t.Parallel()
	now := time.Unix(100, 0)
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		Now:             func() time.Time { return now },
		CollisionWindow: 5 * time.Second,
	})
	incumbent := newFakeLink()
	registerTestLink(t, manager, "peer", "b", incumbent, nil)
	winner := newFakeLink()
	if disposition := registerTestLink(t, manager, "peer", "a", winner, nil); disposition != RegisterReplaced {
		t.Fatalf("lower connection id disposition = %q, want replaced", disposition)
	}
	if incumbent.closeCount.Load() != 1 || winner.closeCount.Load() != 0 {
		t.Fatalf("collision close counts incumbent=%d winner=%d", incumbent.closeCount.Load(), winner.closeCount.Load())
	}
	rejected := newFakeLink()
	if disposition := registerTestLink(t, manager, "peer", "z", rejected, nil); disposition != RegisterKeptExisting {
		t.Fatalf("higher connection id disposition = %q, want kept_existing", disposition)
	}
	if rejected.closeCount.Load() != 1 {
		t.Fatalf("rejected link close count = %d, want 1", rejected.closeCount.Load())
	}
	now = now.Add(6 * time.Second)
	outsideWindow := newFakeLink()
	if disposition := registerTestLink(t, manager, "peer", "0", outsideWindow, nil); disposition != RegisterKeptExisting {
		t.Fatalf("outside-window disposition = %q, want kept_existing", disposition)
	}
	manager.Invalidate("peer")
	if winner.closeCount.Load() != 1 {
		t.Fatalf("winning link close count = %d, want 1", winner.closeCount.Load())
	}
}

func TestManagerOpenOrConnectSerializesEstablishmentPerKey(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
	})
	var establishCalls atomic.Int32
	release := make(chan struct{})
	establish := func(
		ctx context.Context,
		_ *Admission[string, testMetadata],
	) (Registration[string, testMetadata], error) {
		establishCalls.Add(1)
		select {
		case <-ctx.Done():
			return Registration[string, testMetadata]{}, ctx.Err()
		case <-release:
		}
		return Registration[string, testMetadata]{
			Key: "peer", ConnectionID: "connection", Link: newFakeLink(),
		}, nil
	}

	const callers = 8
	start := make(chan struct{})
	results := make(chan error, callers)
	var ready sync.WaitGroup
	ready.Add(callers)
	for range callers {
		go func() {
			ready.Done()
			<-start
			stream, err := manager.OpenOrConnect(context.Background(), "peer", establish)
			if stream != nil {
				_ = stream.Close()
			}
			results <- err
		}()
	}
	ready.Wait()
	close(start)
	waitFor(t, time.Second, func() bool { return establishCalls.Load() == 1 })
	close(release)
	for range callers {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if establishCalls.Load() != 1 {
		t.Fatalf("establish calls = %d, want 1", establishCalls.Load())
	}
	manager.InvalidateAll()
}

func TestManagerCanceledOpenDoesNotCloseHealthySharedLink(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
	})
	link := &cancelableOpenLink{fakeLink: newFakeLink()}
	registerTestLink(t, manager, "peer", "connection", link, nil)
	active, err := manager.OpenStream(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	link.cancelNext.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.OpenStream(ctx, "peer"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled OpenStream error = %v, want context canceled", err)
	}
	if !manager.Ready("peer") || link.closeCount.Load() != 0 {
		t.Fatalf("canceled open removed healthy link: ready=%v close=%d", manager.Ready("peer"), link.closeCount.Load())
	}
	link.cancelNext.Store(true)
	var establishCalls atomic.Int32
	if _, err := manager.OpenOrConnect(ctx, "peer", func(
		context.Context,
		*Admission[string, testMetadata],
	) (Registration[string, testMetadata], error) {
		establishCalls.Add(1)
		return Registration[string, testMetadata]{}, errors.New("unexpected establish")
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled OpenOrConnect error = %v, want context canceled", err)
	}
	if establishCalls.Load() != 0 {
		t.Fatalf("canceled OpenOrConnect establish calls = %d, want 0", establishCalls.Load())
	}
	if err := active.Close(); err != nil {
		t.Fatal(err)
	}
	manager.Invalidate("peer")
}

func TestManagerEventsProvideTerminalSequenceAcrossConcurrentCallbacks(t *testing.T) {
	t.Parallel()
	var (
		mu        sync.Mutex
		events    []LinkEvent[string, testMetadata]
		readySeen = make(chan struct{})
		release   = make(chan struct{})
	)
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{
		IdleGrace: time.Minute,
		Observe: func(event LinkEvent[string, testMetadata]) {
			if event.State == LinkReady && event.Sequence == 2 {
				close(readySeen)
				<-release
			}
			mu.Lock()
			events = append(events, event)
			mu.Unlock()
		},
	})
	link := newFakeLink()
	registerTestLink(t, manager, "peer", "connection", link, nil)
	opened := make(chan net.Conn, 1)
	go func() {
		stream, _ := manager.OpenStream(context.Background(), "peer")
		opened <- stream
	}()
	select {
	case <-readySeen:
	case <-time.After(time.Second):
		t.Fatal("second ready callback did not start")
	}
	manager.Invalidate("peer")
	close(release)
	if stream := <-opened; stream != nil {
		_ = stream.Close()
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 3 {
		t.Fatalf("events = %#v, want initial ready, disconnected, delayed ready", events)
	}
	if events[1].State != LinkDisconnected || events[1].Sequence != 3 ||
		events[2].State != LinkReady || events[2].Sequence != 2 {
		t.Fatalf("callback completion order = %#v, want terminal sequence to dominate delayed ready", events)
	}
}

func TestManagerRoutesIncomingStreamWithTypedMetadata(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	link := newFakeLink()
	handled := make(chan IncomingStream[string, testMetadata], 1)
	registerTestLink(t, manager, "peer", "connection", link, func(
		_ context.Context,
		stream IncomingStream[string, testMetadata],
	) error {
		handled <- stream
		return nil
	})
	link.queueIncoming(newTrackingConn())
	select {
	case incoming := <-handled:
		if incoming.Key != "peer" || incoming.ConnectionID != "connection" || incoming.Metadata.Peer != "peer-label" {
			t.Fatalf("incoming stream = %#v", incoming)
		}
	case <-time.After(time.Second):
		t.Fatal("incoming stream was not handled")
	}
	manager.Invalidate("peer")
}

func TestManagerQuiescenceCancelsAdmissionsAndRejectsNewWork(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	admission, err := manager.Admit(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	manager.BeginQuiescence()
	if !errors.Is(context.Cause(admission.Context()), ErrAdmissionInvalidated) {
		t.Fatalf("admission cause = %v, want invalidated", context.Cause(admission.Context()))
	}
	if _, err := manager.Admit(context.Background(), "peer"); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("Admit after quiescence error = %v, want manager closed", err)
	}
	admission.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.WaitForQuiescence(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestManagerWaitForQuiescenceBeginsShutdown(t *testing.T) {
	t.Parallel()
	manager := NewManager[string, testMetadata](ManagerConfig[string, testMetadata]{})
	admission, err := manager.Admit(context.Background(), "peer")
	if err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() {
		waited <- manager.WaitForQuiescence(context.Background())
	}()
	waitFor(t, time.Second, func() bool {
		return errors.Is(context.Cause(admission.Context()), ErrAdmissionInvalidated)
	})
	if _, err := manager.Admit(context.Background(), "peer"); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("Admit while waiting error = %v, want manager closed", err)
	}
	admission.Close()
	select {
	case err := <-waited:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitForQuiescence did not finish")
	}
}

func registerTestLink(
	t *testing.T,
	manager *Manager[string, testMetadata],
	key, connectionID string,
	link Link,
	handler IncomingHandler[string, testMetadata],
) RegisterDisposition {
	t.Helper()
	admission, err := manager.Admit(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	disposition, err := manager.Register(admission, Registration[string, testMetadata]{
		Key:            key,
		ConnectionID:   connectionID,
		Link:           link,
		Metadata:       testMetadata{Peer: "peer-label"},
		HandleIncoming: handler,
	})
	if err != nil {
		t.Fatal(err)
	}
	return disposition
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not satisfied before timeout")
		}
		time.Sleep(time.Millisecond)
	}
}

var _ net.Conn = (*trackingConn)(nil)
