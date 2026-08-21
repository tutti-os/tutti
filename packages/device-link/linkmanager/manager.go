package linkmanager

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	defaultIdleGrace       = 60 * time.Second
	defaultCollisionWindow = 5 * time.Second
)

var (
	ErrLinkUnavailable      = errors.New("device-link peer link is unavailable")
	ErrManagerClosed        = errors.New("device-link manager is closed")
	ErrManagerDisabled      = errors.New("device-link manager is disabled")
	ErrAdmissionInvalidated = errors.New("device-link admission was invalidated")
)

type Link interface {
	OpenStream(context.Context) (net.Conn, error)
	AcceptStream(context.Context) (net.Conn, error)
	Close() error
}

type IncomingStream[K comparable, M any] struct {
	Key          K
	ConnectionID string
	Metadata     M
	Stream       net.Conn
}

type IncomingHandler[K comparable, M any] func(context.Context, IncomingStream[K, M]) error

type LinkState string

const (
	LinkReady        LinkState = "ready"
	LinkDisconnected LinkState = "disconnected"
)

type LinkEvent[K comparable, M any] struct {
	Key          K
	ConnectionID string
	// Sequence increases for one ConnectionID. Observe callbacks may run
	// concurrently, so projections must discard a sequence older than the last
	// one they applied. Disconnected is terminal for that ConnectionID.
	Sequence      uint64
	Metadata      M
	State         LinkState
	ActiveStreams int
	ChangedAt     time.Time
}

type ManagerConfig[K comparable, M any] struct {
	IdleGrace       time.Duration
	CollisionWindow time.Duration
	Now             func() time.Time
	// Observe must return promptly. Calls for different state transitions may
	// overlap; LinkEvent.Sequence provides deterministic projection ordering.
	Observe func(LinkEvent[K, M])
}

type Registration[K comparable, M any] struct {
	Key K
	// ConnectionID must be the same globally comparable attempt identifier at
	// both peers. Locally generated IDs can make collision decisions diverge.
	ConnectionID   string
	Link           Link
	Metadata       M
	HandleIncoming IncomingHandler[K, M]
}

type RegisterDisposition string

const (
	RegisterInstalled    RegisterDisposition = "installed"
	RegisterReplaced     RegisterDisposition = "replaced"
	RegisterKeptExisting RegisterDisposition = "kept_existing"
)

// Retirement owns one exact link that has already been removed from Manager
// authority. Close never looks the link up by key, so a delayed physical close
// cannot affect a replacement registered for the same key.
type Retirement struct {
	once     sync.Once
	close    func() error
	closeErr error
}

func (r *Retirement) Close() error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		if r.close != nil {
			r.closeErr = r.close()
		}
	})
	return r.closeErr
}

type Manager[K comparable, M any] struct {
	cfg ManagerConfig[K, M]

	mu               sync.Mutex
	links            map[K]*managedLink[K, M]
	flights          map[K]*establishFlight
	keyGenerations   map[K]uint64
	admissions       map[*Admission[K, M]]struct{}
	globalGeneration uint64
	enabled          bool
	closing          bool
	ctx              context.Context
	cancel           context.CancelFunc
	wg               sync.WaitGroup
	waitOnce         sync.Once
	quiesced         chan struct{}
}

type Admission[K comparable, M any] struct {
	manager          *Manager[K, M]
	key              K
	globalGeneration uint64
	keyGeneration    uint64
	ctx              context.Context
	cancel           context.CancelCauseFunc
	used             bool
	once             sync.Once
}

type managedLink[K comparable, M any] struct {
	manager        *Manager[K, M]
	key            K
	connectionID   string
	metadata       M
	establishedAt  time.Time
	link           Link
	handleIncoming IncomingHandler[K, M]
	handlerCtx     context.Context
	cancelHandlers context.CancelFunc
	activeStreams  int
	idleTimer      *time.Timer
	idleGeneration uint64
	eventSequence  uint64
	disconnected   bool
	closed         bool
	revokeOnce     sync.Once
	closeOnce      sync.Once
	closeErr       error
}

type EstablishFunc[K comparable, M any] func(context.Context, *Admission[K, M]) (Registration[K, M], error)

