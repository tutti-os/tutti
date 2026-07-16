package agent

import (
	"context"
	"fmt"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
		strings.TrimSpace(payloadText(message.Payload, "clientSubmitId")) != clientSubmitID {
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
