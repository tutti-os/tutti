package agenthost

import (
	"context"
	"errors"
	"strings"
	"sync"
)

var errWorkspaceRuntimeDisconnectReentrant = errors.New("workspace runtime disconnect requested by an admitted operation")
var errWorkspaceRuntimeDisconnectFenceReleased = errors.New("workspace runtime disconnect fence is released")

type workspaceRuntimeAdmission struct {
	mu     sync.Mutex
	states map[string]*workspaceRuntimeAdmissionState
}

type workspaceRuntimeAdmissionState struct {
	changed       chan struct{}
	operations    int
	disconnecting bool
	disconnectors int
	exclusive     bool
	refs          int
	deferred      []func(context.Context)
}

// WorkspaceRuntimeDisconnectFence closes Workspace runtime admission as soon
// as it is acquired. Wait may be retried with a new context without reopening
// admission; Release is idempotent and reopens admission only after every
// joined owner has released its fence.
type WorkspaceRuntimeDisconnectFence struct {
	gate        *workspaceRuntimeAdmission
	workspaceID string
	state       *workspaceRuntimeAdmissionState

	mu        sync.Mutex
	released  bool
	exclusive bool
}

type workspaceRuntimeAdmissionContext struct {
	gate        *workspaceRuntimeAdmission
	workspaceID string
	exclusive   bool
}

type workspaceRuntimeAdmissionContextKey struct{}
type workspaceRuntimeDeferredDisconnectContextKey struct{}

func newWorkspaceRuntimeAdmission() *workspaceRuntimeAdmission {
	return &workspaceRuntimeAdmission{states: make(map[string]*workspaceRuntimeAdmissionState)}
}

func (g *workspaceRuntimeAdmission) enterOperation(
	ctx context.Context,
	workspaceID string,
) (context.Context, func(), error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if g == nil || workspaceID == "" {
		return ctx, func() {}, ErrInvalidArgument
	}
	if err := ctx.Err(); err != nil {
		return ctx, func() {}, err
	}
	if admission, ok := ctx.Value(workspaceRuntimeAdmissionContextKey{}).(workspaceRuntimeAdmissionContext); ok &&
		admission.gate == g && admission.workspaceID == workspaceID {
		return ctx, func() {}, nil
	}
	for {
		g.mu.Lock()
		state := g.stateLocked(workspaceID)
		if !state.disconnecting {
			state.operations++
			g.mu.Unlock()
			operationCtx := context.WithValue(ctx, workspaceRuntimeAdmissionContextKey{}, workspaceRuntimeAdmissionContext{
				gate: g, workspaceID: workspaceID,
			})
			var once sync.Once
			return operationCtx, func() {
				once.Do(func() { g.leaveOperation(workspaceID, state) })
			}, nil
		}
		changed := state.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			g.releaseReference(workspaceID, state)
			return ctx, func() {}, ctx.Err()
		case <-changed:
			g.releaseReference(workspaceID, state)
		}
	}
}

func (g *workspaceRuntimeAdmission) beginDisconnect(
	ctx context.Context,
	workspaceID string,
) (context.Context, func(), error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if g == nil || workspaceID == "" {
		return ctx, func() {}, ErrInvalidArgument
	}
	if admission, ok := ctx.Value(workspaceRuntimeAdmissionContextKey{}).(workspaceRuntimeAdmissionContext); ok &&
		admission.gate == g && admission.workspaceID == workspaceID {
		if admission.exclusive {
			return ctx, func() {}, nil
		}
		return ctx, func() {}, errWorkspaceRuntimeDisconnectReentrant
	}
	fence, err := g.acquireDisconnectFence(ctx, workspaceID)
	if err != nil {
		return ctx, func() {}, err
	}
	disconnectCtx, err := fence.Wait(ctx)
	if err != nil {
		fence.Release()
		return ctx, func() {}, err
	}
	return disconnectCtx, fence.Release, nil
}

