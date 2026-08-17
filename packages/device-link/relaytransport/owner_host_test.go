package relaytransport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

func TestOwnerHostServesRealRelayStreams(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-1"))
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(_ context.Context, stream net.Conn) error {
		request := make([]byte, 4)
		if _, err := io.ReadFull(stream, request); err != nil {
			return err
		}
		_, err := stream.Write([]byte("echo:" + string(request)))
		return err
	}), nil)

	if err := host.Acquire(context.Background(), "agent-owner"); err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer func() {
		if err := host.Release("agent-owner"); err != nil {
			t.Errorf("Release() error = %v", err)
		}
	}()

	session := relay.WaitSession(t)
	if session.ownerID != "owner-1" {
		t.Fatalf("owner query = %q, want owner-1", session.ownerID)
	}
	if session.authorization != "Bearer owner-token" {
		t.Fatalf("authorization = %q, want owner token", session.authorization)
	}
	stream, err := session.mux.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	defer stream.Close()
	if _, err := stream.Write([]byte("ping")); err != nil {
		t.Fatalf("stream write: %v", err)
	}
	response := make([]byte, len("echo:ping"))
	if _, err := io.ReadFull(stream, response); err != nil {
		t.Fatalf("stream read: %v", err)
	}
	if got := string(response); got != "echo:ping" {
		t.Fatalf("stream response = %q, want echo:ping", got)
	}
	if got := lifecycle.ActivateCount(); got != 1 {
		t.Fatalf("Activate() count = %d, want 1", got)
	}
}

func TestOwnerHostActivatesBeforeAcceptingStreams(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-barrier"))
	activateGate := make(chan struct{})
	lifecycle.activateGate = activateGate
	handlerStarted := make(chan struct{}, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error {
		handlerStarted <- struct{}{}
		return nil
	}), nil)

	if err := host.Acquire(context.Background(), "agent-owner"); err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer func() { _ = host.Release("agent-owner") }()
	session := relay.WaitSession(t)
	streamDone := make(chan error, 1)
	go func() {
		stream, err := session.mux.OpenStream()
		if err == nil {
			err = stream.Close()
		}
		streamDone <- err
	}()

	select {
	case <-handlerStarted:
		t.Fatal("stream handler started before lifecycle activation completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(activateGate)
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("stream handler did not start after lifecycle activation")
	}
	select {
	case err := <-streamDone:
		if err != nil {
			t.Fatalf("relay stream failed after activation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay stream did not finish after activation")
	}
}

func TestOwnerHostReconnectsAfterActivationFailure(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-reconnect"))
	lifecycle.activateErrors = []error{errors.New("lease activation failed")}
	handlerStarted := make(chan struct{}, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error {
		handlerStarted <- struct{}{}
		return nil
	}), func(cfg *OwnerHostConfig) {
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
				return nil
			}
		}
	})

	if err := host.Acquire(context.Background(), "agent-owner"); err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer func() { _ = host.Release("agent-owner") }()
	first := relay.WaitSession(t)
	second := relay.WaitSession(t)
	if first == second {
		t.Fatal("activation failure did not establish a new Relay session")
	}
	stream, err := second.mux.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream() after reconnect error = %v", err)
	}
	defer stream.Close()
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("reconnected session did not accept streams")
	}
	if got := lifecycle.PrepareCount(); got < 2 {
		t.Fatalf("Prepare() count = %d, want at least 2", got)
	}
	ended := lifecycle.SessionErrors()
	if len(ended) == 0 || ended[0] == nil || ended[0].Error() != "lease activation failed" {
		t.Fatalf("SessionEnded() errors = %v, want activation failure first", ended)
	}
}

func TestOwnerHostReconnectsWhenReadinessEndsAndPreservesCause(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-readiness"))
	readiness, cancelReadiness := context.WithCancelCause(context.Background())
	lifecycle.readiness = readiness
	lifecycle.readinessCancel = cancelReadiness
	handlerStarted := make(chan struct{}, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(ctx context.Context, _ net.Conn) error {
		handlerStarted <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}), nil)

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = host.Release("owner") }()
	first := relay.WaitSession(t)
	readinessCause := errors.New("lease freshness ended")
	lifecycle.CancelReadiness(readinessCause)
	if stream, openErr := first.mux.OpenStream(); openErr == nil {
		_ = stream.Close()
	}
	select {
	case <-handlerStarted:
		t.Fatal("stream handler started after readiness cancellation")
	default:
	}
	second := relay.WaitSession(t)
	if first == second {
		t.Fatal("readiness cancellation did not establish a new Relay session")
	}
	select {
	case <-handlerStarted:
		t.Fatal("stream handler started for the canceled generation")
	default:
	}
	if got := lifecycle.SessionErrors(); len(got) == 0 || !errors.Is(got[0], readinessCause) {
		t.Fatalf("SessionEnded() errors = %v, want readiness cause", got)
	}
	if got := lifecycle.DeactivateCount(); got < 1 {
		t.Fatalf("deactivate count = %d, want ended generation deactivation", got)
	}
}

