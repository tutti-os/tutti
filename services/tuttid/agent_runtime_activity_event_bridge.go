package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// agentRuntimeActivityEventBridge projects the ordered daemon-local live
// stream into the public business-event WebSocket. Durable canonical updates
// continue to come from ActivityProjection after commit.
type agentRuntimeActivityEventBridge struct {
	publisher eventstreamservice.AgentActivityPublisher
}

//nolint:revive // RuntimeStreamEventFilter requires a bridge method; filtering is stateless.
func (b agentRuntimeActivityEventBridge) FilterRuntimeStreamEvents(
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

func (b agentRuntimeActivityEventBridge) publishSessionReconcileRequired(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	return b.publisher.PublishAgentActivityUpdated(
		ctx,
		workspaceID,
		agentSessionID,
		"session_reconcile_required",
		map[string]any{
			"lastEventUnixMs": time.Now().UnixMilli(),
		},
	)
}

func (b agentRuntimeActivityEventBridge) ObserveRuntimeStreamEvents(
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