func (g *workspaceRuntimeAdmission) acquireDisconnectFence(
	ctx context.Context,
	workspaceID string,
) (*WorkspaceRuntimeDisconnectFence, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if g == nil || workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if admission, ok := ctx.Value(workspaceRuntimeAdmissionContextKey{}).(workspaceRuntimeAdmissionContext); ok &&
		admission.gate == g && admission.workspaceID == workspaceID {
		return nil, errWorkspaceRuntimeDisconnectReentrant
	}
	g.mu.Lock()
	state := g.stateLocked(workspaceID)
	state.disconnectors++
	if !state.disconnecting {
		state.disconnecting = true
		g.notifyLocked(state)
	}
	g.mu.Unlock()
	return &WorkspaceRuntimeDisconnectFence{gate: g, workspaceID: workspaceID, state: state}, nil
}

// Wait drains already-admitted operations and grants one exclusive disconnect
// scope. A canceled wait leaves the fence and admission closure intact so the
// owner can retry without admitting a runtime mutation in between.
func (f *WorkspaceRuntimeDisconnectFence) Wait(ctx context.Context) (context.Context, error) {
	if f == nil || f.gate == nil || f.state == nil {
		return ctx, ErrInvalidArgument
	}
	if err := ctx.Err(); err != nil {
		return ctx, err
	}
	f.mu.Lock()
	if f.released {
		f.mu.Unlock()
		return ctx, errWorkspaceRuntimeDisconnectFenceReleased
	}
	if f.exclusive {
		f.mu.Unlock()
		return context.WithValue(ctx, workspaceRuntimeAdmissionContextKey{}, workspaceRuntimeAdmissionContext{
			gate: f.gate, workspaceID: f.workspaceID, exclusive: true,
		}), nil
	}
	f.mu.Unlock()
	for {
		f.gate.mu.Lock()
		if f.state.operations == 0 && !f.state.exclusive {
			f.mu.Lock()
			if f.released {
				f.mu.Unlock()
				f.gate.mu.Unlock()
				return ctx, errWorkspaceRuntimeDisconnectFenceReleased
			}
			f.state.exclusive = true
			f.exclusive = true
			f.mu.Unlock()
			f.gate.mu.Unlock()
			return context.WithValue(ctx, workspaceRuntimeAdmissionContextKey{}, workspaceRuntimeAdmissionContext{
				gate: f.gate, workspaceID: f.workspaceID, exclusive: true,
			}), nil
		}
		changed := f.state.changed
		f.gate.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx, ctx.Err()
		case <-changed:
		}
	}
}

// Release relinquishes this caller's fence ownership. Admission remains closed
// while another joined owner exists.
func (f *WorkspaceRuntimeDisconnectFence) Release() {
	if f == nil || f.gate == nil || f.state == nil {
		return
	}
	f.gate.mu.Lock()
	f.mu.Lock()
	if f.released {
		f.mu.Unlock()
		f.gate.mu.Unlock()
		return
	}
	f.released = true
	if f.exclusive {
		f.state.exclusive = false
		f.exclusive = false
	}
	f.state.disconnectors--
	if f.state.disconnectors == 0 && len(f.state.deferred) == 0 {
		f.state.disconnecting = false
	}
	f.gate.notifyLocked(f.state)
	f.gate.releaseReferenceLocked(f.workspaceID, f.state)
	f.mu.Unlock()
	f.gate.mu.Unlock()
}

func (g *workspaceRuntimeAdmission) stateLocked(workspaceID string) *workspaceRuntimeAdmissionState {
	state := g.states[workspaceID]
	if state == nil {
		state = &workspaceRuntimeAdmissionState{changed: make(chan struct{})}
		g.states[workspaceID] = state
	}
	state.refs++
	return state
}

func (g *workspaceRuntimeAdmission) leaveOperation(workspaceID string, state *workspaceRuntimeAdmissionState) {
	g.mu.Lock()
	state.operations--
	g.notifyLocked(state)
	var deferred []func(context.Context)
	if state.operations == 0 && len(state.deferred) > 0 {
		deferred = append(deferred, state.deferred...)
		state.deferred = nil
		state.exclusive = true
	}
	if len(deferred) == 0 {
		g.releaseReferenceLocked(workspaceID, state)
	}
	g.mu.Unlock()
	if len(deferred) == 0 {
		return
	}
	disconnectCtx := context.WithValue(context.Background(), workspaceRuntimeAdmissionContextKey{}, workspaceRuntimeAdmissionContext{
		gate: g, workspaceID: workspaceID, exclusive: true,
	})
	// The deferred sweep is best-effort and ordered. If a callback panics,
	// propagate the panic but always reopen admission; callbacks after the
	// panicking callback are not run because their ordering may depend on it.
	defer g.finishDeferredDisconnect(workspaceID, state)
	for _, disconnect := range deferred {
		disconnect(disconnectCtx)
	}
}