func TestOwnerHostDoesNotPublishReadyForAlreadyCanceledReadiness(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-canceled-readiness"))
	readiness, cancelReadiness := context.WithCancelCause(context.Background())
	readinessCause := errors.New("lease is stale")
	cancelReadiness(readinessCause)
	lifecycle.readiness = readiness
	readyEvents := make(chan struct{}, 1)
	endedEvents := make(chan struct{}, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error {
		return nil
	}), func(cfg *OwnerHostConfig) {
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
		cfg.Observe = func(event OwnerEvent) {
			if event.Phase == OwnerPhaseServe && event.Outcome == OwnerOutcomeReady {
				readyEvents <- struct{}{}
			}
			if event.Phase == OwnerPhaseSession {
				endedEvents <- struct{}{}
			}
		}
	})

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-endedEvents:
	case <-time.After(2 * time.Second):
		t.Fatal("already-canceled readiness did not end the generation")
	}
	select {
	case <-readyEvents:
		t.Fatal("OwnerOutcomeReady was published for canceled readiness")
	default:
	}
	ended := lifecycle.SessionErrors()
	if len(ended) == 0 || !errors.Is(ended[0], readinessCause) {
		t.Fatalf("SessionEnded() errors = %v, want readiness cause", ended)
	}
	if err := host.Release("owner"); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerHostWakeInterruptsReadySessionWithoutChangingDemand(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-wake"))
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(ctx context.Context, _ net.Conn) error {
		<-ctx.Done()
		return ctx.Err()
	}), nil)

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	first := relay.WaitSession(t)
	if got := host.RefCount(); got != 1 {
		t.Fatalf("RefCount() before Wake = %d, want 1", got)
	}
	host.Wake()
	host.Wake()
	second := relay.WaitSession(t)
	if first == second {
		t.Fatal("Wake did not establish a new Relay session")
	}
	if got := host.RefCount(); got != 1 {
		t.Fatalf("RefCount() after Wake = %d, want 1", got)
	}
	if err := host.Release("owner"); err != nil {
		t.Fatal(err)
	}
	select {
	case unexpected := <-relay.sessions:
		unexpected.Close()
		t.Fatal("Wake or release established an unexpected third session")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestOwnerHostWakeSkipsBackoffForConcurrentNonContextError(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-wake-error"))
	activateGate := make(chan struct{})
	lifecycle.activateGate = activateGate
	lifecycle.ignoreActivateCancellation = true
	lifecycle.activateErrors = []error{errors.New("activation operation failed")}
	retries := make(chan struct{}, 1)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error {
		return nil
	}), func(cfg *OwnerHostConfig) {
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
		cfg.Observe = func(event OwnerEvent) {
			if event.Phase == OwnerPhaseRetry {
				retries <- struct{}{}
			}
		}
	})

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = host.Release("owner") }()
	first := relay.WaitSession(t)
	host.Wake()
	close(activateGate)
	second := relay.WaitSession(t)
	if first == second {
		t.Fatal("Wake did not advance past the concurrent activation error")
	}
	select {
	case <-retries:
		t.Fatal("Wake scheduled a retry after it had already interrupted the generation")
	default:
	}
	ended := lifecycle.SessionErrors()
	if len(ended) == 0 || ended[0] == nil || ended[0].Error() != "activation operation failed" {
		t.Fatalf("SessionEnded() errors = %v, want original activation error", ended)
	}
}

