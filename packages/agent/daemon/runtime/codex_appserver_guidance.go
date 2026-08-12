package agentruntime

import (
	"context"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) newGuidanceContinuation(
	session Session,
	turnID string,
) (activityshared.Event, *codexGuidanceContinuationAdmission, error) {
	attemptID := "continuation:" + newID()
	eventContext, ok := activityEventContext(session, "root-provider-turn-started:"+attemptID, turnID)
	if !ok {
		return activityshared.Event{}, nil, ErrSessionDisconnected
	}
	started := activityshared.NewRootProviderTurnStarted(eventContext, turnID, attemptID)
	if binding, err := a.WriteProviderTurnBinding(ProviderTurnBindingWriteInput{
		Kind:           ProviderTurnBindingWriteStarted,
		ProviderTurnID: attemptID,
	}); err == nil {
		started.Payload.ProviderTurnBindingJSON = binding
	}
	started.Payload.Metadata = map[string]any{"guidanceContinuation": true}
	return started, newCodexGuidanceContinuationAdmission(attemptID), nil
}

func (a *CodexAppServerAdapter) startGuidanceContinuation(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	started, continuation, err := a.newGuidanceContinuation(session, turnID)
	if err != nil {
		return nil, err
	}
	if err := a.execAsync(
		context.WithoutCancel(ctx), session, content, displayPrompt, turnID,
		emit, emitCommands, continuation,
	); err != nil {
		return nil, err
	}
	if err := <-continuation.admitted; err != nil {
		return nil, err
	}
	if emit != nil {
		emit([]activityshared.Event{started})
	}
	close(continuation.provisionalStarted)
	return []activityshared.Event{started}, nil
}
