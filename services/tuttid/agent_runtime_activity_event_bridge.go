package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// agentRuntimeActivityEventBridge projects the ordered daemon-local live
// stream into the public business-event WebSocket. Durable canonical updates
// continue to come from ActivityProjection after commit.
type agentRuntimeActivityEventBridge struct {
	publisher              eventstreamservice.AgentActivityPublisher
	reconcileMu            sync.Mutex
	reconcileLastByKey     map[string]time.Time
	reconcileInFlightByKey map[string]struct{}
}

const (
	// A malformed or cross-scoped live event is a hint to refresh canonical
	// state, not a reason to enqueue one refresh per delta. Keep a short retry
	// window so a persistent protocol error still gets periodic recovery while
	// a burst is collapsed to one notification.
	agentRuntimeReconcileThrottle  = 250 * time.Millisecond
	agentRuntimeReconcileRetention = 5 * time.Minute
	agentRuntimeReconcileStateCap  = 1024
)

//nolint:revive // RuntimeStreamEventFilter requires a bridge method; filtering is stateless.
func (b *agentRuntimeActivityEventBridge) FilterRuntimeStreamEvents(
	workspaceID string,
	agentSessionID string,
	events []agentruntime.StreamEvent,
) []agentruntime.StreamEvent {
	filtered := make([]agentruntime.StreamEvent, 0, len(events))
	for _, streamEvent := range events {
		if streamEvent.EventType == agentruntime.StreamEventMessageDelta {
			if runtimeMessageDeltaMatchesScope(streamEvent, workspaceID, agentSessionID) {
				filtered = append(filtered, streamEvent)
			}
			continue
		}
		if event, ok := streamEvent.Data.(liveprotocol.Event); ok &&
			event.EventType == liveprotocol.EventTypeMessageDelta {
			// A message delta must not be relabeled as another runtime stream
			// event to bypass the identity filter.
			continue
		}
		filtered = append(filtered, streamEvent)
	}
	return filtered
}

func (b *agentRuntimeActivityEventBridge) publishSessionReconcileRequired(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	key := workspaceID + "\x00" + agentSessionID
	claimedAt := time.Now()
	if !b.claimSessionReconcile(key, claimedAt) {
		return nil
	}
	err := b.publisher.PublishAgentActivityUpdated(
		ctx,
		workspaceID,
		agentSessionID,
		"session_reconcile_required",
		map[string]any{
			"lastEventUnixMs": time.Now().UnixMilli(),
		},
	)
	b.finishSessionReconcile(key, claimedAt, err)
	return err
}

func (b *agentRuntimeActivityEventBridge) ObserveRuntimeStreamEvents(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	events []agentruntime.StreamEvent,
) error {
	var publishErrors []error
	for _, streamEvent := range events {
		if streamEvent.EventType != agentruntime.StreamEventMessageDelta {
			event, ok := streamEvent.Data.(liveprotocol.Event)
			if !ok || event.EventType != liveprotocol.EventTypeMessageDelta {
				continue
			}
		}
		event, ok := streamEvent.Data.(liveprotocol.Event)
		if !ok {
			publishErrors = append(
				publishErrors,
				fmt.Errorf("message_delta stream data has type %T", streamEvent.Data),
			)
			if err := b.publishSessionReconcileRequired(ctx, workspaceID, agentSessionID); err != nil {
				publishErrors = append(publishErrors, fmt.Errorf("publish session reconcile required: %w", err))
			}
			continue
		}
		if !runtimeMessageDeltaMatchesScope(streamEvent, workspaceID, agentSessionID) {
			publishErrors = append(
				publishErrors,
				fmt.Errorf(
					"message_delta stream identity does not match its runtime scope: expected workspace/session %q/%q, got %q/%q and event type %q",
					strings.TrimSpace(workspaceID),
					strings.TrimSpace(agentSessionID),
					strings.TrimSpace(event.WorkspaceID),
					strings.TrimSpace(event.AgentSessionID),
					event.EventType,
				),
			)
			if err := b.publishSessionReconcileRequired(ctx, workspaceID, agentSessionID); err != nil {
				publishErrors = append(publishErrors, fmt.Errorf("publish session reconcile required: %w", err))
			}
			continue
		}
		if err := b.publisher.PublishAgentActivityUpdatedJSON(
			ctx,
			event.WorkspaceID,
			event.AgentSessionID,
			string(event.EventType),
			event.Data,
		); err != nil {
			publishErrors = append(publishErrors, err)
		}
	}
	return errors.Join(publishErrors...)
}

func (b *agentRuntimeActivityEventBridge) claimSessionReconcile(key string, now time.Time) bool {
	if b == nil || key == "\x00" {
		return false
	}
	b.reconcileMu.Lock()
	defer b.reconcileMu.Unlock()
	if b.reconcileLastByKey == nil {
		b.reconcileLastByKey = make(map[string]time.Time)
	}
	if b.reconcileInFlightByKey == nil {
		b.reconcileInFlightByKey = make(map[string]struct{})
	}
	for staleKey, last := range b.reconcileLastByKey {
		if _, inFlight := b.reconcileInFlightByKey[staleKey]; !inFlight && now.Sub(last) >= agentRuntimeReconcileRetention {
			delete(b.reconcileLastByKey, staleKey)
		}
	}
	if _, inFlight := b.reconcileInFlightByKey[key]; inFlight {
		return false
	}
	if last, ok := b.reconcileLastByKey[key]; ok && now.Sub(last) < agentRuntimeReconcileThrottle {
		return false
	}
	if len(b.reconcileLastByKey) >= agentRuntimeReconcileStateCap {
		var oldestKey string
		var oldest time.Time
		for candidateKey, last := range b.reconcileLastByKey {
			if oldestKey == "" || last.Before(oldest) {
				oldestKey = candidateKey
				oldest = last
			}
		}
		if oldestKey != "" {
			delete(b.reconcileLastByKey, oldestKey)
		}
	}
	b.reconcileInFlightByKey[key] = struct{}{}
	return true
}

func (b *agentRuntimeActivityEventBridge) finishSessionReconcile(key string, claimedAt time.Time, _ error) {
	if b == nil {
		return
	}
	b.reconcileMu.Lock()
	defer b.reconcileMu.Unlock()
	delete(b.reconcileInFlightByKey, key)
	if b.reconcileLastByKey == nil {
		b.reconcileLastByKey = make(map[string]time.Time)
	}
	// Throttle failed attempts too. A broken publisher must not turn a
	// persistent scope mismatch into one retry per incoming delta; the next
	// event after the short window can still retry the recovery signal.
	b.reconcileLastByKey[key] = claimedAt
}

func runtimeMessageDeltaMatchesScope(
	streamEvent agentruntime.StreamEvent,
	workspaceID string,
	agentSessionID string,
) bool {
	if streamEvent.EventType != agentruntime.StreamEventMessageDelta {
		return false
	}
	event, ok := streamEvent.Data.(liveprotocol.Event)
	return ok &&
		event.EventType == liveprotocol.EventTypeMessageDelta &&
		strings.TrimSpace(event.WorkspaceID) == strings.TrimSpace(workspaceID) &&
		strings.TrimSpace(event.AgentSessionID) == strings.TrimSpace(agentSessionID)
}
