package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

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

func (b agentRuntimeActivityEventBridge) ObserveRuntimeStreamEvents(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	events []agentruntime.StreamEvent,
) error {
	var publishErrors []error
	for _, streamEvent := range events {
		if streamEvent.EventType != agentruntime.StreamEventMessageDelta {
			continue
		}
		event, ok := streamEvent.Data.(liveprotocol.Event)
		if !ok {
			publishErrors = append(
				publishErrors,
				fmt.Errorf("message_delta stream data has type %T", streamEvent.Data),
			)
			continue
		}
		if event.EventType != liveprotocol.EventTypeMessageDelta ||
			strings.TrimSpace(event.WorkspaceID) != strings.TrimSpace(workspaceID) ||
			strings.TrimSpace(event.AgentSessionID) != strings.TrimSpace(agentSessionID) {
			publishErrors = append(
				publishErrors,
				errors.New("message_delta stream identity does not match its runtime scope"),
			)
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
