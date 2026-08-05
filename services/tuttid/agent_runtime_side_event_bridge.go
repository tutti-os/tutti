package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// agentRuntimeSideEventBridge keeps the ephemeral Side stream out of the
// canonical agent.activity.updated projection. sequence is bridge-local and
// only orders events within one live Side identity.
type agentRuntimeSideEventBridge struct {
	publisher eventstreamservice.AgentSidePublisher
	session   func(string, string) (agentruntime.Session, bool)
	mu        sync.Mutex
	sequences map[string]int64
}

func configureAgentRuntimeEventObservers(
	controller *agentruntime.Controller,
	events *eventstreamservice.Service,
) {
	controller.SetStreamEventObserver(agentRuntimeActivityEventBridge{
		publisher: eventstreamservice.AgentActivityPublisher{Service: events},
	})
	controller.SetSideStreamEventObserver(&agentRuntimeSideEventBridge{
		publisher: eventstreamservice.AgentSidePublisher{Service: events},
		session:   controller.Session,
	})
}

func (b *agentRuntimeSideEventBridge) ObserveRuntimeStreamEvents(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
	events []agentruntime.StreamEvent,
) error {
	if b == nil || b.session == nil {
		return nil
	}
	session, found := b.session(
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(sideAgentSessionID),
	)
	if !found || !session.IsSideConversation() {
		return nil
	}
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(sideAgentSessionID)
	var publishErrors []error
	b.mu.Lock()
	defer b.mu.Unlock()
	terminal := false
	for _, event := range events {
		data := event.Data
		if liveEvent, ok := event.Data.(liveprotocol.Event); ok {
			if strings.TrimSpace(liveEvent.WorkspaceID) != strings.TrimSpace(workspaceID) ||
				strings.TrimSpace(liveEvent.AgentSessionID) != strings.TrimSpace(sideAgentSessionID) {
				publishErrors = append(
					publishErrors,
					errors.New("side live event identity does not match its runtime scope"),
				)
				continue
			}
			data = json.RawMessage(liveEvent.Data)
		}
		sequence := b.sequences[key] + 1
		if err := b.publisher.PublishAgentSideUpdated(
			ctx,
			workspaceID,
			sideAgentSessionID,
			session.SourceAgentSessionID,
			sequence,
			event.EventType,
			data,
		); err != nil {
			publishErrors = append(publishErrors, err)
			continue
		}
		if b.sequences == nil {
			b.sequences = make(map[string]int64)
		}
		b.sequences[key] = sequence
		if patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch); ok {
			switch strings.TrimSpace(patch.LifecycleStatus) {
			case agentruntime.SessionStatusCompleted, agentruntime.SessionStatusFailed:
				terminal = true
			}
		}
	}
	if terminal {
		delete(b.sequences, key)
	}
	return errors.Join(publishErrors...)
}

func (b *agentRuntimeSideEventBridge) ForgetSideConversation(
	workspaceID string,
	sideAgentSessionID string,
) {
	if b == nil {
		return
	}
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(sideAgentSessionID)
	b.mu.Lock()
	delete(b.sequences, key)
	b.mu.Unlock()
}
