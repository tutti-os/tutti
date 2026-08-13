package relaytransport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
)

// OwnerHost maintains one Relay owner tunnel while at least one product driver
// holds a reference. It is safe for concurrent use.
type OwnerHost struct {
	cfg OwnerHostConfig

	mu                sync.Mutex
	refs              map[string]int
	refCount          int
	networkGeneration uint64
	run               *ownerRun
}

type ownerRun struct {
	cancel    context.CancelFunc
	done      chan struct{}
	lifecycle OwnerLifecycle
	handlers  sync.WaitGroup

	mu         sync.Mutex
	session    OwnerSession
	generation uint64
	wakeCh     chan struct{}
	wake       bool
}

// NewOwnerHost validates config and creates an idle owner host.
func NewOwnerHost(cfg OwnerHostConfig) (*OwnerHost, error) {
	if cfg.LifecycleFactory == nil {
		return nil, errors.New("relay owner lifecycle factory is required")
	}
	if cfg.Handler == nil {
		return nil, errors.New("relay owner stream handler is required")
	}
	if cfg.StableSessionFor <= 0 {
		cfg.StableSessionFor = 30 * time.Second
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = 20 * time.Second
	}
	if cfg.PongTimeout <= cfg.PingInterval {
		cfg.PongTimeout = cfg.PingInterval * 3
	}
	if cfg.Sleep == nil {
		cfg.Sleep = sleepContext
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &OwnerHost{cfg: cfg, refs: make(map[string]int), networkGeneration: 1}, nil
}

// Acquire starts the owner tunnel on the first reference. driver is a
// product-owned demand key and may be acquired more than once.
func (h *OwnerHost) Acquire(ctx context.Context, driver string) error {
	if h == nil {
		return errors.New("relay owner host is nil")
	}
	driver = strings.TrimSpace(driver)
	if driver == "" {
		return errors.New("relay owner acquire requires driver")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.refs[driver]++
	h.refCount++
	if h.refCount != 1 {
		return nil
	}
	lifecycle := h.cfg.LifecycleFactory.NewOwnerLifecycle()
	if lifecycle == nil {
		h.refs[driver]--
		if h.refs[driver] == 0 {
			delete(h.refs, driver)
		}
		h.refCount--
		return errors.New("relay owner lifecycle factory returned nil")
	}
	runCtx, cancel := context.WithCancel(context.Background())
	run := &ownerRun{
		cancel:     cancel,
		done:       make(chan struct{}),
		lifecycle:  lifecycle,
		generation: h.networkGeneration,
		wakeCh:     make(chan struct{}),
	}
	h.run = run
	go h.runLoop(runCtx, run)
	return nil
}

// Release drops one driver reference. The final release synchronously stops
// the tunnel, joins stream handlers, and releases the exact product lifecycle.
func (h *OwnerHost) Release(driver string) error {
	if h == nil {
		return errors.New("relay owner host is nil")
	}
	driver = strings.TrimSpace(driver)
	if driver == "" {
		return errors.New("relay owner release requires driver")
	}

	var run *ownerRun
	h.mu.Lock()
	count := h.refs[driver]
	if count == 0 {
		h.mu.Unlock()
		return fmt.Errorf("relay owner release without acquire for driver %q", driver)
	}
	if count == 1 {
		delete(h.refs, driver)
	} else {
		h.refs[driver] = count - 1
	}
	h.refCount--
	if h.refCount == 0 {
		run = h.run
		h.run = nil
	}
	h.mu.Unlock()

	if run == nil {
		return nil
	}
	run.cancel()
	<-run.done
	run.handlers.Wait()
	session := run.currentSession()
	err := run.lifecycle.Release(context.Background(), session)
	h.observe(OwnerEvent{
		Phase: OwnerPhaseRelease, Outcome: outcome(err), Generation: h.currentNetworkGeneration(),
		SessionKey: session.Key, Error: err,
	})
	return err
}

// AdvanceNetworkGeneration fences the current owner attempt when generation
// is newer than the host's last accepted generation. It does not alter
// demand references, create a lifecycle, or clear product credentials. A
// newer generation cancels Prepare, Dial, Activate, Serve, active handlers,
// and any retry wait; the existing lifecycle is reused for the immediate
// retry. Equal or older generations are ignored.
func (h *OwnerHost) AdvanceNetworkGeneration(generation uint64) {
	if h == nil || generation == 0 {
		return
	}
	h.mu.Lock()
	if generation <= h.networkGeneration {
		h.mu.Unlock()
		return
	}
	h.networkGeneration = generation
	run := h.run
	h.mu.Unlock()
	if run != nil {
		run.advanceGeneration(generation)
	}
}

// RefCount returns the number of current product references.
func (h *OwnerHost) RefCount() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.refCount
}

// Wake interrupts the current owner generation or retry wait when demand is
// present. It does not change references, release product state, or reset
// reconnect backoff. Repeated wakes before the current wait observes one are
// coalesced.
func (h *OwnerHost) Wake() {
	if h == nil {
		return
	}
	h.mu.Lock()
	run := h.run
	active := h.refCount > 0
	h.mu.Unlock()
	if !active || run == nil {
		return
	}
	run.signalWake()
}

func (h *OwnerHost) runLoop(ctx context.Context, run *ownerRun) {
	defer close(run.done)
	backoff := newExponentialBackoff(h.cfg.Backoff)
	for ctx.Err() == nil {
		generation, wakeCh := run.attemptState()
		attemptCtx, attemptCancel := context.WithCancelCause(ctx)
		attemptStop := make(chan struct{})
		attemptDone := make(chan struct{})
		go func() {
			defer close(attemptDone)
			select {
			case <-wakeCh:
				attemptCancel(ErrOwnerWake)
			case <-ctx.Done():
				attemptCancel(context.Cause(ctx))
			case <-attemptStop:
			}
		}()
		session, err := run.lifecycle.Prepare(attemptCtx)
		if strings.TrimSpace(session.Key) != "" {
			run.setSession(session)
		}
		h.observe(OwnerEvent{
			Phase: OwnerPhasePrepare, Outcome: outcome(err), Generation: generation,
			SessionKey: session.Key, Error: err,
		})
		var readyFor time.Duration
		if err == nil {
			readyFor, err = h.runSession(attemptCtx, run, session, generation)
		}
		attemptCause := context.Cause(attemptCtx)
		wakeObserved := errors.Is(attemptCause, ErrOwnerWake)
		close(attemptStop)
		attemptCancel(nil)
		<-attemptDone
		// The monitor can lose the select race with attemptStop after Wake has
		// closed wakeCh. Observe the pending signal after joining it so a wake
		// cannot accidentally schedule a retry before its cancellation cause is
		// recorded in attemptCtx.
		if !wakeObserved {
			wakeObserved = run.wakePending(wakeCh)
		}
		if wakeObserved {
			run.acknowledgeWake(wakeCh)
			if err == nil || errors.Is(err, context.Canceled) {
				err = ErrOwnerWake
			}
		}
		if ctx.Err() != nil {
			return
		}
		if current, changed := run.generationChangedSince(generation); changed {
			err = &NetworkGenerationChangedError{
				PreviousGeneration: generation,
				Generation:         current,
			}
			run.lifecycle.SessionEnded(session, err)
			h.observe(OwnerEvent{
				Phase: OwnerPhaseSession, Outcome: OwnerOutcomeEnded, Generation: current,
				EndReason: OwnerEndReasonNetworkChanged, SessionKey: session.Key, Error: err,
			})
			backoff.Reset()
			continue
		}
		if readyFor >= h.cfg.StableSessionFor && !wakeObserved {
			backoff.Reset()
		}
		run.lifecycle.SessionEnded(session, err)
		h.observe(OwnerEvent{
			Phase: OwnerPhaseSession, Outcome: OwnerOutcomeEnded, Generation: generation,
			SessionKey: session.Key, Error: err,
		})
		if wakeObserved {
			continue
		}
		backoffDelay := backoff.Next()
		retryAfter := retryDelay(err, h.cfg.Now())
		delay := combineRetryDelay(backoffDelay, retryAfter)
		h.observe(OwnerEvent{
			Phase: OwnerPhaseRetry, Outcome: OwnerOutcomeScheduled, Generation: generation,
			SessionKey: session.Key,
			Retry: &OwnerRetryObservation{
				Delay: delay, BackoffCap: backoff.Cap(), BackoffDelay: backoffDelay, RetryAfter: retryAfter,
			},
			Error: err,
		})
		sleepErr := h.sleepRetry(ctx, run, delay)
		if ctx.Err() != nil {
			return
		}
		if current, changed := run.generationChangedSince(generation); changed {
			h.observeNetworkRetry(session, generation, current)
			backoff.Reset()
			continue
		}
		if errors.Is(sleepErr, ErrOwnerWake) {
			continue
		}
		if sleepErr != nil {
			return
		}
	}
}

func (h *OwnerHost) runSession(ctx context.Context, run *ownerRun, session OwnerSession, generation uint64) (time.Duration, error) {
	ws, err := dialWebSocket(ctx, session.Dial)
	if err != nil {
		return 0, err
	}
	conn := newWebSocketByteConn(ws)
	defer func() { _ = conn.Close() }()
	stopLiveness, err := startLiveness(ctx, ws, livenessConfig{
		pingInterval: h.cfg.PingInterval,
		pongTimeout:  h.cfg.PongTimeout,
		pingPayload:  session.PingPayload,
		sessionKey:   session.Key,
		generation:   generation,
		observe:      h.observe,
	})
	if err != nil {
		return 0, err
	}
	defer stopLiveness()
	h.observe(OwnerEvent{
		Phase: OwnerPhaseDial, Outcome: OwnerOutcomeConnected, Generation: generation,
		SessionKey: session.Key,
	})

	activation, err := run.lifecycle.Activate(ctx, session)
	if err != nil {
		return 0, err
	}
	if activation.Readiness == nil {
		if activation.Deactivate != nil {
			activation.Deactivate()
		}
		return 0, ErrOwnerActivationReadiness
	}
	deactivate := activation.Deactivate
	if deactivate == nil {
		deactivate = func() {}
	}
	if cause := ownerReadinessCause(activation.Readiness); cause != nil {
		deactivate()
		return 0, cause
	}

	yamuxConfig := yamux.DefaultConfig()
	yamuxConfig.EnableKeepAlive = false
	// The Host reports transport failures through OwnerEvent. Do not let the
	// underlying mux bypass product log redaction by writing to stderr.
	yamuxConfig.LogOutput = io.Discard
	mux, err := yamux.Server(conn, yamuxConfig)
	if err != nil {
		deactivate()
		return 0, fmt.Errorf("start relay owner mux: %w", err)
	}
	sessionCtx, sessionCancel := context.WithCancelCause(ctx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		select {
		case <-activation.Readiness.Done():
			cause := ownerReadinessCause(activation.Readiness)
			if cause == nil {
				cause = context.Canceled
			}
			sessionCancel(cause)
			_ = mux.Close()
			_ = conn.Close()
		case <-sessionCtx.Done():
			_ = mux.Close()
			_ = conn.Close()
		}
	}()
	defer func() {
		sessionCancel(nil)
		_ = mux.Close()
		_ = conn.Close()
		<-monitorDone
		stopLiveness()
		run.handlers.Wait()
		deactivate()
	}()
	if cause := ownerSessionCause(sessionCtx, activation.Readiness); cause != nil {
		return 0, cause
	}
	readyAt := h.cfg.Now()
	h.observe(OwnerEvent{
		Phase: OwnerPhaseServe, Outcome: OwnerOutcomeReady, Generation: generation,
		SessionKey: session.Key,
	})
	if cause := ownerSessionCause(sessionCtx, activation.Readiness); cause != nil {
		return elapsed(readyAt, h.cfg.Now()), cause
	}

	for {
		stream, acceptErr := mux.AcceptStream()
		if acceptErr != nil {
			readyFor := elapsed(readyAt, h.cfg.Now())
			if cause := context.Cause(sessionCtx); cause != nil {
				return readyFor, cause
			}
			if ctx.Err() != nil {
				return readyFor, context.Cause(ctx)
			}
			return readyFor, fmt.Errorf("accept relay owner stream: %w", acceptErr)
		}
		if cause := ownerSessionCause(sessionCtx, activation.Readiness); cause != nil {
			_ = stream.Close()
			readyFor := elapsed(readyAt, h.cfg.Now())
			return readyFor, cause
		}
		run.handlers.Add(1)
		go h.handleStream(sessionCtx, activation.Readiness, run, session.Key, generation, stream)
	}
}

func (h *OwnerHost) sleepRetry(ctx context.Context, run *ownerRun, delay time.Duration) error {
	sleepCtx, cancel := context.WithCancelCause(ctx)
	wakeCh := run.wakeChannel()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-wakeCh:
			run.acknowledgeWake(wakeCh)
			cancel(ErrOwnerWake)
		case <-ctx.Done():
			cancel(context.Cause(ctx))
		case <-stop:
		}
	}()
	err := h.cfg.Sleep(sleepCtx, delay)
	close(stop)
	cancel(nil)
	<-done
	if cause := context.Cause(sleepCtx); errors.Is(cause, ErrOwnerWake) {
		return cause
	}
	return err
}

