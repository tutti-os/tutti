package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// DurablyReportSubmitProvenance waits until the exact client submit can be
// queried from durable storage. Callers must invoke it only after Exec has
// returned, because Exec owns the per-session lifecycle lock while dispatching
// to the provider. The report remains queued when the caller context is
// canceled: provider work may already be running, so losing provenance would
// make a safe retry impossible.
func (c *Controller) DurablyReportSubmitProvenance(ctx context.Context, input SubmitProvenanceInput) error {
	if c == nil || c.reporter == nil {
		return errors.New("agent session activity reporter is unavailable")
	}
	input.RoomID = strings.TrimSpace(input.RoomID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if input.RoomID == "" || input.AgentSessionID == "" || input.TurnID == "" || input.ClientSubmitID == "" {
		return errors.New("workspace id, agent session id, turn id, and client submit id are required")
	}
	session, ok := c.get(input.RoomID, input.AgentSessionID)
	if !ok {
		return ErrSessionNotFound
	}
	content := normalizeRuntimePromptContent(input.Content)
	if len(content) == 0 {
		return errors.New("submit provenance prompt is required")
	}

	messageID := userPromptActivityMessageIDFromClientSubmitID(input.ClientSubmitID)
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, input.DisplayPrompt)
	message := newTurnActivityEventWithID(
		session,
		messageID,
		EventMessage,
		input.TurnID,
		"",
		RoleUser,
		visibleText,
		userPromptActivityPayload(content, explicitDisplayPrompt, map[string]any{
			"clientSubmitId": input.ClientSubmitID,
			"messageId":      messageID,
		}),
	)
	// Do not replay a submitted lifecycle patch here. The original submitted
	// report is ahead of this barrier in the same FIFO; this atomic write then
	// requires that exact turn to exist. A fast provider may already have moved
	// it to running or settled, which this barrier must never regress.
	report := reportActivityInput(session, []activityshared.Event{message})
	c.enrichReportWithSessionSnapshot(session, &report)
	if len(report.StatePatches) != 1 || len(report.MessageUpdates) != 1 {
		return fmt.Errorf(
			"build atomic submit provenance: got %d state patches and %d message updates",
			len(report.StatePatches),
			len(report.MessageUpdates),
		)
	}
	if update := report.MessageUpdates[0]; strings.TrimSpace(update.MessageID) != messageID ||
		strings.TrimSpace(update.TurnID) != input.TurnID ||
		strings.TrimSpace(payloadString(update.Payload, "clientSubmitId")) != input.ClientSubmitID {
		return errors.New("build atomic submit provenance: canonical message identity was not preserved")
	}

	done := make(chan error, 1)
	request := reportRequest{
		ctx:              context.WithoutCancel(ctx),
		report:           report,
		submitProvenance: true,
		done:             done,
	}
	if c.reportQueue == nil {
		return c.report(request.ctx, request)
	}
	c.reportQueue.enqueue(request)
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
