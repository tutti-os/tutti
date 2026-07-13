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
)

const WorkspaceAgentSessionOriginRuntime = "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"

var defaultReportRetryBackoff = []time.Duration{200 * time.Millisecond, 500 * time.Millisecond, time.Second}

type ActivityReporter interface {
	Report(context.Context, agentsessionstore.ReportActivityInput) error
}

type ActivityClient interface {
	ReportSessionState(context.Context, agentsessionstore.ReportSessionStateInput) (agentsessionstore.ReportSessionStateReply, error)
	ReportSessionMessages(context.Context, agentsessionstore.ReportSessionMessagesInput) (agentsessionstore.ReportSessionMessagesReply, error)
}

type Reporter struct {
	ClientProvider func() ActivityClient
	Logger         *slog.Logger
	MaxAttempts    int
	Backoff        []time.Duration
}

func (r Reporter) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if len(input.TimelineItems) == 0 && len(input.StatePatches) == 0 && len(input.MessageUpdates) == 0 {
		return nil
	}
	input.Source.SessionOrigin = agentsessionstore.WorkspaceAgentSessionOriginRuntime
	if input.Connector == nil && strings.TrimSpace(input.Source.Provider) != "" {
		input.Connector = &agentsessionstore.ConnectorInfo{
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
	return nil
}

func reportActivityInput(session Session, events []activityshared.Event) agentsessionstore.ReportActivityInput {
	activityEvents := ReportableActivityEvents(events)
	source := eventSourceFromSession(session)
	input := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source: source,
	}
	now := time.Now().UnixMilli()
	for _, event := range events {
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
		if shouldAppendVisibleFailure(events, event) {
			if update, ok := visibleFailureMessageUpdate(source, event, sessionID, timestamp); ok {
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