func (h *OwnerHost) handleStream(
	ctx, readiness context.Context,
	run *ownerRun,
	sessionKey string,
	generation uint64,
	stream net.Conn,
) {
	defer run.handlers.Done()
	defer func() { _ = stream.Close() }()
	if cause := ownerSessionCause(ctx, readiness); cause != nil {
		h.observe(OwnerEvent{Phase: OwnerPhaseStream, Outcome: OwnerOutcomeFailed, SessionKey: sessionKey, Error: cause})
		return
	}
	err := h.cfg.Handler.HandleRelayStream(ctx, stream)
	h.observe(OwnerEvent{
		Phase: OwnerPhaseStream, Outcome: outcome(err), Generation: generation,
		SessionKey: sessionKey, Error: err,
	})
}

func (h *OwnerHost) observe(event OwnerEvent) {
	if h.cfg.Observe != nil {
		h.cfg.Observe(event)
	}
}

func (r *ownerRun) setSession(session OwnerSession) {
	r.mu.Lock()
	r.session = session
	r.mu.Unlock()
}

func (r *ownerRun) attemptState() (uint64, <-chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.generation, r.wakeCh
}

func (r *ownerRun) advanceGeneration(generation uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if generation <= r.generation {
		return
	}
	r.generation = generation
	if !r.wake {
		close(r.wakeCh)
		r.wake = true
	}
}