func TestOwnerHostReferenceCountsDemand(t *testing.T) {
	lifecycle := newTestOwnerLifecycle(OwnerSession{Key: "owner-ref"})
	lifecycle.prepareGate = make(chan struct{})
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), nil)

	if err := host.Acquire(context.Background(), "desktop"); err != nil {
		t.Fatal(err)
	}
	if err := host.Acquire(context.Background(), "desktop"); err != nil {
		t.Fatal(err)
	}
	if err := host.Acquire(context.Background(), "mobile-proxy"); err != nil {
		t.Fatal(err)
	}
	if got := host.RefCount(); got != 3 {
		t.Fatalf("RefCount() = %d, want 3", got)
	}
	if err := host.Release("desktop"); err != nil {
		t.Fatal(err)
	}
	if err := host.Release("mobile-proxy"); err != nil {
		t.Fatal(err)
	}
	if got := lifecycle.ReleaseCount(); got != 0 {
		t.Fatalf("Release() count before final reference = %d, want 0", got)
	}
	if err := host.Release("desktop"); err != nil {
		t.Fatal(err)
	}
	if got := host.RefCount(); got != 0 {
		t.Fatalf("RefCount() = %d, want 0", got)
	}
	if got := lifecycle.ReleaseCount(); got != 1 {
		t.Fatalf("lifecycle Release() count = %d, want 1", got)
	}
	if err := host.Release("desktop"); err == nil {
		t.Fatal("unbalanced Release() unexpectedly succeeded")
	}
}

func TestOwnerHostOldReleaseCannotDetachNewLifecycle(t *testing.T) {
	oldLifecycle := newTestOwnerLifecycle(OwnerSession{Key: "old-owner"})
	oldLifecycle.prepareGate = make(chan struct{})
	oldReleaseGate := make(chan struct{})
	oldLifecycle.releaseGate = oldReleaseGate
	newLifecycle := newTestOwnerLifecycle(OwnerSession{Key: "new-owner"})
	newLifecycle.prepareGate = make(chan struct{})
	factory := newQueuedLifecycleFactory(oldLifecycle, newLifecycle)
	host, err := NewOwnerHost(OwnerHostConfig{
		LifecycleFactory: factory,
		Handler: StreamHandlerFunc(func(context.Context, net.Conn) error {
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	oldLifecycle.WaitPrepare(t)
	oldReleaseDone := make(chan error, 1)
	go func() { oldReleaseDone <- host.Release("owner") }()
	oldLifecycle.WaitReleaseStarted(t)

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatalf("Acquire() during old release error = %v", err)
	}
	newLifecycle.WaitPrepare(t)
	close(oldReleaseGate)
	select {
	case err := <-oldReleaseDone:
		if err != nil {
			t.Fatalf("old Release() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old Release() did not finish")
	}
	if got := oldLifecycle.ReleasedKeys(); len(got) != 1 || got[0] != "old-owner" {
		t.Fatalf("old lifecycle released keys = %v, want [old-owner]", got)
	}
	if got := newLifecycle.ReleaseCount(); got != 0 {
		t.Fatalf("new lifecycle release count = %d before its demand ended", got)
	}
	if err := host.Release("owner"); err != nil {
		t.Fatalf("new Release() error = %v", err)
	}
	if got := newLifecycle.ReleasedKeys(); len(got) != 1 || got[0] != "new-owner" {
		t.Fatalf("new lifecycle released keys = %v, want [new-owner]", got)
	}
}

func TestOwnerHostReleasesPartialPrepareState(t *testing.T) {
	lifecycle := newTestOwnerLifecycle(OwnerSession{Key: "partial-owner"})
	lifecycle.prepareErrors = []error{errors.New("token request failed")}
	lifecycle.sleepAfterPrepare = make(chan struct{})
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), func(cfg *OwnerHostConfig) {
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-lifecycle.sleepAfterPrepare:
				return nil
			}
		}
	})

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	lifecycle.WaitPrepare(t)
	if err := host.Release("owner"); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
	if got := lifecycle.ReleasedKeys(); len(got) != 1 || got[0] != "partial-owner" {
		t.Fatalf("released keys = %v, want partial prepared state", got)
	}
}