func (g *workspaceRuntimeAdmission) deferDisconnect(
	workspaceID string,
	disconnect func(context.Context),
) {
	g.mu.Lock()
	state := g.states[workspaceID]
	if state == nil || state.operations == 0 {
		g.mu.Unlock()
		return
	}
	state.disconnecting = true
	state.deferred = append(state.deferred, disconnect)
	g.notifyLocked(state)
	g.mu.Unlock()
}

func (g *workspaceRuntimeAdmission) finishDeferredDisconnect(workspaceID string, state *workspaceRuntimeAdmissionState) {
	g.mu.Lock()
	state.exclusive = false
	if state.disconnectors == 0 {
		state.disconnecting = false
	}
	g.notifyLocked(state)
	g.releaseReferenceLocked(workspaceID, state)
	g.mu.Unlock()
}

func (g *workspaceRuntimeAdmission) releaseReference(workspaceID string, state *workspaceRuntimeAdmissionState) {
	g.mu.Lock()
	g.releaseReferenceLocked(workspaceID, state)
	g.mu.Unlock()
}

func (g *workspaceRuntimeAdmission) releaseReferenceLocked(workspaceID string, state *workspaceRuntimeAdmissionState) {
	state.refs--
	if state.refs == 0 && state.operations == 0 && !state.disconnecting && g.states[workspaceID] == state {
		delete(g.states, workspaceID)
	}
}

func (*workspaceRuntimeAdmission) notifyLocked(state *workspaceRuntimeAdmissionState) {
	close(state.changed)
	state.changed = make(chan struct{})
}

func (h *Host) withWorkspaceRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	fn func(context.Context) error,
) error {
	if h == nil || h.workspaceRuntimeAdmission == nil || fn == nil {
		return ErrInvalidArgument
	}
	operationCtx, release, err := h.workspaceRuntimeAdmission.enterOperation(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer release()
	return fn(operationCtx)
}

// WithWorkspaceRuntimeOperation runs one caller-owned runtime mutation under
// Host's Workspace admission. The admitted context is reentrant for Host
// lifecycle calls in the callback and must cover the complete mutation,
// including its cleanup.
func (h *Host) WithWorkspaceRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	fn func(context.Context) error,
) error {
	return h.withWorkspaceRuntimeOperation(ctx, workspaceID, fn)
}

// AcquireWorkspaceRuntimeDisconnectFence synchronously prevents new runtime
// mutations in one Workspace. Its Wait may be retried after cancellation; the
// caller must always Release the returned fence.
func (h *Host) AcquireWorkspaceRuntimeDisconnectFence(
	ctx context.Context,
	workspaceID string,
) (*WorkspaceRuntimeDisconnectFence, error) {
	if h == nil || h.workspaceRuntimeAdmission == nil {
		return nil, ErrInvalidArgument
	}
	return h.workspaceRuntimeAdmission.acquireDisconnectFence(ctx, workspaceID)
}

// BeginWorkspaceRuntimeDisconnect prevents new runtime mutations in one
// Workspace and waits for mutations already admitted there. The returned
// context must be used for DisconnectWorkspaceRuntime while release is held.
func (h *Host) BeginWorkspaceRuntimeDisconnect(
	ctx context.Context,
	workspaceID string,
) (context.Context, func(), error) {
	if h == nil || h.workspaceRuntimeAdmission == nil {
		return ctx, func() {}, ErrInvalidArgument
	}
	disconnectCtx, release, err := h.workspaceRuntimeAdmission.beginDisconnect(ctx, workspaceID)
	if errors.Is(err, errWorkspaceRuntimeDisconnectReentrant) {
		// A transport may request attach cleanup while its Host operation already
		// owns admission. Let physical cleanup continue on the caller's existing
		// attachAxis; DisconnectWorkspaceRuntime will defer only its semantic sweep
		// until this operation leaves.
		return context.WithValue(ctx, workspaceRuntimeDeferredDisconnectContextKey{}, true), func() {}, nil
	}
	return disconnectCtx, release, err
}