func (r *ownerRun) generationChangedSince(generation uint64) (uint64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.generation, r.generation > generation
}

func (h *OwnerHost) currentNetworkGeneration() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.networkGeneration
}

func (h *OwnerHost) observeNetworkRetry(session OwnerSession, previous, generation uint64) {
	err := &NetworkGenerationChangedError{
		PreviousGeneration: previous,
		Generation:         generation,
	}
	h.observe(OwnerEvent{
		Phase: OwnerPhaseRetry, Outcome: OwnerOutcomeScheduled, Generation: generation,
		EndReason: OwnerEndReasonNetworkChanged, SessionKey: session.Key,
		Retry: &OwnerRetryObservation{Delay: 0}, Error: err,
	})
}

func (r *ownerRun) currentSession() OwnerSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.session
}

func (r *ownerRun) signalWake() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.wake {
		return
	}
	close(r.wakeCh)
	r.wake = true
}

func (r *ownerRun) wakeChannel() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.wakeCh
}

func (r *ownerRun) wakePending(ch <-chan struct{}) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.wakeCh == ch && r.wake
}

func (r *ownerRun) acknowledgeWake(ch <-chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.wakeCh != ch || !r.wake {
		return
	}
	r.wakeCh = make(chan struct{})
	r.wake = false
}

func ownerReadinessCause(readiness context.Context) error {
	if readiness == nil {
		return ErrOwnerActivationReadiness
	}
	select {
	case <-readiness.Done():
		cause := context.Cause(readiness)
		if cause == nil {
			cause = context.Canceled
		}
		if errors.Is(cause, ErrOwnerWake) || errors.Is(cause, context.Canceled) {
			return cause
		}
		return &OwnerReadinessError{Cause: cause}
	default:
		return nil
	}
}

func ownerSessionCause(session, readiness context.Context) error {
	if cause := context.Cause(session); cause != nil {
		return cause
	}
	return ownerReadinessCause(readiness)
}

func outcome(err error) OwnerOutcome {
	if err != nil {
		return OwnerOutcomeFailed
	}
	return OwnerOutcomeSucceeded
}

func elapsed(start, end time.Time) time.Duration {
	if start.IsZero() || !end.After(start) {
		return 0
	}
	return end.Sub(start)
}