func TestOwnerHostReportsRetryComponentsAndCancelsWaitOnRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "2")
		http.Error(w, "relay draining", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	endpoint := "ws" + server.URL[len("http"):]
	lifecycle := newTestOwnerLifecycle(testOwnerSession(endpoint, "owner-retry"))
	retries := make(chan OwnerEvent, 2)
	const seed = int64(11)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(context.Context, net.Conn) error { return nil }), func(cfg *OwnerHostConfig) {
		cfg.Backoff = BackoffConfig{
			Initial:     100 * time.Millisecond,
			Max:         time.Second,
			Multiplier:  2,
			RandFactory: func() *rand.Rand { return rand.New(rand.NewSource(seed)) },
		}
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
		cfg.Observe = func(event OwnerEvent) {
			if event.Phase == OwnerPhaseRetry {
				retries <- event
			}
		}
	})

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	var retry OwnerEvent
	select {
	case retry = <-retries:
	case <-time.After(2 * time.Second):
		t.Fatal("owner host did not report retry metadata")
	}
	expectedRandom := rand.New(rand.NewSource(seed))
	wantBackoff := time.Duration(expectedRandom.Int63n(int64(100*time.Millisecond) + 1))
	if retry.Retry == nil {
		t.Fatal("retry event did not include retry observation")
	}
	if retry.Retry.BackoffCap != 100*time.Millisecond || retry.Retry.BackoffDelay != wantBackoff || retry.Retry.RetryAfter != 2*time.Second {
		t.Fatalf("retry components = cap %s backoff %s retry-after %s", retry.Retry.BackoffCap, retry.Retry.BackoffDelay, retry.Retry.RetryAfter)
	}
	if retry.Retry.Delay != 2*time.Second+wantBackoff {
		t.Fatalf("retry delay = %s, want %s", retry.Retry.Delay, 2*time.Second+wantBackoff)
	}
	host.Wake()
	host.Wake()
	select {
	case <-retries:
	case <-time.After(2 * time.Second):
		t.Fatal("Wake did not interrupt the retry wait")
	}
	if err := host.Release("owner"); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
}

func TestOwnerHostSendsPingAndJoinsHandlersOnRelease(t *testing.T) {
	relay := newTestOwnerRelay(t)
	defer relay.Close()
	lifecycle := newTestOwnerLifecycle(testOwnerSession(relay.OwnerEndpoint(), "owner-live"))
	handlerStarted := make(chan struct{}, 1)
	handlerStopped := make(chan struct{}, 1)
	livenessEvents := make(chan OwnerEvent, 16)
	host := newTestOwnerHost(t, lifecycle, StreamHandlerFunc(func(ctx context.Context, _ net.Conn) error {
		handlerStarted <- struct{}{}
		<-ctx.Done()
		handlerStopped <- struct{}{}
		return ctx.Err()
	}), func(cfg *OwnerHostConfig) {
		cfg.PingInterval = 10 * time.Millisecond
		cfg.PongTimeout = 100 * time.Millisecond
		cfg.Observe = func(event OwnerEvent) {
			if event.Phase == OwnerPhaseLiveness {
				livenessEvents <- event
			}
		}
	})

	if err := host.Acquire(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	session := relay.WaitSession(t)
	stream, err := session.mux.OpenStream()
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	defer stream.Close()
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}
	if got := relay.WaitPing(t); got != "owner-live" {
		t.Fatalf("ping payload = %q, want owner-live", got)
	}
	seenPing, seenPong := false, false
	for !seenPing || !seenPong {
		select {
		case event := <-livenessEvents:
			seenPing = seenPing || event.Outcome == OwnerOutcomePingSent
			seenPong = seenPong || event.Outcome == OwnerOutcomePongReceived
		case <-time.After(2 * time.Second):
			t.Fatalf("liveness events = ping:%t pong:%t, want both", seenPing, seenPong)
		}
	}
	if err := host.Release("owner"); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
	select {
	case <-handlerStopped:
	default:
		t.Fatal("Release() returned before the stream handler stopped")
	}
	if got := lifecycle.DeactivateCount(); got != 1 {
		t.Fatalf("deactivate count = %d, want 1", got)
	}
	if got := lifecycle.ReleaseCount(); got != 1 {
		t.Fatalf("lifecycle release count = %d, want 1", got)
	}
	for {
		select {
		case event := <-livenessEvents:
			if event.Outcome != OwnerOutcomeStopped {
				continue
			}
			if event.Liveness == nil || event.Liveness.PingCount < 1 || event.Liveness.PongCount < 1 || event.Liveness.LastPongAt.IsZero() {
				t.Fatalf("stopped liveness event = %#v, want ping/pong totals", event)
			}
			return
		default:
			t.Fatal("Release() returned without a stopped liveness event")
		}
	}
}

func testOwnerSession(endpoint, key string) OwnerSession {
	return OwnerSession{
		Key: key,
		Dial: DialRequest{
			Endpoint:    endpoint,
			Query:       url.Values{"owner_id": []string{key}},
			Header:      http.Header{"Authorization": []string{"Bearer owner-token"}},
			Subprotocol: testSubprotocol,
		},
		PingPayload: []byte(key),
	}
}

