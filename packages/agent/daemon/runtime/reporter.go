package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const WorkspaceAgentSessionOriginRuntime = "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"

var defaultReportRetryBackoff = []time.Duration{200 * time.Millisecond, 500 * time.Millisecond, time.Second}

type ActivityReporter interface {
	Report(context.Context, agentsessionstore.ReportActivityInput) error
}

// DurableActivityReporter is the required host boundary for runtime
// controllers. ReportSubmitProvenance must atomically persist the report's
// session/turn patch and canonical client-submit message before returning.
// Compatibility ActivityReporter implementations that split state and message
// persistence do not satisfy this contract and cannot host a controller.
type DurableActivityReporter interface {
	ActivityReporter
	ReportSubmitProvenance(context.Context, agentsessionstore.ReportActivityInput) error
}

type ActivityClient interface {
	ReportSessionState(context.Context, canonical.ReportSessionStateInput) (canonical.ReportSessionStateReply, error)
	ReportSessionMessages(context.Context, canonical.ReportSessionMessagesInput) (canonical.ReportSessionMessagesReply, error)
}

type goalProvenanceActivityClient interface {
	agentsessionstore.GoalProvenanceLedger
}

type Reporter struct {
	ClientProvider func() ActivityClient
	Logger         *slog.Logger
	MaxAttempts    int
	Backoff        []time.Duration
}

func (r Reporter) BindGoalProvenance(ctx context.Context, input agentsessionstore.BindGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, error) {
	if r.ClientProvider == nil {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent session activity client provider is nil")
	}
	client, ok := r.ClientProvider().(goalProvenanceActivityClient)
	if !ok || client == nil {
		return agentsessionstore.GoalProvenanceBinding{}, errors.New("agent session activity client does not support goal provenance")
	}
	return client.BindGoalProvenance(ctx, input)
}

func (r Reporter) LookupGoalProvenance(ctx context.Context, input agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error) {
	if r.ClientProvider == nil {
		return agentsessionstore.GoalProvenanceBinding{}, false, errors.New("agent session activity client provider is nil")
	}
	client, ok := r.ClientProvider().(goalProvenanceActivityClient)
	if !ok || client == nil {
		return agentsessionstore.GoalProvenanceBinding{}, false, errors.New("agent session activity client does not support goal provenance")
	}
	return client.LookupGoalProvenance(ctx, input)
}

