package agentruntime

import (
	"context"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) enqueueSessionReport(ctx context.Context, session Session, events []activityshared.Event) {
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionSnapshot(session, &report)
	c.enqueueReport(ctx, report)
}

func (c *Controller) enqueueSessionSnapshotReport(ctx context.Context, session Session) {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source: eventSourceFromSession(session),
	}
	c.enrichReportWithSessionSnapshot(session, &report)
	c.enqueueReport(ctx, report)
}

func (c *Controller) enqueueSessionStatePatchReport(
	ctx context.Context,
	session Session,
	patch agentsessionstore.WorkspaceAgentStatePatch,
) {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &agentsessionstore.ConnectorInfo{
			ID:      session.Provider,
			Version: "agent-gui-runtime",
		},
		Source:       eventSourceFromSession(session),
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{patch},
	}
	c.enqueueReport(ctx, report)
}

func (c *Controller) enrichReportWithSessionSnapshot(session Session, report *agentsessionstore.ReportActivityInput) {
	if report == nil {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	patch := statePatchFromSessionStateSnapshot(snapshot)
	if len(report.StatePatches) == 0 {
		report.StatePatches = append(report.StatePatches, patch)
		return
	}
	enrichReportStatePatches(report, patch)
}

func (c *Controller) enrichReportStatePatchesWithSessionSnapshot(
	session Session,
	report *agentsessionstore.ReportActivityInput,
) {
	if report == nil || len(report.StatePatches) == 0 {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	enrichReportStatePatches(report, statePatchFromSessionStateSnapshot(snapshot))
}

func (c *Controller) enrichStreamStateEventsWithSessionSnapshot(
	session Session,
	events []StreamEvent,
) {
	if c == nil || len(events) == 0 {
		return
	}
	snapshot := c.sessionStateSnapshot(session)
	if snapshot.AgentSessionID == "" {
		return
	}
	snapshotPatch := statePatchFromSessionStateSnapshot(snapshot)
	for index := range events {
		if events[index].EventType != StreamEventStatePatch {
			continue
		}
		patch, ok := events[index].Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if !ok {
			continue
		}
		tmp := agentsessionstore.ReportActivityInput{
			StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{patch},
		}
		enrichReportStatePatches(&tmp, snapshotPatch)
		events[index].Data = tmp.StatePatches[0]
	}
}

func enrichReportStatePatches(
	report *agentsessionstore.ReportActivityInput,
	patch agentsessionstore.WorkspaceAgentStatePatch,
) {
	if report == nil {
		return
	}
	for index := range report.StatePatches {
		report.StatePatches[index].Settings = clonePayload(patch.Settings)
		report.StatePatches[index].RuntimeContext = clonePayload(patch.RuntimeContext)
		report.StatePatches[index].TurnLifecycle = cloneTurnLifecycle(patch.TurnLifecycle)
		report.StatePatches[index].SubmitAvailability = cloneSubmitAvailability(patch.SubmitAvailability)
		report.StatePatches[index].PendingInteractive = cloneInteractivePrompt(patch.PendingInteractive)
		report.StatePatches[index].PendingInteractivePresent = patch.PendingInteractivePresent
		if report.StatePatches[index].Provider == "" {
			report.StatePatches[index].Provider = patch.Provider
		}
		if report.StatePatches[index].ProviderSessionID == "" {
			report.StatePatches[index].ProviderSessionID = patch.ProviderSessionID
		}
		if report.StatePatches[index].Model == "" {
			report.StatePatches[index].Model = patch.Model
		}
		if report.StatePatches[index].PermissionModeID == "" {
			report.StatePatches[index].PermissionModeID = patch.PermissionModeID
		}
		if report.StatePatches[index].CWD == "" {
			report.StatePatches[index].CWD = patch.CWD
		}
		if report.StatePatches[index].Title == "" {
			report.StatePatches[index].Title = patch.Title
		}
	}
}

func (c *Controller) enqueueReport(ctx context.Context, report agentsessionstore.ReportActivityInput) {
	if len(report.TimelineItems) == 0 && len(report.StatePatches) == 0 && len(report.MessageUpdates) == 0 {
		return
	}
	if c.reporter == nil {
		return
	}
	request := reportRequest{
		ctx:    context.WithoutCancel(ctx),
		report: report,
	}
	timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(report)
	slog.Debug(
		"agent session activity report enqueued",
		"event", "agent_session.activity_report.enqueued",
		"room_id", report.WorkspaceID,
		"agent_session_id", report.Source.AgentID,
		"provider", report.Source.Provider,
		"provider_session_id", report.Source.ProviderSessionID,
		"timeline_item_count", len(report.TimelineItems),
		"state_patch_count", len(report.StatePatches),
		"message_update_count", len(report.MessageUpdates),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
	)
	if c.reportCh == nil {
		c.report(request.ctx, request)
		return
	}
	select {
	case c.reportCh <- request:
	default:
		slog.Warn(
			"agent session activity report queue full; reporting inline",
			"event", "agent_session.activity_report.queue_full",
			"room_id", report.WorkspaceID,
			"agent_session_id", report.Source.AgentID,
			"provider", report.Source.Provider,
			"provider_session_id", report.Source.ProviderSessionID,
			"timeline_item_count", len(report.TimelineItems),
			"state_patch_count", len(report.StatePatches),
			"message_update_count", len(report.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
		)
		c.report(request.ctx, request)
	}
}

func (c *Controller) runReportWorker() {
	coalescer := newStreamingReportCoalescer(defaultStreamingReportCoalesceWindow)
	defer coalescer.stop()
	for {
		select {
		case request, ok := <-c.reportCh:
			if !ok {
				for _, pending := range coalescer.flushAll() {
					c.report(pending.ctx, pending)
				}
				return
			}
			for _, next := range coalescer.add(request) {
				c.report(next.ctx, next)
			}
		case <-coalescer.ready():
			for _, pending := range coalescer.flushAll() {
				c.report(pending.ctx, pending)
			}
		}
	}
}

func (c *Controller) report(ctx context.Context, request reportRequest) {
	if c.reporter == nil {
		return
	}
	if err := c.reporter.Report(ctx, request.report); err != nil {
		timelineItemsForLog, statePatchesForLog := SummarizeReportActivityInputForLog(request.report)
		slog.Error(
			"agent session activity report failed",
			"event", "agent_session.activity_report.controller_failed",
			"room_id", request.report.WorkspaceID,
			"agent_session_id", request.report.Source.AgentID,
			"provider", request.report.Source.Provider,
			"provider_session_id", request.report.Source.ProviderSessionID,
			"timeline_item_count", len(request.report.TimelineItems),
			"state_patch_count", len(request.report.StatePatches),
			"message_update_count", len(request.report.MessageUpdates),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
			"error", err,
		)
	}
}

func sessionKey(roomID, agentSessionID string) string {
	return roomID + "/" + agentSessionID
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func deriveSessionStatusFromEvents(events []activityshared.Event, fallback string) string {
	status := strings.TrimSpace(fallback)
	for _, event := range events {
		switch event.Type {
		case activityshared.EventSessionFailed, activityshared.EventTurnFailed:
			status = SessionStatusFailed
		case activityshared.EventSessionCompleted:
			status = SessionStatusCompleted
		case activityshared.EventTurnCompleted:
			if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
				status = SessionStatusCanceled
			} else {
				status = SessionStatusReady
			}
		case activityshared.EventTurnUpdated:
			if event.Payload.TurnPhase == string(activityshared.TurnPhaseWaitingApproval) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseWaitingInput) {
				status = SessionStatusWaiting
			} else if event.Payload.TurnPhase == string(activityshared.TurnPhaseWorking) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseRunning) ||
				event.Payload.TurnPhase == string(activityshared.TurnPhaseSubmitted) {
				status = SessionStatusWorking
			}
		case activityshared.EventSessionUpdated:
			if next := sessionStatusFromActivity(event.Payload.EffectiveStatus); next != "" {
				status = next
			}
		case activityshared.EventTurnStarted:
			status = SessionStatusWorking
		}
	}
	return firstNonEmpty(status, SessionStatusReady)
}

func normalizeSessionStatus(status string) string {
	switch strings.TrimSpace(status) {
	case SessionStatusReady:
		return SessionStatusReady
	case SessionStatusWorking:
		return SessionStatusWorking
	case SessionStatusWaiting:
		return SessionStatusWaiting
	case SessionStatusCanceled:
		return SessionStatusCanceled
	case SessionStatusFailed:
		return SessionStatusFailed
	case SessionStatusCompleted:
		return SessionStatusCompleted
	default:
		return ""
	}
}
