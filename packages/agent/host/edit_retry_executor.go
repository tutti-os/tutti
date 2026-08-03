package agenthost

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	editRetryAttemptTimeoutDefault = 15 * time.Second
	editRetryMaxConcurrentDefault  = 4
	editRetryProviderCap           = 1
	editRetryWorkspaceCap          = 2
)

// editRetryExecutor bounds only edit-retry provider work. It deliberately
// does not change scheduling semantics for cancel, interactive, plan, or Goal
// operations. A context-ignoring provider keeps its reservation until return,
// preventing duplicate edit-retry calls across later worker ticks.
type editRetryExecutor struct {
	mu                sync.Mutex
	capacity          chan struct{}
	inFlightOperation map[string]struct{}
	inFlightSession   map[string]struct{}
	providerInFlight  map[string]int
	workspaceInFlight map[string]int
}

func editRetryAttemptTimeout(value time.Duration) time.Duration {
	if value <= 0 {
		return editRetryAttemptTimeoutDefault
	}
	return value
}

func newEditRetryExecutor(maxConcurrent int) *editRetryExecutor {
	if maxConcurrent <= 0 {
		maxConcurrent = editRetryMaxConcurrentDefault
	}
	return &editRetryExecutor{
		capacity:          make(chan struct{}, maxConcurrent),
		inFlightOperation: make(map[string]struct{}),
		inFlightSession:   make(map[string]struct{}),
		providerInFlight:  make(map[string]int),
		workspaceInFlight: make(map[string]int),
	}
}

func editRetryExecutionSessionKey(workspaceID, sessionID string) string {
	return strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(sessionID)
}

func editRetryExecutionProviderKey(operation storesqlite.RuntimeOperation) string {
	if key := strings.TrimSpace(operation.ProviderKey); key != "" {
		return key
	}
	return "unknown:" + strings.TrimSpace(operation.WorkspaceID) + ":" + strings.TrimSpace(operation.AgentSessionID)
}

func (e *editRetryExecutor) reserve(operation storesqlite.RuntimeOperation) bool {
	if e == nil || operation.Kind != storesqlite.RuntimeOperationKindEditRetry {
		return false
	}
	operationID := strings.TrimSpace(operation.OperationID)
	sessionKey := editRetryExecutionSessionKey(operation.WorkspaceID, operation.AgentSessionID)
	providerKey := editRetryExecutionProviderKey(operation)
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, found := e.inFlightOperation[operationID]; found {
		return false
	}
	if _, found := e.inFlightSession[sessionKey]; found {
		return false
	}
	if e.providerInFlight[providerKey] >= editRetryProviderCap || e.workspaceInFlight[operation.WorkspaceID] >= editRetryWorkspaceCap {
		return false
	}
	select {
	case e.capacity <- struct{}{}:
		e.inFlightOperation[operationID] = struct{}{}
		e.inFlightSession[sessionKey] = struct{}{}
		e.providerInFlight[providerKey]++
		e.workspaceInFlight[operation.WorkspaceID]++
		return true
	default:
		return false
	}
}

func (e *editRetryExecutor) release(operation storesqlite.RuntimeOperation) {
	if e == nil {
		return
	}
	sessionKey := editRetryExecutionSessionKey(operation.WorkspaceID, operation.AgentSessionID)
	providerKey := editRetryExecutionProviderKey(operation)
	e.mu.Lock()
	delete(e.inFlightOperation, strings.TrimSpace(operation.OperationID))
	delete(e.inFlightSession, sessionKey)
	e.providerInFlight[providerKey]--
	e.workspaceInFlight[operation.WorkspaceID]--
	e.mu.Unlock()
	<-e.capacity
}

// stepEditRetryOperations is the sole asynchronous lane. It waits only for
// the per-attempt deadline: a provider which ignores cancellation keeps its
// reservation until it really returns, while later ticks can still process
// other providers and all ordinary runtime operations.
func (h *Host) stepEditRetryOperations(ctx context.Context, operations []storesqlite.RuntimeOperation, recovering bool) {
	if h == nil || h.editRetryExecutor == nil {
		return
	}
	var attempts sync.WaitGroup
	for _, operation := range operations {
		if !h.editRetryExecutor.reserve(operation) {
			continue
		}
		attempts.Add(1)
		go func(operation storesqlite.RuntimeOperation) {
			defer attempts.Done()
			defer h.editRetryExecutor.release(operation)
			attemptCtx, cancel := context.WithTimeout(ctx, h.editRetryAttemptTimeout)
			defer cancel()
			result, stepErr := h.stepRuntimeOperationSerialized(attemptCtx, operation, recovering)
			if stepErr != nil && !errors.Is(stepErr, ErrRuntimeOperationInProgress) {
				h.recordRuntimeOperationWorkerFailure("item")
				logRuntimeOperationFailure(operation, stepErr)
				return
			}
			if result.Disposition == operationStepDeferred || result.Disposition == operationStepBlocked {
				h.recordRuntimeOperationWorkerFailure("item")
			}
		}(operation)
	}
	done := make(chan struct{})
	go func() {
		attempts.Wait()
		close(done)
	}()
	timer := time.NewTimer(h.editRetryAttemptTimeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-timer.C:
	}
}
