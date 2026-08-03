package agenthost

import (
	"context"
	"sync"
)

// RuntimeOperationWorkerSummary is a process-local diagnostic projection. It
// never changes admission or durable state.
type RuntimeOperationWorkerSummary struct {
	ItemFailures                 uint64
	OutboxFailures               uint64
	StoreFailures                uint64
	PostListenerRecoveryFailures uint64
	PostListenerRecoveryDegraded uint64
	LastFailureAtMS              int64
}

const RuntimeOperationHealthDiagnosticActiveStateUnavailable = "runtime_operation_active_state_unavailable"

// RuntimeOperationEditRetryDegradation is the closed durable edit-retry
// health projection. It intentionally is not a generic runtime-operation DTO.
type RuntimeOperationEditRetryDegradation struct {
	WorkspaceID      string
	AgentSessionID   string
	OperationID      string
	State            EditRetryState
	ReasonCode       EditRetryReasonCode
	NextAttemptAtMS  int64
	Attempt          int
	AvailableActions []EditRetryRecoveryAction
}

type RuntimeOperationWorkerHealth struct {
	RuntimeOperationWorkerSummary
	ActiveEditRetryDegradations []RuntimeOperationEditRetryDegradation
	ActiveDegradationCount      int64
	ActiveDegradationsTruncated bool
	ActiveStateAvailable        bool
	DiagnosticCode              string
}

type runtimeOperationWorkerHealth struct {
	mu      sync.Mutex
	summary RuntimeOperationWorkerSummary
}

func (h *Host) RuntimeOperationWorkerSummary() RuntimeOperationWorkerSummary {
	if h == nil {
		return RuntimeOperationWorkerSummary{}
	}
	h.runtimeOperationHealth.mu.Lock()
	defer h.runtimeOperationHealth.mu.Unlock()
	return h.runtimeOperationHealth.summary
}

// RuntimeOperationHealth reads only durable local projections. It never calls
// a provider, so health remains safe while a recovery attempt is blocked.
func (h *Host) RuntimeOperationHealth(ctx context.Context) RuntimeOperationWorkerHealth {
	result := RuntimeOperationWorkerHealth{RuntimeOperationWorkerSummary: h.RuntimeOperationWorkerSummary(), ActiveStateAvailable: true}
	if h == nil || h.runtimeOperationHealthStore == nil {
		result.ActiveStateAvailable = false
		result.DiagnosticCode = RuntimeOperationHealthDiagnosticActiveStateUnavailable
		return result
	}
	items, count, truncated, err := h.runtimeOperationHealthStore.ListActiveEditRetryDegradations(ctx, 50)
	if err != nil {
		result.ActiveStateAvailable = false
		result.DiagnosticCode = RuntimeOperationHealthDiagnosticActiveStateUnavailable
		return result
	}
	result.ActiveDegradationsTruncated = truncated
	result.ActiveDegradationCount = count
	result.ActiveEditRetryDegradations = make([]RuntimeOperationEditRetryDegradation, 0, len(items))
	for _, item := range items {
		projected := editRetryResult(item.Operation, item.History)
		// Health is a closed wire projection: an unresolved durable row must
		// always carry a stable reason, even when an automatic prepared retry
		// has no provider error to classify yet.
		if projected.ReasonCode == "" {
			projected.ReasonCode = EditRetryReasonCodeRecoveryRequired
		}
		if item.Invariant {
			projected.State = EditRetryStateRecoveryRequired
			projected.ReasonCode = EditRetryReasonCodeRecoveryRequired
			// An invariant projection is diagnostic-only: an operation that does
			// not exactly own its fence must not expose a command that could
			// repair or clear another operation's session state.
			projected.AvailableActions = nil
		}
		result.ActiveEditRetryDegradations = append(result.ActiveEditRetryDegradations, RuntimeOperationEditRetryDegradation{WorkspaceID: item.Operation.WorkspaceID, AgentSessionID: item.Operation.AgentSessionID, OperationID: item.Operation.OperationID, State: projected.State, ReasonCode: projected.ReasonCode, NextAttemptAtMS: projected.NextAttemptAtMS, Attempt: projected.Attempt, AvailableActions: projected.AvailableActions})
	}
	return result
}

func (h *Host) recordRuntimeOperationWorkerFailure(kind string) {
	if h == nil {
		return
	}
	h.runtimeOperationHealth.mu.Lock()
	defer h.runtimeOperationHealth.mu.Unlock()
	summary := &h.runtimeOperationHealth.summary
	summary.LastFailureAtMS = h.now().UnixMilli()
	switch kind {
	case "item":
		summary.ItemFailures++
	case "outbox":
		summary.OutboxFailures++
	case "store":
		summary.StoreFailures++
	case "post_listener_recovery":
		summary.PostListenerRecoveryFailures++
	case "post_listener_degraded":
		summary.PostListenerRecoveryDegraded++
	}
}
