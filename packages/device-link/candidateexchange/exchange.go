package candidateexchange

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
)

const (
	defaultLocalDebounce = 200 * time.Millisecond
	defaultPublishRetry  = 200 * time.Millisecond
	defaultRemotePoll    = 500 * time.Millisecond
)

// ErrParticipantClosed reports that the transport ended before the requested
// candidate-exchange operation completed. io.EOF remains reserved for a local
// publication stream whose final gathering update was already delivered.
var ErrParticipantClosed = errors.New("candidate exchange participant is closed")

// Config controls transport-neutral candidate exchange timing. Product
// adapters should normally use the defaults and inject only rendezvous I/O.
type Config struct {
	LocalDebounce time.Duration
	PublishRetry  time.Duration
	RemotePoll    time.Duration
}

// LocalUpdate is one coalesced local description snapshot. CandidateChanged
// distinguishes an end-of-gathering notification from a snapshot that must be
// published to the rendezvous service.
type LocalUpdate struct {
	Description       authenticated.Description
	CandidateChanged  bool
	GatheringComplete bool
}

// LocalPublication is one acknowledgement-bound local snapshot. A retry of a
// failed publication returns the same ID and Description after PublishRetry;
// only AcknowledgeLocalPublication advances to a newer snapshot.
type LocalPublication struct {
	ID uint64
	LocalUpdate
}

// PublishLocalFunc persists the caller or owner description through a
// product-owned rendezvous adapter.
type PublishLocalFunc func(context.Context, authenticated.Description) error

// RetryPublishFunc decides whether a failed publish should be retried. The
// Exchange preserves the exact snapshot across retries.
type RetryPublishFunc func(error) bool

// WaitRemoteChangeFunc waits for a product-owned push hint. Its context is
// bounded by Config.RemotePoll, so a missed hint always falls back to a fetch.
type WaitRemoteChangeFunc func(context.Context) bool

// FetchRemoteCandidatesFunc reads the authoritative remote candidate snapshot.
// Candidate values remain opaque to this package.
type FetchRemoteCandidatesFunc func(context.Context) ([]string, error)

// RetryFetchFunc decides whether a failed authoritative remote fetch should
// wait for the next push hint or poll fallback and try again.
type RetryFetchFunc func(error) bool

// Exchange coordinates one Participant's incremental candidate exchange. It
// does not create attempts, authenticate control-plane calls, or decide which
// transport path wins.
type Exchange struct {
	participant *authenticated.Participant
	cfg         Config
	local       localUpdates
	publication localPublications
	remoteWake  chan struct{}
}

type localUpdates struct {
	mu sync.Mutex

	candidateChanges   <-chan struct{}
	gatheringComplete  <-chan struct{}
	done               <-chan struct{}
	lastCandidateCount int
	completeSeen       bool
	completeDelivered  bool
}

type localPublications struct {
	mu sync.Mutex

	nextID  uint64
	pending *LocalPublication
}

// Start begins asynchronous local gathering and returns the initial
// credentials immediately. Candidates may be empty and must be followed by
// NextLocal or PublishLocal while the connection is being established.
func Start(participant *authenticated.Participant, cfg Config) (*Exchange, authenticated.Description, error) {
	if participant == nil {
		return nil, authenticated.Description{}, errors.New("candidate exchange participant is required")
	}
	cfg = normalizeConfig(cfg)
	initial, err := participant.StartLocalDescription()
	if err != nil {
		return nil, authenticated.Description{}, err
	}
	exchange := &Exchange{
		participant: participant,
		cfg:         cfg,
		remoteWake:  make(chan struct{}, 1),
		local: localUpdates{
			candidateChanges:   participant.LocalCandidateChanges(),
			gatheringComplete:  participant.LocalGatheringComplete(),
			done:               participant.Done(),
			lastCandidateCount: len(initial.Candidates),
		},
	}
	return exchange, initial, nil
}