func (r Reporter) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if len(input.TimelineItems) == 0 && len(input.StatePatches) == 0 && len(input.MessageUpdates) == 0 && len(input.SessionAudits) == 0 && len(input.GoalReconcileRequests) == 0 {
		return nil
	}
	input.Source.SessionOrigin = agentsessionstore.WorkspaceAgentSessionOriginRuntime
	if input.Connector == nil && strings.TrimSpace(input.Source.Provider) != "" {
		input.Connector = &canonical.ConnectorInfo{
			ID:      strings.TrimSpace(input.Source.Provider),
			Version: "agent-gui-runtime",
		}
	}
	if r.ClientProvider == nil {
		err := errors.New("agent session activity client provider is nil")
		r.logReportFailure(input, 1, 1, agentsessionstore.ReportActivityReply{}, err)
		return err
	}
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(input)
	r.logger().Debug(
		"agent session activity report prepared",
		"event", "agent_session.activity_report.prepared",
		"room_id", input.WorkspaceID,
		"agent_session_id", input.Source.AgentID,
		"provider", input.Source.Provider,
		"provider_session_id", input.Source.ProviderSessionID,
		"timeline_item_count", len(input.TimelineItems),
		"state_patch_count", len(input.StatePatches),
		"message_update_count", len(input.MessageUpdates),
		"session_audit_count", len(input.SessionAudits),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
	)

	maxAttempts := r.maxAttempts()
	var lastErr error
	var lastReply agentsessionstore.ReportActivityReply
	lastAttempt := 0
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		lastAttempt = attempt
		client := r.ClientProvider()
		if client == nil {
			lastErr = errors.New("agent session activity client is nil")
		} else {
			lastReply, lastErr = reportSessionActivity(ctx, client, input)
			if lastErr == nil {
				lastErr = validateReportActivityAccepted(input, lastReply)
			}
		}
		if lastErr == nil {
			if attempt > 1 {
				r.logger().Info(
					"agent session activity report succeeded after retry",
					"event", "agent_session.activity_report.succeeded_after_retry",
					"room_id", input.WorkspaceID,
					"agent_session_id", input.Source.AgentID,
					"provider", input.Source.Provider,
					"provider_session_id", input.Source.ProviderSessionID,
					"timeline_item_count", len(input.TimelineItems),
					"state_patch_count", len(input.StatePatches),
					"message_update_count", len(input.MessageUpdates),
					"timeline_items", timelineItemsForLog,
					"state_patches", statePatchesForLog,
					"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
					"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
					"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
					"attempt", attempt,
					"max_attempts", maxAttempts,
				)
			}
			r.logger().Debug(
				"agent session activity report succeeded",
				"event", "agent_session.activity_report.succeeded",
				"room_id", input.WorkspaceID,
				"agent_session_id", input.Source.AgentID,
				"provider", input.Source.Provider,
				"provider_session_id", input.Source.ProviderSessionID,
				"timeline_item_count", len(input.TimelineItems),
				"state_patch_count", len(input.StatePatches),
				"message_update_count", len(input.MessageUpdates),
				"timeline_items", timelineItemsForLog,
				"state_patches", statePatchesForLog,
				"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
				"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
				"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
				"attempt", attempt,
				"max_attempts", maxAttempts,
			)
			return nil
		}

		if attempt >= maxAttempts {
			break
		}
		r.logger().Warn(
			"agent session activity report failed; retrying",
			"event", "agent_session.activity_report.retry",
			"room_id", input.WorkspaceID,
			"agent_session_id", input.Source.AgentID,
			"provider", input.Source.Provider,
			"provider_session_id", input.Source.ProviderSessionID,
			"timeline_item_count", len(input.TimelineItems),
			"state_patch_count", len(input.StatePatches),
			"message_update_count", len(input.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
			"accepted_timeline_item_count", lastReply.AcceptedTimelineItemCount,
			"accepted_state_patch_count", lastReply.AcceptedStatePatchCount,
			"accepted_message_update_count", lastReply.AcceptedMessageUpdateCount,
			"attempt", attempt,
			"max_attempts", maxAttempts,
			"error", lastErr,
		)
		if err := sleepWithContext(ctx, r.backoffForAttempt(attempt)); err != nil {
			lastErr = fmt.Errorf("agent session activity report retry canceled after attempt %d: %w", attempt, err)
			break
		}
	}

	r.logReportFailure(input, lastAttempt, maxAttempts, lastReply, lastErr)
	return lastErr
}

func reportSessionActivity(
	ctx context.Context,
	client ActivityClient,
	input agentsessionstore.ReportActivityInput,
) (agentsessionstore.ReportActivityReply, error) {
	return agentsessionstore.ReportActivityAsSessionUpdates(ctx, client, input)
}

func validateReportActivityAccepted(input agentsessionstore.ReportActivityInput, reply agentsessionstore.ReportActivityReply) error {
	if reply.AcceptedStatePatchCount < len(input.StatePatches) {
		return fmt.Errorf("agent session activity report accepted %d/%d state patches", reply.AcceptedStatePatchCount, len(input.StatePatches))
	}
	if reply.AcceptedMessageUpdateCount < len(input.MessageUpdates) {
		return fmt.Errorf("agent session activity report accepted %d/%d message updates", reply.AcceptedMessageUpdateCount, len(input.MessageUpdates))
	}
	if reply.AcceptedSessionAuditCount < len(input.SessionAudits) {
		return fmt.Errorf("agent session activity report accepted %d/%d session audits", reply.AcceptedSessionAuditCount, len(input.SessionAudits))
	}
	if reply.AcceptedGoalReconcileRequestCount < len(input.GoalReconcileRequests) {
		return fmt.Errorf("agent session activity report accepted %d/%d goal reconcile requests", reply.AcceptedGoalReconcileRequestCount, len(input.GoalReconcileRequests))
	}
	return nil
}