func newTestOwnerHost(t *testing.T, lifecycle OwnerLifecycle, handler StreamHandler, configure func(*OwnerHostConfig)) *OwnerHost {
	t.Helper()
	cfg := OwnerHostConfig{
		LifecycleFactory: OwnerLifecycleFactoryFunc(func() OwnerLifecycle { return lifecycle }),
		Handler:          handler,
		Backoff: BackoffConfig{
			Initial:     time.Millisecond,
			Max:         5 * time.Millisecond,
			Multiplier:  2,
			RandFactory: func() *rand.Rand { return rand.New(rand.NewSource(1)) },
		},
		PingInterval: time.Hour,
		PongTimeout:  2 * time.Hour,
	}
	if configure != nil {
		configure(&cfg)
	}
	host, err := NewOwnerHost(cfg)
	if err != nil {
		t.Fatalf("NewOwnerHost() error = %v", err)
	}
	return host
}

type testOwnerLifecycle struct {
	session OwnerSession

	mu                         sync.Mutex
	prepareCalls               int
	activateCalls              int
	deactivateCalls            int
	releaseCalls               int
	prepareErrors              []error
	activateErrors             []error
	ignoreActivateCancellation bool
	sessionErrors              []error
	releasedKeys               []string
	readiness                  context.Context
	readinessCancel            context.CancelCauseFunc
	prepareGate                <-chan struct{}
	activateGate               <-chan struct{}
	releaseGate                <-chan struct{}
	sleepAfterPrepare          chan struct{}
	prepareSeen                chan struct{}
	releaseStarted             chan struct{}
	prepareOnce                sync.Once
	releaseOnce                sync.Once
}

func newTestOwnerLifecycle(session OwnerSession) *testOwnerLifecycle {
	return &testOwnerLifecycle{
		session:        session,
		prepareSeen:    make(chan struct{}),
		releaseStarted: make(chan struct{}),
	}
}

func (l *testOwnerLifecycle) Prepare(ctx context.Context) (OwnerSession, error) {
	l.mu.Lock()
	l.prepareCalls++
	var err error
	if len(l.prepareErrors) > 0 {
		err = l.prepareErrors[0]
		l.prepareErrors = l.prepareErrors[1:]
	}
	l.mu.Unlock()
	l.prepareOnce.Do(func() { close(l.prepareSeen) })
	if l.prepareGate != nil {
		select {
		case <-ctx.Done():
			return l.session, ctx.Err()
		case <-l.prepareGate:
		}
	}
	return l.session, err
}

func (l *testOwnerLifecycle) Activate(ctx context.Context, _ OwnerSession) (OwnerActivation, error) {
	l.mu.Lock()
	l.activateCalls++
	var err error
	if len(l.activateErrors) > 0 {
		err = l.activateErrors[0]
		l.activateErrors = l.activateErrors[1:]
	}
	l.mu.Unlock()
	if l.activateGate != nil {
		if l.ignoreActivateCancellation {
			<-l.activateGate
		} else {
			select {
			case <-ctx.Done():
				return OwnerActivation{}, ctx.Err()
			case <-l.activateGate:
			}
		}
	}
	if err != nil {
		return OwnerActivation{}, err
	}
	readiness := l.readiness
	if readiness != nil {
		l.readiness = nil
	}
	if readiness == nil {
		readiness = ctx
	}
	return OwnerActivation{
		Readiness: readiness,
		Deactivate: func() {
			l.mu.Lock()
			l.deactivateCalls++
			l.mu.Unlock()
		}}, nil
}

func (l *testOwnerLifecycle) SessionEnded(_ OwnerSession, err error) {
	l.mu.Lock()
	l.sessionErrors = append(l.sessionErrors, err)
	l.mu.Unlock()
}

func (l *testOwnerLifecycle) CancelReadiness(err error) {
	l.mu.Lock()
	cancel := l.readinessCancel
	l.mu.Unlock()
	if cancel != nil {
		cancel(err)
	}
}

func (l *testOwnerLifecycle) Release(ctx context.Context, session OwnerSession) error {
	l.releaseOnce.Do(func() { close(l.releaseStarted) })
	if l.releaseGate != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-l.releaseGate:
		}
	}
	l.mu.Lock()
	l.releaseCalls++
	l.releasedKeys = append(l.releasedKeys, session.Key)
	l.mu.Unlock()
	return nil
}

