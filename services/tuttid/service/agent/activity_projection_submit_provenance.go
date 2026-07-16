package agent

import (
	"context"
	"fmt"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// ReportSubmitProvenance is a deliberately narrower contract than Report.
// It commits the canonical client-submit message together with the session and
// optional new-turn patch in one repository transaction. The ordinary Report
// compatibility path persists state and messages separately and therefore
// cannot acknowledge provider dispatch safely.
func (p *ActivityProjection) ReportSubmitProvenance(
	ctx context.Context,
	input agentsessionstore.ReportActivityInput,
) error {
	if p == nil || p.repo == nil {
		return fmt.Errorf("agent activity repository is unavailable")
	}
	sourceOrigin := agentsessionstore.NormalizeSessionOrigin(input.Source.SessionOrigin)
	if sourceOrigin == "" {
		return ErrInvalidArgument
	}
	input.Source.SessionOrigin = sourceOrigin
	stateInputs := agentsessionstore.SessionStateInputsFromActivity(input)
	messageInputs, err := agentsessionstore.SessionMessageInputsFromActivity(input)
	if err != nil {
		return err
	}
	if len(stateInputs) != 1 || len(messageInputs) != 1 || len(messageInputs[0].Updates) != 1 {
		return fmt.Errorf(
			"atomic submit provenance requires one state patch and one message update; got %d state batches, %d message batches",
			len(stateInputs),
			len(messageInputs),
		)
	}
	stateInput := stateInputs[0]
	messageInput := messageInputs[0]
	if strings.TrimSpace(stateInput.WorkspaceID) != strings.TrimSpace(messageInput.WorkspaceID) ||
		strings.TrimSpace(stateInput.AgentSessionID) != strings.TrimSpace(messageInput.AgentSessionID) {
		return fmt.Errorf("atomic submit provenance state and message scopes do not match")
	}
	sessionOrigin, source, err := normalizeReportSessionOrigins(stateInput.SessionOrigin, stateInput.Source)
	if err != nil {
		return err
	}
	stateInput.SessionOrigin = sessionOrigin
	stateInput.Source = source
	messageInput.SessionOrigin = sessionOrigin
	messageInput.Source = source
	update := messageInput.Updates[0]
	clientSubmitID, _ := update.Payload["clientSubmitId"].(string)
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if strings.TrimSpace(update.MessageID) == "" || strings.TrimSpace(update.TurnID) == "" || clientSubmitID == "" {
		return fmt.Errorf("atomic submit provenance requires message id, turn id, and client submit id")
	}

	activityReport, canonicalTargetID, err := p.activityStateReport(ctx, stateInput)
	if err != nil {
		return err
	}
	if activityReport.Turn != nil && strings.TrimSpace(activityReport.Turn.TurnID) != strings.TrimSpace(update.TurnID) {
		return fmt.Errorf("atomic submit provenance turn patch and message turn do not match")
	}
	activityReport.Messages = activityMessageUpdates(messageInput.Updates)
	result, err := p.repo.ReportActivityState(ctx, activityReport)
	if err != nil {
		return err
	}
	if !result.State.Accepted || result.Messages.AcceptedCount != 1 || len(result.Messages.Messages) != 1 {
		return fmt.Errorf(
			"atomic submit provenance was not fully accepted: state=%t messages=%d",
			result.State.Accepted,
			result.Messages.AcceptedCount,
		)
	}
	message := result.Messages.Messages[0]
	if strings.TrimSpace(message.TurnID) != strings.TrimSpace(update.TurnID) ||
		strings.TrimSpace(payloadString(message.Payload, "clientSubmitId")) != clientSubmitID {
		return fmt.Errorf("atomic submit provenance did not preserve canonical message identity")
	}

	stateReply := agentsessionstore.ReportSessionStateReply{
		Accepted:          result.State.Accepted,
		StateApplied:      result.State.StateApplied,
		LastEventAtUnixMS: result.State.LastEventUnixMS,
		RequestBodyBytes:  result.State.RequestBodyBytes,
	}
	p.publishPersistedTurnState(ctx, stateInput, result)
	p.publishActivityUpdated(
		ctx,
		stateInput.WorkspaceID,
		stateInput.AgentSessionID,
		"session_reconcile_required",
		activitySessionUpdateEventPayload(
			stateInput.WorkspaceID,
			stateInput.AgentSessionID,
			result.State.LastEventUnixMS,
			canonicalTargetID,
		),
	)
	p.observeSessionState(ctx, stateInput, stateReply)

	publishedAgentSessionID := canonicalMessageUpdateSessionID(messageInput.AgentSessionID, result.Messages.Messages)
	p.publishActivityUpdated(ctx, messageInput.WorkspaceID, publishedAgentSessionID, "message_update", map[string]any{
		"acceptedCount":  result.Messages.AcceptedCount,
		"agentSessionId": publishedAgentSessionID,
		"eventType":      "message_update",
		"latestVersion":  result.Messages.LatestVersion,
		"messages":       activityMessagesEventPayload(result.Messages.Messages),
		"workspaceId":    strings.TrimSpace(messageInput.WorkspaceID),
	})
	p.observeSessionMessages(ctx, messageInput, agentsessionstore.ReportSessionMessagesReply{
		AcceptedCount: result.Messages.AcceptedCount,
		LatestVersion: result.Messages.LatestVersion,
	})
	return nil
}

func (p *ActivityProjection) activityStateReport(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
) (agentactivitybiz.ActivityStateReport, string, error) {
	canonicalTargetID, runtimeContext := p.canonicalizeAgentTargetID(
		ctx,
		input.WorkspaceID,
		firstNonEmptyString(input.State.AgentTargetID, input.Source.AgentTargetID),
		input.State.RuntimeContext,
	)
	stateReport := agentactivitybiz.SessionStateReport{
		WorkspaceID:          strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:       strings.TrimSpace(input.AgentSessionID),
		Kind:                 strings.TrimSpace(input.State.Kind),
		RootAgentSessionID:   strings.TrimSpace(input.State.RootAgentSessionID),
		RootTurnID:           strings.TrimSpace(input.State.RootTurnID),
		ParentAgentSessionID: strings.TrimSpace(input.State.ParentAgentSessionID),
		ParentTurnID:         strings.TrimSpace(input.State.ParentTurnID),
		ParentToolCallID:     strings.TrimSpace(input.State.ParentToolCallID),
		Origin:               strings.TrimSpace(input.SessionOrigin),
		UserID:               strings.TrimSpace(input.Source.UserID),
		AgentTargetID:        canonicalTargetID,
		Provider:             strings.TrimSpace(firstNonEmptyString(input.State.Provider, input.Source.Provider)),
		ProviderSessionID:    strings.TrimSpace(firstNonEmptyString(input.State.ProviderSessionID, input.Source.ProviderSessionID)),
		Model:                strings.TrimSpace(input.State.Model),
		Settings:             clonePayload(input.State.Settings),
		RuntimeContext:       clonePayload(runtimeContext),
		Cwd:                  strings.TrimSpace(input.State.CWD),
		Title:                strings.TrimSpace(sessionStateTitle(input.State)),
		Status:               strings.TrimSpace(input.State.LifecycleStatus),
		CurrentPhase:         strings.TrimSpace(input.State.CurrentPhase),
		LastError:            strings.TrimSpace(input.State.LastError),
		OccurredAtUnixMS:     input.State.OccurredAtUnixMS,
		StartedAtUnixMS:      input.State.StartedAtUnixMS,
		EndedAtUnixMS:        input.State.EndedAtUnixMS,
		CreatedAtUnixMS:      input.Source.SessionCreatedAtUnixMS,
	}
	activityReport := agentactivitybiz.ActivityStateReport{Session: stateReport}
	if transition, ok := turnTransitionFromStateInput(input); ok {
		activityReport.Turn = &transition
	}
	if transition, ok := rootProviderTurnTransitionFromStateInput(input); ok {
		activityReport.RootProviderTurn = &transition
	}
	interaction, err := interactionTransitionFromStateInput(input)
	if err != nil {
		return agentactivitybiz.ActivityStateReport{}, "", err
	}
	activityReport.Interaction = interaction
	return activityReport, canonicalTargetID, nil
}