func NewManager[K comparable, M any](cfg ManagerConfig[K, M]) *Manager[K, M] {
	if cfg.IdleGrace <= 0 {
		cfg.IdleGrace = defaultIdleGrace
	}
	if cfg.CollisionWindow <= 0 {
		cfg.CollisionWindow = defaultCollisionWindow
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager[K, M]{
		cfg:            cfg,
		links:          make(map[K]*managedLink[K, M]),
		flights:        make(map[K]*establishFlight),
		keyGenerations: make(map[K]uint64),
		admissions:     make(map[*Admission[K, M]]struct{}),
		enabled:        true,
		ctx:            ctx,
		cancel:         cancel,
		quiesced:       make(chan struct{}),
	}
}

// Admit binds an in-flight authenticated connection attempt to the current
// global and peer generations. Register rejects and closes a link produced by
// an admission invalidated before the handshake completes. The caller must
// Close every successful admission, normally with defer.
func (m *Manager[K, M]) Admit(ctx context.Context, key K) (*Admission[K, M], error) {
	if m == nil {
		return nil, ErrManagerClosed
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return nil, ErrManagerClosed
	}
	if !m.enabled {
		return nil, ErrManagerDisabled
	}
	admissionCtx, cancel := context.WithCancelCause(ctx)
	admission := &Admission[K, M]{
		manager:          m,
		key:              key,
		globalGeneration: m.globalGeneration,
		keyGeneration:    m.keyGenerations[key],
		ctx:              admissionCtx,
		cancel:           cancel,
	}
	m.admissions[admission] = struct{}{}
	m.wg.Add(1)
	return admission, nil
}

func (a *Admission[K, M]) Context() context.Context {
	if a == nil || a.ctx == nil {
		return context.Background()
	}
	return a.ctx
}

func (a *Admission[K, M]) Close() {
	if a == nil {
		return
	}
	a.once.Do(func() {
		a.cancel(context.Canceled)
		if a.manager != nil {
			a.manager.releaseAdmission(a)
		}
	})
}

// Register transfers ownership of registration.Link to the manager regardless
// of disposition. Callers must not close the Link after calling Register.
func (m *Manager[K, M]) Register(
	admission *Admission[K, M],
	registration Registration[K, M],
) (RegisterDisposition, error) {
	if registration.Link == nil {
		return "", errors.New("device-link registration requires an authenticated link")
	}
	registration.ConnectionID = strings.TrimSpace(registration.ConnectionID)
	if registration.ConnectionID == "" {
		_ = registration.Link.Close()
		return "", errors.New("device-link registration requires a connection id")
	}
	if admission == nil || admission.manager != m || registration.Key != admission.key {
		_ = registration.Link.Close()
		return "", ErrAdmissionInvalidated
	}
	if m == nil {
		_ = registration.Link.Close()
		return "", ErrManagerClosed
	}
	establishedAt := m.cfg.Now()

	handlerCtx, cancelHandlers := context.WithCancel(m.ctx)
	incoming := &managedLink[K, M]{
		manager:        m,
		key:            registration.Key,
		connectionID:   registration.ConnectionID,
		metadata:       registration.Metadata,
		establishedAt:  establishedAt,
		link:           registration.Link,
		handleIncoming: registration.HandleIncoming,
		handlerCtx:     handlerCtx,
		cancelHandlers: cancelHandlers,
	}

	var replaced *managedLink[K, M]
	disposition := RegisterInstalled
	m.mu.Lock()
	_, admissionActive := m.admissions[admission]
	if m.closing ||
		!m.enabled ||
		!admissionActive ||
		admission.used ||
		admission.ctx.Err() != nil ||
		admission.globalGeneration != m.globalGeneration ||
		admission.keyGeneration != m.keyGenerations[admission.key] {
		m.mu.Unlock()
		_ = incoming.closeTransport()
		return "", ErrAdmissionInvalidated
	}
	admission.used = true
	existing := m.links[registration.Key]
	if existing != nil && !existing.closed {
		age := m.cfg.Now().Sub(existing.establishedAt)
		withinCollisionWindow := age >= 0 && age <= m.cfg.CollisionWindow
		if !withinCollisionWindow || existing.connectionID <= incoming.connectionID {
			m.mu.Unlock()
			_ = incoming.closeTransport()
			return RegisterKeptExisting, nil
		}
		replaced = existing
		replaced.closed = true
		replaced.stopIdleLocked()
		disposition = RegisterReplaced
	}
	m.links[registration.Key] = incoming
	incoming.scheduleIdleLocked()
	m.wg.Add(1)
	m.mu.Unlock()

	if replaced != nil {
		m.notify(replaced, LinkDisconnected)
		_ = replaced.closeTransport()
	}
	m.notify(incoming, LinkReady)
	go m.acceptStreams(incoming)
	return disposition, nil
}

func (m *Manager[K, M]) Ready(key K) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	link := m.links[key]
	return !m.closing && m.enabled && link != nil && !link.closed
}