// NextLocalPublication returns the next acknowledgement-bound local snapshot.
// When a previous snapshot has not been acknowledged, it waits PublishRetry
// and returns that exact snapshot again instead of consuming a newer update.
func (e *Exchange) NextLocalPublication(ctx context.Context) (LocalPublication, error) {
	if e == nil || e.participant == nil {
		return LocalPublication{}, errors.New("candidate exchange is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	e.publication.mu.Lock()
	defer e.publication.mu.Unlock()
	if e.publication.pending != nil {
		if err := wait(ctx, e.cfg.PublishRetry, e.participant.Done()); err != nil {
			return LocalPublication{}, err
		}
		return cloneLocalPublication(*e.publication.pending), nil
	}
	update, err := e.NextLocal(ctx)
	if err != nil {
		return LocalPublication{}, err
	}
	publication := LocalPublication{LocalUpdate: cloneLocalUpdate(update)}
	if update.CandidateChanged {
		e.publication.nextID++
		publication.ID = e.publication.nextID
		pending := cloneLocalPublication(publication)
		e.publication.pending = &pending
	}
	return cloneLocalPublication(publication), nil
}

// AcknowledgeLocalPublication commits a successfully persisted snapshot.
func (e *Exchange) AcknowledgeLocalPublication(id uint64) error {
	if e == nil || e.participant == nil {
		return errors.New("candidate exchange is unavailable")
	}
	e.publication.mu.Lock()
	defer e.publication.mu.Unlock()
	if id == 0 || e.publication.pending == nil || e.publication.pending.ID != id {
		return errors.New("candidate exchange local publication is not pending")
	}
	e.publication.pending = nil
	return nil
}

// NextLocal waits for the next coalesced local candidate snapshot. It returns
// io.EOF after the final gathering-complete update has been delivered.
func (e *Exchange) NextLocal(ctx context.Context) (LocalUpdate, error) {
	if e == nil || e.participant == nil {
		return LocalUpdate{}, errors.New("candidate exchange is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	e.local.mu.Lock()
	defer e.local.mu.Unlock()
	if e.local.completeDelivered {
		return LocalUpdate{}, io.EOF
	}

	for {
		if err := e.waitForLocalChange(ctx); err != nil {
			return LocalUpdate{}, err
		}
		description, err := e.participant.LocalDescriptionSnapshot()
		if err != nil {
			return LocalUpdate{}, err
		}
		changed := len(description.Candidates) > e.local.lastCandidateCount
		if !changed && !e.local.completeSeen {
			continue
		}
		e.local.lastCandidateCount = len(description.Candidates)
		update := LocalUpdate{
			Description:       description,
			CandidateChanged:  changed,
			GatheringComplete: e.local.completeSeen,
		}
		if update.GatheringComplete {
			e.local.completeDelivered = true
		}
		return update, nil
	}
}

// PublishLocal drains local updates into a product rendezvous callback. A
// failed publication keeps the same snapshot and retries only when retry says
// it is safe to do so.
func (e *Exchange) PublishLocal(
	ctx context.Context,
	publish PublishLocalFunc,
	retry RetryPublishFunc,
) error {
	if publish == nil {
		return errors.New("candidate exchange local publisher is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		publication, err := e.NextLocalPublication(ctx)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if publication.CandidateChanged {
			if err := publish(ctx, publication.Description); err != nil {
				if retry != nil && retry(err) {
					continue
				}
				return err
			}
			if err := e.AcknowledgeLocalPublication(publication.ID); err != nil {
				return err
			}
		}
		if publication.GatheringComplete {
			return nil
		}
	}
}

// AddRemoteCandidates trickles an authoritative remote snapshot into a
// Connect that may already be running. Duplicate candidates are ignored by the
// Participant.
func (e *Exchange) AddRemoteCandidates(candidates []string) int {
	if e == nil || e.participant == nil {
		return 0
	}
	return e.participant.AddRemoteCandidates(candidates)
}

// NotifyRemoteChange records a product push hint. Hints coalesce because the
// following authoritative fetch, not the hint count, owns candidate truth.
func (e *Exchange) NotifyRemoteChange() {
	if e == nil || e.remoteWake == nil {
		return
	}
	select {
	case e.remoteWake <- struct{}{}:
	default:
	}
}

// WaitRemoteRefresh waits for a coalesced push hint or the authoritative poll
// fallback. Mobile bindings use this callback-free form so poll scheduling is
// owned by the same coordinator as Go callback consumers.
func (e *Exchange) WaitRemoteRefresh(ctx context.Context) error {
	if e == nil || e.participant == nil {
		return errors.New("candidate exchange is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	timer := time.NewTimer(e.cfg.RemotePoll)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-e.participant.Done():
		return ErrParticipantClosed
	case <-e.remoteWake:
		return nil
	case <-timer.C:
		return nil
	}
}

// FeedRemote refetches authoritative remote candidates after a push hint or
// the poll fallback and feeds them into an in-progress Connect. Fetch errors
// are reported and retried only when retry explicitly classifies them as
// recoverable.
func (e *Exchange) FeedRemote(
	ctx context.Context,
	waitRemoteChange WaitRemoteChangeFunc,
	fetch FetchRemoteCandidatesFunc,
	retry RetryFetchFunc,
	onFetchError func(error),
) error {
	if e == nil || e.participant == nil {
		return errors.New("candidate exchange is unavailable")
	}
	if fetch == nil {
		return errors.New("candidate exchange remote fetcher is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		if err := e.waitForRemoteRefresh(ctx, waitRemoteChange); err != nil {
			return err
		}
		candidates, err := fetch(ctx)
		if err != nil {
			if onFetchError != nil {
				onFetchError(err)
			}
			if retry != nil && retry(err) {
				continue
			}
			return err
		}
		e.AddRemoteCandidates(candidates)
	}
}

func (e *Exchange) waitForLocalChange(ctx context.Context) error {
	if e.local.completeSeen {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-e.local.done:
		return ErrParticipantClosed
	case _, ok := <-e.local.candidateChanges:
		if !ok {
			e.local.candidateChanges = nil
		}
	case <-e.local.gatheringComplete:
		e.local.completeSeen = true
		e.local.gatheringComplete = nil
	}
	return e.coalesceLocalChanges(ctx)
}

func (e *Exchange) coalesceLocalChanges(ctx context.Context) error {
	timer := time.NewTimer(e.cfg.LocalDebounce)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-e.local.done:
			return ErrParticipantClosed
		case _, ok := <-e.local.candidateChanges:
			if !ok {
				e.local.candidateChanges = nil
				continue
			}
			resetTimer(timer, e.cfg.LocalDebounce)
		case <-e.local.gatheringComplete:
			e.local.completeSeen = true
			e.local.gatheringComplete = nil
			resetTimer(timer, e.cfg.LocalDebounce)
		case <-timer.C:
			return nil
		}
	}
}

func (e *Exchange) waitForRemoteRefresh(ctx context.Context, waitRemoteChange WaitRemoteChangeFunc) error {
	if waitRemoteChange == nil {
		return e.WaitRemoteRefresh(ctx)
	}
	waitCtx, cancel := context.WithTimeout(ctx, e.cfg.RemotePoll)
	notified := waitRemoteChange(waitCtx)
	if !notified {
		select {
		case <-waitCtx.Done():
		case <-e.participant.Done():
			cancel()
			return ErrParticipantClosed
		}
	}
	cancel()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-e.participant.Done():
		return ErrParticipantClosed
	default:
		return nil
	}
}

func normalizeConfig(cfg Config) Config {
	if cfg.LocalDebounce <= 0 {
		cfg.LocalDebounce = defaultLocalDebounce
	}
	if cfg.PublishRetry <= 0 {
		cfg.PublishRetry = defaultPublishRetry
	}
	if cfg.RemotePoll <= 0 {
		cfg.RemotePoll = defaultRemotePoll
	}
	return cfg
}

func cloneLocalPublication(publication LocalPublication) LocalPublication {
	publication.LocalUpdate = cloneLocalUpdate(publication.LocalUpdate)
	return publication
}

func cloneLocalUpdate(update LocalUpdate) LocalUpdate {
	update.Description.Candidates = append([]string(nil), update.Description.Candidates...)
	return update
}

func wait(ctx context.Context, delay time.Duration, done <-chan struct{}) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return ErrParticipantClosed
	case <-timer.C:
		return nil
	}
}

func resetTimer(timer *time.Timer, delay time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(delay)
}