func reportActivityInput(session Session, events []activityshared.Event) agentsessionstore.ReportActivityInput {
	activityEvents := ReportableActivityEvents(events)
	source := eventSourceFromSession(session)
	input := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &canonical.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source: source,
	}
	now := time.Now().UnixMilli()
	for _, event := range events {
		appendProviderObservation(&input, event)
		sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		if sessionID == "" {
			continue
		}
		timestamp := event.OccurredAtUnixMS
		if timestamp <= 0 {
			timestamp = now
		}
		if update, ok := messageUpdateFromSessionEvent(source, event, sessionID, timestamp); ok {
			input.MessageUpdates = append(input.MessageUpdates, update)
		}
		if audit, ok := sessionAuditUpdateFromSessionEvent(event, sessionID, timestamp); ok {
			input.SessionAudits = append(input.SessionAudits, audit)
		}
		if request, ok := goalReconcileRequestFromSessionEvent(event, sessionID); ok {
			input.GoalReconcileRequests = append(input.GoalReconcileRequests, request)
		}
		if shouldAppendVisibleFailure(events, event) {
			if audit, ok := visibleFailureSessionAuditUpdate(source, event, sessionID, timestamp); ok {
				input.SessionAudits = append(input.SessionAudits, audit)
			} else if update, ok := visibleFailureMessageUpdate(source, event, sessionID, timestamp); ok {
				input.MessageUpdates = append(input.MessageUpdates, update)
			}
		}
	}
	for _, event := range activityEvents {
		sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		if sessionID == "" {
			continue
		}
		timestamp := event.OccurredAtUnixMS
		if timestamp <= 0 {
			timestamp = now
		}
		if patch, ok := statePatchFromSessionEvent(source, event, sessionID, timestamp); ok {
			input.StatePatches = append(input.StatePatches, patch)
		}
	}
	return input
}

func appendProviderObservation(
	input *agentsessionstore.ReportActivityInput,
	event activityshared.Event,
) {
	position := event.ProviderInputUnit
	if input == nil || position == nil || position.ConnectionID == "" ||
		position.ChunkSeq == 0 || position.UnitIndex == 0 ||
		position.EventIndex == 0 || !checkpointObservationEvent(event) {
		return
	}
	batchIndex := -1
	for index := range input.ProviderObservations {
		candidate := input.ProviderObservations[index]
		if candidate.RecordingID == position.RecordingID &&
			candidate.ConnectionID == position.ConnectionID &&
			candidate.ChunkSeq == position.ChunkSeq &&
			candidate.UnitIndex == position.UnitIndex {
			batchIndex = index
			break
		}
	}
	if batchIndex < 0 {
		input.ProviderObservations = append(
			input.ProviderObservations,
			replay.ProviderObservationBatch{
				RecordingID:  position.RecordingID,
				ConnectionID: position.ConnectionID,
				ChunkSeq:     position.ChunkSeq,
				UnitIndex:    position.UnitIndex,
				UnitKind:     position.UnitKind,
			},
		)
		batchIndex = len(input.ProviderObservations) - 1
	}
	interactionID := ""
	interactionKind := ""
	if interaction := event.Payload.Interaction; interaction != nil {
		interactionID = strings.TrimSpace(interaction.RequestID)
		interactionKind = strings.TrimSpace(interaction.Kind)
	}
	observationType := string(event.Type)
	messageKind, _ := event.Payload.Metadata["messageKind"].(string)
	if isMessageActivityEvent(event.Type) &&
		strings.TrimSpace(messageKind) == "plan" {
		observationType = "plan.proposed"
	}
	messageID := strings.TrimSpace(payloadString(
		event.Payload.Metadata,
		"messageId",
	))
	if messageID == "" {
		messageID = strings.TrimSpace(event.EventID)
	}
	messageStatus := strings.TrimSpace(payloadString(
		event.Payload.Metadata,
		"streamState",
	))
	noticeCommand := strings.TrimSpace(payloadString(
		event.Payload.Metadata,
		"noticeCommand",
	))
	noticeCommandStatus := strings.TrimSpace(payloadString(
		event.Payload.Metadata,
		"noticeCommandStatus",
	))
	attachmentCount := uint64(0)
	for _, block := range payloadArray(event.Payload.Metadata["content"]) {
		if strings.TrimSpace(payloadString(block, "attachmentId")) != "" {
			attachmentCount++
		}
	}
	if noticeCommand == "compact" {
		observationType = "compaction.updated"
	} else if attachmentCount > 0 {
		observationType = "attachment.materialized"
	}
	input.ProviderObservations[batchIndex].Events = append(
		input.ProviderObservations[batchIndex].Events,
		replay.ProviderObservationEvent{
			EventIndex:         position.EventIndex,
			Type:               observationType,
			AgentSessionID:     strings.TrimSpace(event.AgentSessionID),
			SessionKind:        strings.TrimSpace(event.SessionKind),
			RootAgentSessionID: strings.TrimSpace(event.RootAgentSessionID),
			RootTurnID:         strings.TrimSpace(event.RootTurnID),
			ParentAgentSessionID: strings.TrimSpace(
				event.ParentAgentSessionID,
			),
			ParentTurnID: strings.TrimSpace(event.ParentTurnID),
			ParentToolCallID: strings.TrimSpace(
				event.ParentToolCallID,
			),
			TurnID:              strings.TrimSpace(event.Payload.TurnID),
			MessageID:           messageID,
			MessageKind:         strings.TrimSpace(messageKind),
			NoticeCommand:       noticeCommand,
			NoticeCommandStatus: noticeCommandStatus,
			AttachmentCount:     attachmentCount,
			CallID:              strings.TrimSpace(event.Payload.CallID),
			InteractionID:       interactionID,
			InteractionKind:     interactionKind,
			TurnPhase:           strings.TrimSpace(event.Payload.TurnPhase),
			TurnOutcome:         strings.TrimSpace(event.Payload.TurnOutcome),
			Status: firstNonEmptyString(
				event.Payload.Status,
				messageStatus,
			),
		},
	)
}

