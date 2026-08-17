package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func claudeSDKEventRequiresBoundProviderIdentity(eventType string) bool {
	switch eventType {
	case "provider_turn_identity_resolved", "provider_turn_checkpoint":
		return true
	default:
		return false
	}
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootProviderTurnStartedEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	metadata map[string]any,
) activityshared.Event {
	ctx, ok := activityEventContext(
		session,
		"root-provider-turn-started:"+providerTurnID,
		rootTurnID,
	)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnStarted(
		ctx,
		rootTurnID,
		providerTurnID,
	)
	binding, err := a.WriteProviderTurnBinding(ProviderTurnBindingWriteInput{
		Kind:           ProviderTurnBindingWriteStarted,
		ProviderTurnID: providerTurnID,
	})
	if err == nil {
		event.Payload.ProviderTurnBindingJSON = binding
	}
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootProviderTurnCheckpointEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	checkpointMessageID string,
) activityshared.Event {
	ctx, ok := activityEventContext(
		session,
		"claude-sdk:provider-turn-checkpoint:"+providerTurnID+":"+checkpointMessageID,
		rootTurnID,
	)
	if !ok {
		return activityshared.Event{}
	}
	binding, err := a.WriteProviderTurnBinding(ProviderTurnBindingWriteInput{
		Kind:           ProviderTurnBindingWriteCheckpoint,
		ProviderTurnID: providerTurnID,
		Payload: map[string]any{
			"checkpointMessageId": checkpointMessageID,
		},
	})
	if err != nil {
		binding = json.RawMessage(`{}`)
	}
	return activityshared.NewRootProviderTurnCheckpoint(
		ctx,
		rootTurnID,
		providerTurnID,
		binding,
	)
}

func claudeSDKRootProviderTurnCompletedEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	outcome activityshared.TurnOutcome,
	metadata map[string]any,
) activityshared.Event {
	ctx, ok := activityEventContext(
		session,
		"claude-sdk:provider-turn-completed:"+providerTurnID,
		rootTurnID,
	)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnCompleted(
		ctx,
		rootTurnID,
		providerTurnID,
		outcome,
	)
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

func (a *ClaudeCodeSDKAdapter) beginClaudeSDKRootTurn(
	adapterSession *claudeSDKAdapterSession,
	rootTurnID string,
	providerTurnID string,
) {
	if a == nil || adapterSession == nil {
		return
	}
	rootTurnID = strings.TrimSpace(rootTurnID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	a.mu.Lock()
	adapterSession.rootTurnID = rootTurnID
	adapterSession.rootProviderTurns = make(map[string]struct{})
	if providerTurnID != "" {
		adapterSession.rootProviderTurns[providerTurnID] = struct{}{}
	} else if rootTurnID != "" {
		if adapterSession.providerAcceptanceOutcomes == nil {
			adapterSession.providerAcceptanceOutcomes = make(map[string]*claudeSDKProviderAcceptanceOutcome)
		}
		adapterSession.providerAcceptanceOutcomes[rootTurnID] = &claudeSDKProviderAcceptanceOutcome{
			done: make(chan struct{}),
		}
		pruneClaudeSDKProviderAcceptanceOutcomesLocked(adapterSession, rootTurnID)
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) completeClaudeSDKProviderAcceptance(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
	acceptanceErr error,
) {
	if a == nil || adapterSession == nil {
		return
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return
	}
	a.mu.Lock()
	outcome := adapterSession.providerAcceptanceOutcomes[turnID]
	if outcome != nil {
		outcome.once.Do(func() {
			outcome.err = acceptanceErr
			close(outcome.done)
		})
	}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) waitClaudeSDKProviderAcceptanceOutcome(
	ctx context.Context,
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) error {
	if a == nil || adapterSession == nil {
		return errors.New("claude SDK provider acceptance outcome is unavailable")
	}
	turnID = strings.TrimSpace(turnID)
	a.mu.Lock()
	outcome := adapterSession.providerAcceptanceOutcomes[turnID]
	a.mu.Unlock()
	if outcome == nil {
		return errors.New("claude SDK provider acceptance outcome is unavailable")
	}
	select {
	case <-outcome.done:
		return outcome.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func pruneClaudeSDKProviderAcceptanceOutcomesLocked(
	adapterSession *claudeSDKAdapterSession,
	keepTurnID string,
) {
	if adapterSession == nil || len(adapterSession.providerAcceptanceOutcomes) <= 64 {
		return
	}
	for turnID, outcome := range adapterSession.providerAcceptanceOutcomes {
		if turnID == keepTurnID || outcome == nil {
			continue
		}
		select {
		case <-outcome.done:
			delete(adapterSession.providerAcceptanceOutcomes, turnID)
		default:
		}
		if len(adapterSession.providerAcceptanceOutcomes) <= 64 {
			return
		}
	}
	// A Session admits only one live root Turn. Any older incomplete outcome can
	// no longer become a provider-active cancellation target once a newer root
	// Turn begins, so keep the diagnostic cache bounded without touching the
	// current Turn's latch.
	for turnID := range adapterSession.providerAcceptanceOutcomes {
		if turnID == keepTurnID {
			continue
		}
		delete(adapterSession.providerAcceptanceOutcomes, turnID)
		if len(adapterSession.providerAcceptanceOutcomes) <= 64 {
			return
		}
	}
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootTurnID(
	adapterSession *claudeSDKAdapterSession,
	fallback string,
) string {
	if a == nil || adapterSession == nil {
		return strings.TrimSpace(fallback)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if rootTurnID := strings.TrimSpace(adapterSession.rootTurnID); rootTurnID != "" {
		return rootTurnID
	}
	adapterSession.rootTurnID = strings.TrimSpace(fallback)
	return adapterSession.rootTurnID
}

func (a *ClaudeCodeSDKAdapter) rememberClaudeSDKRootProviderTurn(
	adapterSession *claudeSDKAdapterSession,
	providerTurnID string,
) {
	if a == nil || adapterSession == nil || strings.TrimSpace(providerTurnID) == "" {
		return
	}
	a.mu.Lock()
	if adapterSession.rootProviderTurns == nil {
		adapterSession.rootProviderTurns = make(map[string]struct{})
	}
	adapterSession.rootProviderTurns[strings.TrimSpace(providerTurnID)] = struct{}{}
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) activeClaudeSDKRootProviderTurnID(
	adapterSession *claudeSDKAdapterSession,
) string {
	if a == nil || adapterSession == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(adapterSession.rootProviderTurns) != 1 {
		return ""
	}
	for providerTurnID := range adapterSession.rootProviderTurns {
		return strings.TrimSpace(providerTurnID)
	}
	return ""
}

func (a *ClaudeCodeSDKAdapter) consumeClaudeSDKRootProviderTurn(
	adapterSession *claudeSDKAdapterSession,
	providerTurnID string,
) bool {
	if a == nil || adapterSession == nil || strings.TrimSpace(providerTurnID) == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	providerTurnID = strings.TrimSpace(providerTurnID)
	if _, ok := adapterSession.rootProviderTurns[providerTurnID]; !ok {
		return false
	}
	delete(adapterSession.rootProviderTurns, providerTurnID)
	return true
}
