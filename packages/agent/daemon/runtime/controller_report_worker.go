package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (c *Controller) enqueueSessionReport(ctx context.Context, session Session, events []activityshared.Event) {
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionMetadata(session, &report)
	if len(report.GoalReconcileRequests) > 0 {
		control := report
		control.TimelineItems = nil
		control.StatePatches = nil
		control.MessageUpdates = nil
		control.SessionAudits = nil
		report.GoalReconcileRequests = nil
		_ = c.reportGoalReconcileControl(ctx, control)
	}
	c.enqueueReport(ctx, report)
}

// reportSubmittedTurnDurable is the acceptance barrier for a user submission.
// The daemon reporter commits the submitted Turn and its session pointer before
// Exec may publish the transition, start provider work, or return success.
func (c *Controller) reportSubmittedTurnDurable(ctx context.Context, session Session, events []activityshared.Event) error {
	if c == nil || c.reporter == nil {
		// Reporter-less controllers are used as standalone runtimes and have no
		// durable projection. The wired tuttid runtime always provides a reporter.
		return nil
	}
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionMetadata(session, &report)
	return c.reporter.Report(ctx, report)
}

func (c *Controller) reportGoalReconcileControl(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	if c == nil || c.reporter == nil {
		return errors.New("durable goal reconcile reporter is unavailable")
	}
	return c.reporter.Report(ctx, report)
}

func (c *Controller) reportGoalReconcileDurable(ctx context.Context, session Session, request GoalReconcileDurableRequest) error {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector:   &canonical.ConnectorInfo{ID: session.Provider, Version: "agent-gui-runtime"},
		Source:      eventSourceFromSession(session),
		GoalReconcileRequests: []agentsessionstore.WorkspaceAgentGoalReconcileRequest{{
			RequestID: request.RequestID, Phase: request.Phase, AgentSessionID: session.AgentSessionID,
			ProviderTurnID: request.ProviderTurnID, Reason: request.Reason, FenceMode: request.FenceMode,
			ExpectedOperationID: request.ExpectedOperationID, ExpectedRevision: request.ExpectedRevision,
			ExpectedRepairEpoch: request.ExpectedRepairEpoch, QuiesceSucceeded: request.QuiesceSucceeded,
			QuiesceError: request.QuiesceError,
		}},
	}
	return c.reportGoalReconcileControl(ctx, report)
}

func (c *Controller) enqueueSessionSnapshotReport(ctx context.Context, session Session) {
	report := agentsessionstore.ReportActivityInput{
		WorkspaceID: session.RoomID,
		Connector: &canonical.ConnectorInfo{
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
		Connector: &canonical.ConnectorInfo{
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
	enrichReportStatePatchesWithSessionMetadata(report, patch)
}

func (c *Controller) enrichReportStatePatchesWithSessionMetadata(
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
	enrichReportStatePatchesWithSessionMetadata(report, statePatchFromSessionStateSnapshot(snapshot))
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
		enrichReportStatePatchesWithSessionMetadata(&tmp, snapshotPatch)
		tmp.StatePatches[0].TurnLifecycle = cloneTurnLifecycle(snapshotPatch.TurnLifecycle)
		tmp.StatePatches[0].SubmitAvailability = cloneSubmitAvailability(snapshotPatch.SubmitAvailability)
		events[index].Data = tmp.StatePatches[0]
	}
}

// enrichReportStatePatchesWithSessionMetadata fills stable session metadata on
// persisted event reports. Canonical turn lifecycle is intentionally excluded:
// only an event's explicit Turn patch may advance a WorkspaceAgentTurn.
func enrichReportStatePatchesWithSessionMetadata(
	report *agentsessionstore.ReportActivityInput,
	patch agentsessionstore.WorkspaceAgentStatePatch,
) {
	if report == nil {
		return
	}
	for index := range report.StatePatches {
		if patch.AgentSessionID != "" &&
			report.StatePatches[index].AgentSessionID != "" &&
			strings.TrimSpace(report.StatePatches[index].AgentSessionID) != strings.TrimSpace(patch.AgentSessionID) {
			continue
		}
		report.StatePatches[index].Settings = clonePayload(patch.Settings)
		report.StatePatches[index].RuntimeContext = clonePayload(patch.RuntimeContext)
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
	if len(report.TimelineItems) == 0 && len(report.StatePatches) == 0 && len(report.MessageUpdates) == 0 && len(report.SessionAudits) == 0 && len(report.GoalReconcileRequests) == 0 {
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
		"session_audit_count", len(report.SessionAudits),
		"timeline_items", timelineItemsForLog,
		"state_patches", statePatchesForLog,
	)
	if c.reportQueue == nil {
		_ = c.report(request.ctx, request)
		return
	}
	depth := c.reportQueue.enqueue(request)
	if depth >= 1024 && depth%1024 == 0 {
		slog.Warn(
			"agent session activity report queue backlog is growing",
			"event", "agent_session.activity_report.queue_backlog",
			"room_id", report.WorkspaceID,
			"agent_session_id", report.Source.AgentID,
			"provider", report.Source.Provider,
			"provider_session_id", report.Source.ProviderSessionID,
			"queue_depth", depth,
			"timeline_item_count", len(report.TimelineItems),
			"state_patch_count", len(report.StatePatches),
			"message_update_count", len(report.MessageUpdates),
			"session_audit_count", len(report.SessionAudits),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
		)
	}
}

func (c *Controller) runReportWorker() {
	if c.reportQueue == nil {
		return
	}
	coalescer := newStreamingReportCoalescer(defaultStreamingReportCoalesceWindow)
	defer coalescer.stop()
	for {
		// Do not let a continuously populated report queue starve the streaming
		// coalescer's timer.
		select {
		case <-coalescer.ready():
			for _, pending := range coalescer.flushAll() {
				_ = c.report(pending.ctx, pending)
			}
		default:
		}
		if request, ok := c.reportQueue.dequeue(); ok {
			for _, next := range coalescer.add(request) {
				_ = c.report(next.ctx, next)
			}
			continue
		}
		select {
		case <-c.reportQueue.ready():
		case <-coalescer.ready():
			for _, pending := range coalescer.flushAll() {
				_ = c.report(pending.ctx, pending)
			}
		}
	}
}

func (c *Controller) report(ctx context.Context, request reportRequest) (reportErr error) {
	if request.done != nil {
		defer func() {
			request.done <- reportErr
			close(request.done)
		}()
	}
	if c.reporter == nil {
		return errors.New("agent session activity reporter is unavailable")
	}
	if request.submitProvenance {
		reportErr = c.reporter.ReportSubmitProvenance(ctx, request.report)
	} else {
		reportErr = c.reporter.Report(ctx, request.report)
	}
	if reportErr != nil {
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
			"session_audit_count", len(request.report.SessionAudits),
			"timeline_items", timelineItemsForLog,
			"state_patches", statePatchesForLog,
			"submit_provenance", request.submitProvenance,
			"error", reportErr,
		)
	}
	return reportErr
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
