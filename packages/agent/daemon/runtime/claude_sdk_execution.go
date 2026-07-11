package agentruntime

import (
	"context"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (*ClaudeCodeSDKAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	if !promptContentHasImage(content) {
		return nil
	}
	for _, block := range content {
		if strings.TrimSpace(block.Type) != "image" {
			continue
		}
		if !runtimePromptImageMimeTypeSupported(strings.TrimSpace(block.MimeType)) ||
			(strings.TrimSpace(block.Data) == "" && strings.TrimSpace(block.AttachmentID) == "") {
			return ErrPromptImageUnsupported
		}
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	events := make([]activityshared.Event, 0, 4)
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}
	startEvents := make([]activityshared.Event, 0, 3)
	if fallbackTitle := fallbackAgentSessionTitle(session.Title, visibleText, "", ProviderClaudeCode); fallbackTitle != "" {
		startEvents = append(startEvents, newSessionTitleActivityEvent(session, fallbackTitle))
		session.Title = fallbackTitle
	}
	startEvents = append(startEvents,
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
	)
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		startEvents = append(startEvents, event)
	}
	emitEvents(a.stampTurnLifecycleSnapshots(adapterSession, startEvents))

	waiter := a.registerClaudeSDKTurn(adapterSession, turnID, emit)
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, err
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "exec",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"turnId":         turnID,
			"prompt":         promptTextForClaudeSDK(content, visibleText),
			"content":        promptContentForClaudeSDK(content, visibleText),
		},
	}); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, err
	}

	select {
	case result := <-waiter.done:
		if len(result.events) > 0 {
			events = append(events, result.events...)
		}
		return events, result.err
	case <-ctx.Done():
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, ctx.Err()
	}
}

func (a *ClaudeCodeSDKAdapter) GuideActiveTurn(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter":  claudeSDKSidecarAdapterName,
			"guidance": true,
			"steered":  true,
		}))),
	}
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		return events, err
	}
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "guide",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"prompt":         promptTextForClaudeSDK(content, visibleText),
			"content":        promptContentForClaudeSDK(content, visibleText),
		},
	}); err != nil {
		return events, err
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (a *ClaudeCodeSDKAdapter) Cancel(_ context.Context, session Session, _ string) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, nil
	}
	_ = adapterSession.send(claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "cancel",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	})
	events := a.claudeSDKPendingRequestFailureEvents(adapterSession, session, "", errPermissionRequestCanceled)
	for _, turnID := range a.liveClaudeSDKTurnIDs(adapterSession) {
		if a.turnAlreadySettled(adapterSession, turnID) {
			continue
		}
		events = append(events, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
			"reason": "user",
		}))
	}
	return a.stampTurnLifecycleSnapshots(adapterSession, events), nil
}
