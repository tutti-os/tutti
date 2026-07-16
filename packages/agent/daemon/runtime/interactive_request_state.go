package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
)

type pendingInteractiveRequest struct {
	agentSessionID string
	requestID      string
	eventID        string
	callID         string
	callType       string
	turnID         string
	// providerTurnID is transport correlation; turnID remains canonical ownership.
	providerTurnID  string
	input           map[string]any
	kind            string
	approvalPurpose string
	name            string
	toolName        string
	prompt          *SessionInteractivePrompt
	options         []map[string]any
	response        chan pendingInteractiveResponse
	stateMu         sync.Mutex
	state           pendingInteractiveRequestState
	done            chan struct{}
	onTerminal      func(*pendingInteractiveRequest, pendingInteractiveRequestState)
}

const approvalPurposeEditFiles = "edit-files"

func normalizedApprovalPurpose(toolCall map[string]any) string {
	if strings.EqualFold(strings.TrimSpace(asString(toolCall["kind"])), "edit") {
		return approvalPurposeEditFiles
	}
	return ""
}

func (p *pendingInteractiveRequest) beginResolving() (pendingInteractiveRequestState, bool) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		p.state = pendingInteractiveRequestStatePending
	}
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state == pendingInteractiveRequestStatePending {
		p.state = pendingInteractiveRequestStateResolving
		return pendingInteractiveRequestStateResolving, true
	}
	return p.state, false
}

func (p *pendingInteractiveRequest) releaseResolving() bool {
	if p == nil {
		return false
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state != pendingInteractiveRequestStateResolving {
		return false
	}
	p.state = pendingInteractiveRequestStatePending
	return true
}

// dispatchResponse linearizes delivery to the provider-side responder with the
// pending -> resolving transition. A canceled caller that has not dispatched
// anything leaves the request pending so the durable operation can retry.
func (p *pendingInteractiveRequest) dispatchResponse(ctx context.Context, response pendingInteractiveResponse) (pendingInteractiveRequestState, error) {
	if p == nil {
		return "", errors.New("interactive request is not live")
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		p.state = pendingInteractiveRequestStatePending
	}
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state != pendingInteractiveRequestStatePending {
		return p.state, interactiveDispositionError(p.requestID, p.state)
	}
	if err := ctx.Err(); err != nil {
		return p.state, err
	}
	select {
	case p.response <- response:
		p.state = pendingInteractiveRequestStateResolving
		return p.state, nil
	default:
		return p.state, fmt.Errorf("interactive response channel is unavailable for request %q", p.requestID)
	}
}

func (p *pendingInteractiveRequest) finish(state pendingInteractiveRequestState) bool {
	if p == nil {
		return false
	}
	p.stateMu.Lock()
	if p.done == nil {
		p.done = make(chan struct{})
	}
	if p.state == pendingInteractiveRequestStateAnswered ||
		p.state == pendingInteractiveRequestStateSuperseded ||
		p.state == pendingInteractiveRequestStateInterrupted {
		p.stateMu.Unlock()
		return false
	}
	p.state = state
	close(p.done)
	onTerminal := p.onTerminal
	p.stateMu.Unlock()
	if onTerminal != nil {
		onTerminal(p, state)
	}
	return true
}

func (p *pendingInteractiveRequest) disposition() pendingInteractiveRequestState {
	if p == nil {
		return ""
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.state == "" {
		return pendingInteractiveRequestStatePending
	}
	return p.state
}

func (p *pendingInteractiveRequest) waitForDisposition(ctx context.Context) (pendingInteractiveRequestState, error) {
	p.stateMu.Lock()
	if p.done == nil {
		p.done = make(chan struct{})
	}
	done := p.done
	p.stateMu.Unlock()
	select {
	case <-ctx.Done():
		return p.disposition(), ctx.Err()
	case <-done:
		return p.disposition(), nil
	}
}

func runtimeInteractiveDisposition(pending *pendingInteractiveRequest) InteractiveDisposition {
	if pending == nil {
		return InteractiveDispositionUnknown
	}
	return interactiveDispositionFromState(pending.disposition())
}

func interactiveDispositionFromState(state pendingInteractiveRequestState) InteractiveDisposition {
	switch state {
	case pendingInteractiveRequestStatePending:
		return InteractiveDispositionPending
	case pendingInteractiveRequestStateResolving:
		return InteractiveDispositionResolving
	case pendingInteractiveRequestStateAnswered:
		return InteractiveDispositionAnswered
	case pendingInteractiveRequestStateSuperseded:
		return InteractiveDispositionSuperseded
	case pendingInteractiveRequestStateInterrupted:
		return InteractiveDispositionInterrupted
	default:
		return InteractiveDispositionUnknown
	}
}

const terminalInteractiveDispositionCapacity = 1024

type terminalInteractiveDispositionStore struct {
	entries map[interactiveRequestKey]InteractiveDisposition
	order   []interactiveRequestKey
}

func (s *terminalInteractiveDispositionStore) put(key interactiveRequestKey, disposition InteractiveDisposition) {
	if key.agentSessionID == "" || key.turnID == "" || key.requestID == "" {
		return
	}
	if disposition != InteractiveDispositionAnswered &&
		disposition != InteractiveDispositionSuperseded &&
		disposition != InteractiveDispositionInterrupted {
		return
	}
	if s.entries == nil {
		s.entries = make(map[interactiveRequestKey]InteractiveDisposition)
	}
	if _, exists := s.entries[key]; exists {
		return
	}
	s.order = append(s.order, key)
	s.entries[key] = disposition
	for len(s.order) > terminalInteractiveDispositionCapacity {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.entries, oldest)
	}
}

func (s *terminalInteractiveDispositionStore) get(key interactiveRequestKey) InteractiveDisposition {
	if s == nil || s.entries == nil {
		return InteractiveDispositionUnknown
	}
	if disposition, ok := s.entries[key]; ok {
		return disposition
	}
	return InteractiveDispositionUnknown
}

func interactiveDispositionError(requestID string, state pendingInteractiveRequestState) error {
	switch state {
	case pendingInteractiveRequestStateAnswered:
		return fmt.Errorf("%w: %q", ErrInteractiveAlreadyAnswered, requestID)
	case pendingInteractiveRequestStateResolving:
		return fmt.Errorf("%w: %q is resolving", ErrInteractiveAlreadyAnswered, requestID)
	default:
		return fmt.Errorf("%w: %q", ErrInteractiveRequestNotLive, requestID)
	}
}

type pendingInteractiveResponse struct {
	optionID          string
	action            string
	payload           map[string]any
	result            map[string]any
	err               error
	outOfBandResolved bool
}

func (p *pendingInteractiveRequest) wait(ctx context.Context) (pendingInteractiveResponse, error) {
	if p == nil {
		return pendingInteractiveResponse{}, errors.New("permission request is not live")
	}
	select {
	case <-ctx.Done():
		return pendingInteractiveResponse{}, ctx.Err()
	case selection := <-p.response:
		if selection.outOfBandResolved {
			return selection, nil
		}
		if selection.err != nil {
			return pendingInteractiveResponse{}, selection.err
		}
		return selection, nil
	}
}

func (p *pendingInteractiveRequest) reject(err error) {
	if p == nil {
		return
	}
	if err == nil {
		err = errPermissionRequestCanceled
	}
	if !p.finish(pendingInteractiveRequestStateInterrupted) {
		return
	}
	select {
	case p.response <- pendingInteractiveResponse{err: err}:
	default:
	}
}