func checkpointObservationEvent(event activityshared.Event) bool {
	if isMessageActivityEvent(event.Type) {
		messageKind, _ := event.Payload.Metadata["messageKind"].(string)
		return strings.TrimSpace(messageKind) == "plan" ||
			strings.TrimSpace(payloadString(
				event.Payload.Metadata,
				"noticeCommand",
			)) == "compact" ||
			providerObservationAttachmentCount(event) > 0
	}
	switch event.Type {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventRootProviderTurnStarted,
		activityshared.EventRootProviderTurnCompleted,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed,
		activityshared.EventTurnCanceled,
		activityshared.EventCallCompleted,
		activityshared.EventCallFailed,
		activityshared.EventInteractionRequested,
		activityshared.EventInteractionSuperseded:
		return true
	case activityshared.EventCallStarted:
		// commandExecution/outputDelta reuses call.started for live tool
		// output. Claude tool_updated likewise reuses call.started for input
		// /progress streaming. Those frames must not mint another tool.started
		// checkpoint (no matching commit → checkpoint_commit_unconfirmed).
		if event.Payload.Metadata != nil {
			if _, ok := event.Payload.Metadata[liveToolOutputOperationMetadataKey]; ok {
				return false
			}
			if _, ok := event.Payload.Metadata[liveToolProgressMetadataKey]; ok {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func providerObservationAttachmentCount(event activityshared.Event) uint64 {
	var count uint64
	for _, block := range payloadArray(event.Payload.Metadata["content"]) {
		if strings.TrimSpace(payloadString(block, "attachmentId")) != "" {
			count++
		}
	}
	return count
}

func isMessageActivityEvent(eventType activityshared.EventType) bool {
	return eventType == activityshared.EventMessageAppended ||
		eventType == activityshared.EventMessageCreated
}

func (r Reporter) maxAttempts() int {
	if r.MaxAttempts > 0 {
		return r.MaxAttempts
	}
	return 3
}

func (r Reporter) backoffForAttempt(attempt int) time.Duration {
	index := attempt - 1
	if index >= 0 && index < len(r.Backoff) {
		return r.Backoff[index]
	}
	if index >= 0 && index < len(defaultReportRetryBackoff) {
		return defaultReportRetryBackoff[index]
	}
	return defaultReportRetryBackoff[len(defaultReportRetryBackoff)-1]
}

func (r Reporter) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func (r Reporter) logReportFailure(input agentsessionstore.ReportActivityInput, attempt int, maxAttempts int, reply agentsessionstore.ReportActivityReply, err error) {
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(input)
	r.logger().Error(
		"agent session activity report failed after retries",
		"event", "agent_session.activity_report.failed",
		"room_id", input.WorkspaceID,
		"agent_session_id", input.Source.AgentID,
		"provider", input.Source.Provider,
		"provider_session_id", input.Source.ProviderSessionID,
		"timeline_item_count", len(input.TimelineItems),
		"state_patch_count", len(input.StatePatches),
		"message_update_count", len(input.MessageUpdates),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
		"accepted_timeline_item_count", reply.AcceptedTimelineItemCount,
		"accepted_state_patch_count", reply.AcceptedStatePatchCount,
		"accepted_message_update_count", reply.AcceptedMessageUpdateCount,
		"attempt", attempt,
		"max_attempts", maxAttempts,
		"error", err,
	)
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
