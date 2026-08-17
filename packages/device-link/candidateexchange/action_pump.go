package candidateexchange

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
)

// ActionKind identifies product I/O requested by an ActionPump.
type ActionKind string

const (
	ActionPublishLocal  ActionKind = "publish_local"
	ActionRefreshRemote ActionKind = "refresh_remote"
)

// Action is one product-owned rendezvous operation. Callback-free consumers
// execute it and return an ActionOutcome through Resolve.
type Action struct {
	ID          uint64
	Kind        ActionKind
	Description authenticated.Description
}

// ActionOutcome reports the result of product-owned rendezvous I/O. Remote
// candidates are used only by ActionRefreshRemote. Error is diagnostic text;
// callers still retain their typed product error for presentation.
type ActionOutcome struct {
	Succeeded        bool
	Retryable        bool
	RemoteCandidates []string
	Error            string
}

// ActionPump owns the local-publication and remote-refresh worker lifecycle
// for callback-free consumers such as gomobile. Each Go worker may issue one
// action so slow product I/O in one direction does not block the other.
type ActionPump struct {
	exchange *Exchange
	ctx      context.Context
	cancel   context.CancelFunc
	actions  chan Action
	done     chan struct{}
	stopped  chan struct{}

	workers        sync.WaitGroup
	stopOnce       sync.Once
	mu             sync.Mutex
	operationsDone *sync.Cond
	nextID         uint64
	pending        map[uint64]*pendingAction
	activeNext     int
	activeResolve  int
	stopping       bool
	err            error
}

type pendingAction struct {
	action        Action
	publicationID uint64
	result        chan ActionOutcome
}