func (m *Manager[K, M]) OpenStream(ctx context.Context, key K) (net.Conn, error) {
	if m == nil {
		return nil, ErrLinkUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.Lock()
	link := m.links[key]
	if m.closing || !m.enabled || link == nil || link.closed {
		m.mu.Unlock()
		return nil, ErrLinkUnavailable
	}
	link.acquireStreamLocked()
	m.mu.Unlock()

	stream, err := link.link.OpenStream(ctx)
	if err != nil {
		link.releaseStream()
		if ctx.Err() == nil {
			m.remove(link)
		}
		return nil, err
	}
	m.mu.Lock()
	current := !m.closing && m.enabled && !link.closed && m.links[key] == link
	m.mu.Unlock()
	if !current {
		_ = stream.Close()
		link.releaseStream()
		return nil, ErrLinkUnavailable
	}
	m.notify(link, LinkReady)
	return &managedStream{Conn: stream, release: link.releaseStream}, nil
}

// OpenOrConnect reuses a pooled link or serializes establishment for one key.
// Followers may cancel independently; after a failed leader, a follower may
// become the next leader and retry instead of inheriting the first error.
func (m *Manager[K, M]) OpenOrConnect(
	ctx context.Context,
	key K,
	establish EstablishFunc[K, M],
) (net.Conn, error) {
	if m == nil {
		return nil, ErrManagerClosed
	}
	if establish == nil {
		return nil, errors.New("device-link establish function is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		if stream, err := m.OpenStream(ctx, key); err == nil {
			return stream, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		flight, leader, err := m.joinFlight(key)
		if err != nil {
			return nil, err
		}
		if leader {
			establishErr := func() error {
				defer m.finishFlight(key, flight)
				admission, err := m.Admit(ctx, key)
				if err != nil {
					return err
				}
				defer admission.Close()
				registration, err := establish(admission.Context(), admission)
				if err != nil {
					return err
				}
				_, err = m.Register(admission, registration)
				return err
			}()
			if establishErr != nil {
				return nil, establishErr
			}
			return m.OpenStream(ctx, key)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
		}
	}
}

// Retire advances the exact key generation, rejects in-flight admissions, and
// removes the current link without waiting for transport I/O. The returned
// handle owns only the removed link and may be closed asynchronously.
func (m *Manager[K, M]) Retire(key K) Retirement {
	if m == nil {
		return Retirement{}
	}
	var closing *managedLink[K, M]
	var cancelAdmissions []context.CancelCauseFunc
	var flight *establishFlight
	m.mu.Lock()
	m.keyGenerations[key]++
	for admission := range m.admissions {
		if admission.key == key {
			cancelAdmissions = append(cancelAdmissions, admission.cancel)
		}
	}
	if link := m.links[key]; link != nil {
		delete(m.links, key)
		link.closed = true
		link.stopIdleLocked()
		closing = link
	}
	if flight = m.flights[key]; flight != nil {
		delete(m.flights, key)
	}
	m.mu.Unlock()
	flight.finish()
	for _, cancel := range cancelAdmissions {
		cancel(ErrAdmissionInvalidated)
	}
	if closing != nil {
		closing.revokeHandlers()
		m.notify(closing, LinkDisconnected)
		return Retirement{close: closing.closeTransport}
	}
	return Retirement{}
}

func (m *Manager[K, M]) Invalidate(key K) {
	retirement := m.Retire(key)
	_ = retirement.Close()
}

// RetireAll advances the manager generation, cancels every in-flight
// admission, and removes all pooled links without waiting for transport I/O.
// The manager remains reusable and every returned handle owns one exact old
// link.
func (m *Manager[K, M]) RetireAll() []Retirement {
	return m.retireAll(false)
}

// InvalidateAll preserves the legacy synchronous cleanup contract. Lifecycle
// callers that must remain live across a blocked Link.Close use RetireAll.
func (m *Manager[K, M]) InvalidateAll() {
	closeRetirements(m.RetireAll())
}

// SetEnabled atomically pauses or resumes admission. Disabling advances the
// global generation, rejects future Admit calls, cancels in-flight admissions,
// and closes pooled links. Enabling starts another fresh generation.
func (m *Manager[K, M]) SetEnabled(enabled bool) error {
	if m == nil {
		return ErrManagerClosed
	}
	if enabled {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closing {
			return ErrManagerClosed
		}
		if m.enabled {
			return nil
		}
		m.globalGeneration++
		m.enabled = true
		return nil
	}

	var closing []*managedLink[K, M]
	var cancelAdmissions []context.CancelCauseFunc
	var flights []*establishFlight
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosed
	}
	if !m.enabled {
		m.mu.Unlock()
		return nil
	}
	m.enabled = false
	m.globalGeneration++
	for admission := range m.admissions {
		cancelAdmissions = append(cancelAdmissions, admission.cancel)
	}
	for key, link := range m.links {
		delete(m.links, key)
		link.closed = true
		link.stopIdleLocked()
		closing = append(closing, link)
	}
	for key, flight := range m.flights {
		delete(m.flights, key)
		flights = append(flights, flight)
	}
	m.mu.Unlock()
	for _, flight := range flights {
		flight.finish()
	}
	for _, cancel := range cancelAdmissions {
		cancel(ErrAdmissionInvalidated)
	}
	for _, link := range closing {
		m.notify(link, LinkDisconnected)
		_ = link.closeTransport()
	}
	return nil
}

// BeginQuiescence permanently closes admission and cancels all stream handlers.
func (m *Manager[K, M]) BeginQuiescence() {
	closeRetirements(m.retireAll(true))
}

func (m *Manager[K, M]) WaitForQuiescence(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.BeginQuiescence()
	m.waitOnce.Do(func() {
		go func() {
			m.wg.Wait()
			close(m.quiesced)
		}()
	})
	select {
	case <-m.quiesced:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager[K, M]) retireAll(permanent bool) []Retirement {
	if m == nil {
		return nil
	}
	var closing []*managedLink[K, M]
	var cancelAdmissions []context.CancelCauseFunc
	var flights []*establishFlight
	m.mu.Lock()
	m.globalGeneration++
	if permanent && !m.closing {
		m.closing = true
		m.enabled = false
		m.cancel()
	}
	for admission := range m.admissions {
		cancelAdmissions = append(cancelAdmissions, admission.cancel)
	}
	for key, link := range m.links {
		delete(m.links, key)
		link.closed = true
		link.stopIdleLocked()
		closing = append(closing, link)
	}
	for key, flight := range m.flights {
		delete(m.flights, key)
		flights = append(flights, flight)
	}
	m.mu.Unlock()
	for _, flight := range flights {
		flight.finish()
	}
	for _, cancel := range cancelAdmissions {
		cancel(ErrAdmissionInvalidated)
	}
	for _, link := range closing {
		link.revokeHandlers()
		m.notify(link, LinkDisconnected)
	}
	retirements := make([]Retirement, 0, len(closing))
	for _, link := range closing {
		retirements = append(retirements, Retirement{close: link.closeTransport})
	}
	return retirements
}

func closeRetirements(retirements []Retirement) {
	for index := range retirements {
		_ = retirements[index].Close()
	}
}

func (m *Manager[K, M]) acceptStreams(link *managedLink[K, M]) {
	defer m.wg.Done()
	for {
		stream, err := link.link.AcceptStream(link.handlerCtx)
		if err != nil {
			m.remove(link)
			return
		}
		m.mu.Lock()
		if m.closing || link.closed || m.links[link.key] != link {
			m.mu.Unlock()
			_ = stream.Close()
			m.remove(link)
			return
		}
		link.acquireStreamLocked()
		m.wg.Add(1)
		m.mu.Unlock()
		m.notify(link, LinkReady)
		managed := &managedStream{Conn: stream, release: link.releaseStream}
		incoming := IncomingStream[K, M]{
			Key:          link.key,
			ConnectionID: link.connectionID,
			Metadata:     link.metadata,
			Stream:       managed,
		}
		go func() {
			defer m.wg.Done()
			defer managed.Close()
			if link.handleIncoming != nil {
				_ = link.handleIncoming(link.handlerCtx, incoming)
			}
		}()
	}
}

func (m *Manager[K, M]) remove(link *managedLink[K, M]) {
	if m == nil || link == nil {
		return
	}
	m.mu.Lock()
	removedCurrent := false
	if m.links[link.key] == link {
		delete(m.links, link.key)
		removedCurrent = true
	}
	link.closed = true
	link.stopIdleLocked()
	m.mu.Unlock()
	if removedCurrent {
		m.notify(link, LinkDisconnected)
	}
	_ = link.closeTransport()
}

func (m *Manager[K, M]) notify(link *managedLink[K, M], state LinkState) {
	if m == nil || link == nil || m.cfg.Observe == nil {
		return
	}
	m.mu.Lock()
	if state == LinkReady && (link.closed || m.links[link.key] != link) {
		m.mu.Unlock()
		return
	}
	if state == LinkDisconnected && link.disconnected {
		m.mu.Unlock()
		return
	}
	link.eventSequence++
	if state == LinkDisconnected {
		link.disconnected = true
	}
	event := LinkEvent[K, M]{
		Key:           link.key,
		ConnectionID:  link.connectionID,
		Sequence:      link.eventSequence,
		Metadata:      link.metadata,
		State:         state,
		ActiveStreams: link.activeStreams,
		ChangedAt:     m.cfg.Now().UTC(),
	}
	m.mu.Unlock()
	m.cfg.Observe(event)
}

func (m *Manager[K, M]) releaseAdmission(admission *Admission[K, M]) {
	m.mu.Lock()
	if _, ok := m.admissions[admission]; ok {
		delete(m.admissions, admission)
		m.mu.Unlock()
		m.wg.Done()
		return
	}
	m.mu.Unlock()
}

func (link *managedLink[K, M]) acquireStreamLocked() {
	link.idleGeneration++
	if link.idleTimer != nil {
		link.idleTimer.Stop()
		link.idleTimer = nil
	}
	link.activeStreams++
}

func (link *managedLink[K, M]) releaseStream() {
	if link == nil || link.manager == nil {
		return
	}
	manager := link.manager
	manager.mu.Lock()
	if link.activeStreams > 0 {
		link.activeStreams--
	}
	current := !link.closed && manager.links[link.key] == link
	if current && link.activeStreams == 0 {
		link.scheduleIdleLocked()
	}
	manager.mu.Unlock()
	if current {
		manager.notify(link, LinkReady)
	}
}

func (link *managedLink[K, M]) scheduleIdleLocked() {
	link.idleGeneration++
	generation := link.idleGeneration
	if link.idleTimer != nil {
		link.idleTimer.Stop()
	}
	link.idleTimer = time.AfterFunc(link.manager.cfg.IdleGrace, func() {
		link.manager.expireIdle(link, generation)
	})
}

func (link *managedLink[K, M]) stopIdleLocked() {
	link.idleGeneration++
	if link.idleTimer != nil {
		link.idleTimer.Stop()
		link.idleTimer = nil
	}
}

func (m *Manager[K, M]) expireIdle(link *managedLink[K, M], generation uint64) {
	if m == nil || link == nil {
		return
	}
	m.mu.Lock()
	if link.closed ||
		m.links[link.key] != link ||
		link.activeStreams != 0 ||
		link.idleGeneration != generation {
		m.mu.Unlock()
		return
	}
	delete(m.links, link.key)
	link.closed = true
	link.idleTimer = nil
	m.mu.Unlock()
	m.notify(link, LinkDisconnected)
	_ = link.closeTransport()
}

func (link *managedLink[K, M]) revokeHandlers() {
	if link == nil {
		return
	}
	link.revokeOnce.Do(func() {
		if link.cancelHandlers != nil {
			link.cancelHandlers()
		}
	})
}

func (link *managedLink[K, M]) closeTransport() error {
	if link == nil {
		return nil
	}
	link.closeOnce.Do(func() {
		link.revokeHandlers()
		if link.link != nil {
			link.closeErr = link.link.Close()
		}
	})
	return link.closeErr
}

type managedStream struct {
	net.Conn
	once    sync.Once
	release func()
}

func (stream *managedStream) Close() error {
	if stream == nil || stream.Conn == nil {
		return nil
	}
	var err error
	stream.once.Do(func() {
		err = stream.Conn.Close()
		if stream.release != nil {
			stream.release()
		}
	})
	return err
}
