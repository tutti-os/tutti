package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (c *Controller) enqueueSessionReport(ctx context.Context, session Session, events []activityshared.Event) {
	if session.IsSideConversation() {
		return
	}
	c.enqueueSessionReportWithInitializationState(ctx, session, events, false)
}

// enqueueInitializedSessionReport publishes the release batch after Host has
// already committed the canonical Session. The Controller intentionally keeps
// its in-memory publication marker until all queued runtime callbacks are
// drained, so this path must not mistake that ordering marker for an
// uninitialized canonical Session and hide the report again.
func (c *Controller) enqueueInitializedSessionReport(ctx context.Context, session Session, events []activityshared.Event) {
	c.enqueueSessionReportWithInitializationState(ctx, session, events, true)
}

func (c *Controller) enqueueSessionReportWithInitializationState(
	ctx context.Context,
	session Session,
	events []activityshared.Event,
	canonicalInitialized bool,
) {
	if session.IsSideConversation() {
		return
	}
	c.observeGoalControlLifecycle(ctx, session, events)
	report := c.prepareSessionReportWithInitializationState(session, events, canonicalInitialized)
	c.observeProviderObservations(ctx, session, report.ProviderObservations)
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

func (c *Controller) prepareSessionReport(
	session Session,
	events []activityshared.Event,
) agentsessionstore.ReportActivityInput {
	return c.prepareSessionReportWithInitializationState(session, events, false)
}

func (c *Controller) prepareSessionReportWithInitializationState(
	session Session,
	events []activityshared.Event,
	canonicalInitialized bool,
) agentsessionstore.ReportActivityInput {
	c.mu.Lock()
	publicationPending := !canonicalInitialized && c.sessionPublicationPendingLocked(sessionKey(session.RoomID, session.AgentSessionID))
	c.mu.Unlock()
	if publicationPending {
		// A still-provisional runtime has not crossed the durable submitted-intent
		// barrier. Keep incidental provider events hidden until that barrier
		// publishes the canonical prompt. The normal initial-content path removes
		// this marker immediately after the barrier, so an explicit rejection is
		// projected as a visible failed Turn rather than compensated away.
		session.Visible = false
	}
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionMetadata(session, &report)
	if publicationPending {
		hideProvisionalSessionReport(&report)
		report.MessageUpdates = nil
		report.SessionAudits = nil
	}
	return report
}

// reportSessionBeforePublish establishes the commit-before-publish barrier
// for terminal facts. Live projections read the canonical Store while
// handling the published event, so publishing a settled event before its
// active-turn pointer is cleared creates an invalid snapshot and forces every
// caller to reconnect. The bounded wait keeps a broken reporter fail-fast and
// deliberately withholds the uncommitted event rather than advertising state
// that the canonical store does not contain.
func (c *Controller) reportSessionBeforePublish(
	ctx context.Context,
	session Session,
	events []activityshared.Event,
) error {
	if session.IsSideConversation() {
		return nil
	}
	if c == nil || c.reporter == nil {
		return nil
	}
	c.observeGoalControlLifecycle(ctx, session, events)
	report := c.prepareSessionReport(session, events)
	if len(report.StatePatches) == 0 && len(report.MessageUpdates) == 0 &&
		len(report.SessionAudits) == 0 && len(report.GoalReconcileRequests) == 0 {
		return nil
	}
	c.observeProviderObservations(ctx, session, report.ProviderObservations)
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	request := reportRequest{
		ctx:    reportCtx,
		report: report,
		done:   make(chan error, 1),
	}
	if c.reportQueue == nil {
		return c.report(request.ctx, request)
	}
	queueDepth := c.reportQueue.enqueue(request)
	select {
	case err := <-request.done:
		return err
	case <-reportCtx.Done():
		slog.Warn(
			"agent session terminal activity report barrier timed out",
			"event", "agent_session.activity_report.terminal_barrier_timeout",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"queue_depth", queueDepth,
			"error", reportCtx.Err(),
		)
		return reportCtx.Err()
	}
}

func (c *Controller) SetGoalControlLifecycleObserver(observer GoalControlLifecycleObserver) {
	if c == nil {
		return
	}
	c.goalControlObserverMu.Lock()
	c.goalControlObserver = observer
	c.goalControlObserverMu.Unlock()
}

func (c *Controller) observeGoalControlLifecycle(
	ctx context.Context,
	session Session,
	events []activityshared.Event,
) {
	if c == nil || len(events) == 0 {
		return
	}
	c.goalControlObserverMu.RLock()
	observer := c.goalControlObserver
	c.goalControlObserverMu.RUnlock()
	if observer == nil {
		return
	}
	for _, event := range events {
		if event.Type != activityshared.EventGoalControlApplied {
			continue
		}
		metadata := event.Payload.Metadata
		observation := GoalControlAppliedObservation{
			WorkspaceID:      session.RoomID,
			AgentSessionID:   firstNonEmptyString(event.AgentSessionID, session.AgentSessionID),
			OperationID:      stringFromPayload(metadata, "operationId"),
			Revision:         payloadInt64(metadata, "revision"),
			RepairEpoch:      payloadInt64(metadata, "repairEpoch"),
			Action:           stringFromPayload(metadata, "action"),
			ProviderTurnID:   stringFromPayload(metadata, "providerTurnId"),
			Observed:         payloadObject(metadata["goal"]),
			OccurredAtUnixMS: event.OccurredAtUnixMS,
			ExecutionPending: payloadBoolValue(metadata, "executionPending"),
		}
		if err := observer.ObserveGoalControlApplied(ctx, observation); err != nil {
			slog.Warn(
				"record runtime goal control application failed",
				"event", "agent_session.goal_control.observe_applied_failed",
				"room_id", observation.WorkspaceID,
				"agent_session_id", observation.AgentSessionID,
				"operation_id", observation.OperationID,
				"revision", observation.Revision,
				"error", err,
			)
		}
	}
}

func (c *Controller) SetProviderObservationObserver(observer ProviderObservationObserver) {
	if c == nil {
		return
	}
	c.providerObservationMu.Lock()
	c.providerObservationObserver = observer
	c.providerObservationMu.Unlock()
}

func (c *Controller) observeProviderObservations(
	ctx context.Context,
	session Session,
	observations []replay.ProviderObservationBatch,
) {
	if c == nil || len(observations) == 0 {
		return
	}
	c.providerObservationMu.RLock()
	observer := c.providerObservationObserver
	c.providerObservationMu.RUnlock()
	if observer == nil {
		return
	}
	if err := observer.ObserveProviderObservations(
		ctx,
		session.RoomID,
		session.AgentSessionID,
		observations,
	); err != nil {
		slog.Warn(
			"record provider observation candidate failed",
			"event", "agent_session.provider_observation.record_failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"error", err,
		)
	}
}

// reportSubmittedTurnDurable is the acceptance barrier for a user submission.
// The durable reporter commits the submitted Turn and canonical user message
// together before Exec may publish the transition, start provider work, or
// return success.
func (c *Controller) reportSubmittedTurnDurable(
	ctx context.Context,
	session Session,
	events []activityshared.Event,
	keepProvisional bool,
) error {
	if session.IsSideConversation() {
		return nil
	}
	if c == nil || c.reporter == nil {
		// Reporter-less controllers are used as standalone runtimes and have no
		// durable projection. The wired tuttid runtime always provides a reporter.
		return nil
	}
	if keepProvisional {
		session.Visible = false
	}
	report := reportActivityInput(session, events)
	c.enrichReportStatePatchesWithSessionMetadata(session, &report)
	if keepProvisional {
		hideProvisionalSessionReport(&report)
	}
	return c.reporter.ReportSubmitProvenance(ctx, report)
}

func hideProvisionalSessionReport(report *agentsessionstore.ReportActivityInput) {
	if report == nil {
		return
	}
	for index := range report.StatePatches {
		report.StatePatches[index].RuntimeContext = clonePayload(
			report.StatePatches[index].RuntimeContext,
		)
		if report.StatePatches[index].RuntimeContext == nil {
			report.StatePatches[index].RuntimeContext = make(map[string]any)
		}
		report.StatePatches[index].RuntimeContext["visible"] = false
		report.StatePatches[index].RuntimeContext["provisional"] = true
	}
}

// reportProviderAcceptanceDurable is the acceptance barrier for a provider
// root turn. Edit-retry dispatch completion may only follow this report.
func (c *Controller) reportProviderAcceptanceDurable(
	ctx context.Context,
	session Session,
	events []activityshared.Event,
) (bool, error) {
	if c == nil || c.reporter == nil || !containsDurableProviderAcceptance(events) {
		return false, nil
	}
	report := c.prepareSessionReport(session, events)
	// Mirror enqueueSessionReport: observe batches before the durable commit so
	// checkpoint candidates exist when ObserveReplayCommitted runs.
	c.observeProviderObservations(ctx, session, report.ProviderObservations)
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	request := reportRequest{
		ctx:    reportCtx,
		report: report,
		done:   make(chan error, 1),
	}
	if c.reportQueue == nil {
		return true, c.report(request.ctx, request)
	}
	c.reportQueue.enqueue(request)
	select {
	case err := <-request.done:
		return true, err
	case <-reportCtx.Done():
		return true, reportCtx.Err()
	}
}

// flushSessionReports waits until every report enqueued earlier for this
// Session has crossed the durable reporter. Goal-generation fencing uses this
// after the adapter's publication handoff, so Host cannot observe an idle
// Session immediately before an already-published Goal start commits.
func (c *Controller) flushSessionReports(ctx context.Context, session Session) error {
	if c == nil || c.reportQueue == nil {
		return nil
	}
	request := reportRequest{
		ctx: context.WithoutCancel(ctx),
		report: agentsessionstore.ReportActivityInput{
			WorkspaceID: session.RoomID,
			Source:      eventSourceFromSession(session),
		},
		barrier: true,
		done:    make(chan error, 1),
	}
	c.reportQueue.enqueue(request)
	select {
	case err := <-request.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func containsDurableProviderAcceptance(events []activityshared.Event) bool {
	for _, event := range events {
		if event.Type != activityshared.EventRootProviderTurnStarted {
			continue
		}
		source, _ := event.Payload.Metadata["acceptanceSource"].(string)
		if source == string(AcceptanceSourceTurnStartResponse) ||
			source == string(AcceptanceSourceHistoryRead) {
			return true
		}
	}
	return false
}

func (c *Controller) reportGoalReconcileControl(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	if c == nil || c.reporter == nil {
		return errors.New("durable goal reconcile reporter is unavailable")
	}
	return c.reporter.Report(ctx, report)
}

func (c *Controller) reportGoalReconcileDurable(ctx context.Context, session Session, request GoalReconcileDurableRequest) error {
	if session.IsSideConversation() {
		return nil
	}
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
	if session.IsSideConversation() {
		return
	}
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
	if session.IsSideConversation() {
		return
	}
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
	snapshotPatch := statePatchFromSessionStateSnapshot(snapshot)
	enrichReportStatePatchesWithSessionMetadata(report, snapshotPatch)
	if session.UserTitleSet {
		// A user-established title is the authoritative title source. Never let
		// a stale provider title carried by an event payload override it here;
		// the session's accepted title always wins in the persisted report.
		title := strings.TrimSpace(snapshotPatch.Title)
		for index := range report.StatePatches {
			if !statePatchMatchesSession(report.StatePatches[index], snapshotPatch.AgentSessionID) {
				continue
			}
			report.StatePatches[index].Title = title
		}
	}
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
		if session.UserTitleSet && statePatchMatchesSession(patch, snapshotPatch.AgentSessionID) {
			// Same ownership rule as the report enrichment: a user-established
			// title is the authoritative title source for the stream projection.
			tmp.StatePatches[0].Title = strings.TrimSpace(snapshotPatch.Title)
		}
		events[index].Data = tmp.StatePatches[0]
	}
}

func statePatchMatchesSession(
	patch agentsessionstore.WorkspaceAgentStatePatch,
	sessionID string,
) bool {
	sessionID = strings.TrimSpace(sessionID)
	return sessionID != "" && strings.TrimSpace(patch.AgentSessionID) == sessionID
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
		if patch.Capabilities != nil {
			report.StatePatches[index].Capabilities = canonical.CloneCapabilitySnapshot(patch.Capabilities)
		}
		report.StatePatches[index].RuntimeContext = clonePayload(patch.RuntimeContext)
		report.StatePatches[index].RuntimeContextPatch = nil
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
	if request.barrier {
		return nil
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