// NewActionPump starts the shared candidate workers.
func NewActionPump(exchange *Exchange) (*ActionPump, error) {
	if exchange == nil || exchange.participant == nil {
		return nil, errors.New("candidate exchange is unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	pump := &ActionPump{
		exchange: exchange,
		ctx:      ctx,
		cancel:   cancel,
		actions:  make(chan Action),
		done:     make(chan struct{}),
		stopped:  make(chan struct{}),
		pending:  make(map[uint64]*pendingAction, 2),
	}
	pump.operationsDone = sync.NewCond(&pump.mu)
	pump.workers.Add(2)
	go pump.runWorker(pump.runLocal)
	go pump.runWorker(pump.runRemote)
	go func() {
		pump.workers.Wait()
		close(pump.done)
	}()
	return pump, nil
}

// Next returns the next product I/O action selected by the Go-owned workers.
func (p *ActionPump) Next(ctx context.Context) (Action, error) {
	if p == nil {
		return Action{}, errors.New("candidate exchange action pump is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	p.mu.Lock()
	if p.stopping {
		err := p.terminalErrorLocked()
		p.mu.Unlock()
		return Action{}, err
	}
	p.activeNext++
	p.mu.Unlock()
	defer p.finishNext()
	select {
	case <-ctx.Done():
		return Action{}, ctx.Err()
	case action := <-p.actions:
		p.mu.Lock()
		if p.stopping || p.pending[action.ID] == nil {
			err := p.terminalErrorLocked()
			p.mu.Unlock()
			return Action{}, err
		}
		action = cloneAction(action)
		p.mu.Unlock()
		return action, nil
	case <-p.done:
		return Action{}, p.terminalError()
	case <-p.ctx.Done():
		return Action{}, p.terminalError()
	}
}

// Resolve completes the outstanding action and returns the number of newly
// inserted remote candidates. A non-retryable failure terminates both workers.
func (p *ActionPump) Resolve(id uint64, outcome ActionOutcome) (int, error) {
	if p == nil {
		return 0, errors.New("candidate exchange action pump is unavailable")
	}
	p.mu.Lock()
	if p.stopping {
		err := p.terminalErrorLocked()
		p.mu.Unlock()
		return 0, err
	}
	pending := p.pending[id]
	if id == 0 || pending == nil {
		p.mu.Unlock()
		return 0, errors.New("candidate exchange action is not pending")
	}
	delete(p.pending, id)
	p.activeResolve++
	terminalOutcome := !outcome.Succeeded && !outcome.Retryable
	if terminalOutcome {
		p.beginStopLocked(actionFailure(pending.action.Kind, outcome.Error))
	}
	p.mu.Unlock()
	if terminalOutcome {
		p.cancel()
	}
	defer p.finishResolve()

	added := 0
	if outcome.Succeeded {
		switch pending.action.Kind {
		case ActionPublishLocal:
			if err := p.exchange.AcknowledgeLocalPublication(pending.publicationID); err != nil {
				p.fail(err)
				return 0, err
			}
		case ActionRefreshRemote:
			added = p.exchange.AddRemoteCandidates(outcome.RemoteCandidates)
		default:
			err := fmt.Errorf("unsupported candidate exchange action %q", pending.action.Kind)
			p.fail(err)
			return 0, err
		}
	}
	pending.result <- outcome
	return added, nil
}

// NotifyRemoteChange forwards a coalesced product push hint to the shared
// remote worker.
func (p *ActionPump) NotifyRemoteChange() {
	if p == nil || p.exchange == nil {
		return
	}
	p.mu.Lock()
	if !p.stopping {
		p.exchange.NotifyRemoteChange()
	}
	p.mu.Unlock()
}

// Stop cancels both workers and waits until no action remains owned by Go.
func (p *ActionPump) Stop() {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() {
		p.mu.Lock()
		p.beginStopLocked(nil)
		p.mu.Unlock()
		p.cancel()
		<-p.done
		p.mu.Lock()
		for p.activeNext != 0 || p.activeResolve != 0 {
			p.operationsDone.Wait()
		}
		p.mu.Unlock()
		close(p.stopped)
	})
	<-p.stopped
}

func (p *ActionPump) runWorker(run func() error) {
	defer p.workers.Done()
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		p.fail(err)
	}
}

func (p *ActionPump) runLocal() error {
	for {
		publication, err := p.exchange.NextLocalPublication(p.ctx)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if publication.CandidateChanged {
			outcome, err := p.request(Action{
				Kind:        ActionPublishLocal,
				Description: publication.Description,
			}, publication.ID)
			if err != nil {
				return err
			}
			if !outcome.Succeeded {
				if outcome.Retryable {
					continue
				}
				return actionFailure(ActionPublishLocal, outcome.Error)
			}
		}
		if publication.GatheringComplete {
			return nil
		}
	}
}

func (p *ActionPump) runRemote() error {
	for {
		if err := p.exchange.WaitRemoteRefresh(p.ctx); err != nil {
			return err
		}
		outcome, err := p.request(Action{Kind: ActionRefreshRemote}, 0)
		if err != nil {
			return err
		}
		if !outcome.Succeeded && !outcome.Retryable {
			return actionFailure(ActionRefreshRemote, outcome.Error)
		}
	}
}

func (p *ActionPump) request(action Action, publicationID uint64) (ActionOutcome, error) {
	result := make(chan ActionOutcome, 1)
	p.mu.Lock()
	if p.stopping {
		err := p.terminalErrorLocked()
		p.mu.Unlock()
		return ActionOutcome{}, err
	}
	p.nextID++
	action.ID = p.nextID
	action = cloneAction(action)
	pending := &pendingAction{
		action: cloneAction(action), publicationID: publicationID, result: result,
	}
	p.pending[action.ID] = pending
	p.mu.Unlock()

	defer func() {
		p.mu.Lock()
		if p.pending[action.ID] == pending {
			delete(p.pending, action.ID)
		}
		p.mu.Unlock()
	}()
	select {
	case p.actions <- action:
	case <-p.ctx.Done():
		return ActionOutcome{}, p.terminalError()
	}
	select {
	case outcome := <-result:
		return outcome, nil
	case <-p.ctx.Done():
		return ActionOutcome{}, p.terminalError()
	}
}

func (p *ActionPump) fail(err error) {
	if err == nil {
		return
	}
	p.mu.Lock()
	p.beginStopLocked(err)
	p.mu.Unlock()
	p.cancel()
}

func (p *ActionPump) beginStopLocked(err error) {
	if err != nil && p.err == nil {
		p.err = err
	}
	p.stopping = true
}

func (p *ActionPump) finishResolve() {
	p.mu.Lock()
	p.activeResolve--
	if p.activeNext == 0 && p.activeResolve == 0 {
		p.operationsDone.Broadcast()
	}
	p.mu.Unlock()
}

func (p *ActionPump) finishNext() {
	p.mu.Lock()
	p.activeNext--
	if p.activeNext == 0 && p.activeResolve == 0 {
		p.operationsDone.Broadcast()
	}
	p.mu.Unlock()
}

func (p *ActionPump) terminalError() error {
	p.mu.Lock()
	err := p.terminalErrorLocked()
	p.mu.Unlock()
	return err
}

func (p *ActionPump) terminalErrorLocked() error {
	if p.err != nil {
		return p.err
	}
	return context.Canceled
}

func cloneAction(action Action) Action {
	action.Description.Candidates = append([]string(nil), action.Description.Candidates...)
	return action
}

func actionFailure(kind ActionKind, detail string) error {
	if detail == "" {
		detail = "product rendezvous operation failed"
	}
	return fmt.Errorf("candidate exchange %s: %s", kind, detail)
}
