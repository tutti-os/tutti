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
	key := sessionKey(input.RoomID, input.AgentSessionID)
	c.mu.Lock()
	publicationPending := c.sessionPublicationPendingLocked(key)
	c.mu.Unlock()
	if publicationPending {
		// A nonstandard caller may still be inside the provisional window when
		// this late provenance arrives. Keep it hidden until the submitted-intent
		// barrier publishes the canonical prompt; normal initial-content creates
		// have already crossed that barrier before Exec returns.
		session.Visible = false
	}
	if session.IsSideConversation() {
		return ErrSideConversationUnsupported
	}
	canonicalSubmit, err := newCanonicalSubmitFact(
		input.ClientSubmitID,
		input.CanonicalSubmitOccurredAtUnixMS,
	)
	if err != nil {
		return err
	}
	content := normalizeRuntimePromptContent(input.Content)
	if len(content) == 0 {
		return errors.New("submit provenance prompt is required")
	}

	messageID := userPromptActivityMessageIDFromClientSubmitID(input.ClientSubmitID)
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, input.DisplayPrompt)
	message := newUserPromptActivityEventWithFact(
		session,
		content,
		explicitDisplayPrompt,
		visibleText,
		input.TurnID,
		canonicalSubmit,
		nil,
	)
	// Do not replay a submitted lifecycle patch here. Exec durably committed
	// that patch before provider dispatch. The adapter's user-message report may
	// race this barrier, so both paths reconstruct it from the same canonical
	// submit occurrence. This atomic write requires the exact turn to exist
	// without regressing a fast provider that already moved it onward.
	report := reportActivityInput(session, []activityshared.Event{message})
	c.enrichReportWithSessionSnapshot(session, &report)
	if publicationPending {
		hideProvisionalSessionReport(&report)
	}
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