func (l *testOwnerLifecycle) WaitPrepare(t *testing.T) {
	t.Helper()
	select {
	case <-l.prepareSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("lifecycle Prepare() was not called")
	}
}

func (l *testOwnerLifecycle) WaitReleaseStarted(t *testing.T) {
	t.Helper()
	select {
	case <-l.releaseStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("lifecycle Release() was not called")
	}
}

func (l *testOwnerLifecycle) PrepareCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.prepareCalls
}

func (l *testOwnerLifecycle) ActivateCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.activateCalls
}

func (l *testOwnerLifecycle) DeactivateCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.deactivateCalls
}

func (l *testOwnerLifecycle) ReleaseCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.releaseCalls
}

func (l *testOwnerLifecycle) SessionErrors() []error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]error(nil), l.sessionErrors...)
}

func (l *testOwnerLifecycle) ReleasedKeys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.releasedKeys...)
}

type queuedLifecycleFactory struct {
	mu         sync.Mutex
	lifecycles []OwnerLifecycle
}

func newQueuedLifecycleFactory(lifecycles ...OwnerLifecycle) *queuedLifecycleFactory {
	return &queuedLifecycleFactory{lifecycles: lifecycles}
}

func (f *queuedLifecycleFactory) NewOwnerLifecycle() OwnerLifecycle {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.lifecycles) == 0 {
		return nil
	}
	lifecycle := f.lifecycles[0]
	f.lifecycles = f.lifecycles[1:]
	return lifecycle
}

type testOwnerRelay struct {
	server   *httptest.Server
	upgrader websocket.Upgrader
	sessions chan *testOwnerRelaySession
	pings    chan string
}

type testOwnerRelaySession struct {
	mux           *yamux.Session
	ws            *websocket.Conn
	ownerID       string
	authorization string
}

func (s *testOwnerRelaySession) Close() {
	_ = s.ws.Close()
	_ = s.mux.Close()
}

func newTestOwnerRelay(t *testing.T) *testOwnerRelay {
	t.Helper()
	relay := &testOwnerRelay{
		upgrader: websocket.Upgrader{
			CheckOrigin:  func(*http.Request) bool { return true },
			Subprotocols: []string{testSubprotocol},
		},
		sessions: make(chan *testOwnerRelaySession, 16),
		pings:    make(chan string, 16),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/owner", relay.handleOwner)
	relay.server = httptest.NewServer(mux)
	return relay
}

func (r *testOwnerRelay) OwnerEndpoint() string {
	endpoint, err := url.Parse(r.server.URL)
	if err != nil {
		panic(err)
	}
	endpoint.Scheme = "ws"
	endpoint.Path = "/owner"
	return endpoint.String()
}

func (r *testOwnerRelay) Close() { r.server.Close() }

func (r *testOwnerRelay) WaitSession(t *testing.T) *testOwnerRelaySession {
	t.Helper()
	select {
	case session := <-r.sessions:
		return session
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Relay owner session")
		return nil
	}
}

func (r *testOwnerRelay) WaitPing(t *testing.T) string {
	t.Helper()
	select {
	case payload := <-r.pings:
		return payload
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Relay ping")
		return ""
	}
}

func (r *testOwnerRelay) handleOwner(w http.ResponseWriter, request *http.Request) {
	if request.URL.Query().Get("owner_id") == "" {
		http.Error(w, "owner_id is required", http.StatusBadRequest)
		return
	}
	ws, err := r.upgrader.Upgrade(w, request, nil)
	if err != nil {
		return
	}
	ws.SetPingHandler(func(payload string) error {
		select {
		case r.pings <- payload:
		default:
		}
		return ws.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(time.Second))
	})
	conn := newWebSocketByteConn(ws)
	muxConfig := yamux.DefaultConfig()
	muxConfig.EnableKeepAlive = false
	muxConfig.LogOutput = io.Discard
	mux, err := yamux.Client(conn, muxConfig)
	if err != nil {
		_ = ws.Close()
		return
	}
	r.sessions <- &testOwnerRelaySession{
		mux:           mux,
		ws:            ws,
		ownerID:       request.URL.Query().Get("owner_id"),
		authorization: request.Header.Get("Authorization"),
	}
	<-mux.CloseChan()
	_ = ws.Close()
}

func (s *testOwnerRelaySession) String() string {
	return fmt.Sprintf("owner relay session %q", s.ownerID)
}
