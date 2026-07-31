package agentruntime

import (
	"encoding/json"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) claudeSDKRootProviderTurnStartedEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	metadata map[string]any,
) activityshared.Event {
	ctx, ok := activityEventContext(
		session,
		"claude-sdk:provider-turn-started:"+providerTurnID,
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
	}
	a.mu.Unlock()
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
