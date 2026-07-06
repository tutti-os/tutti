package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *AppFactoryService) ObserveAgentSessionMessages(_ context.Context, input agentsessionstore.ReportSessionMessagesInput, reply agentsessionstore.ReportSessionMessagesReply) {
	if reply.AcceptedCount <= 0 || !factoryAgentMessageUpdatesContainCompletedAssistantText(input.Updates) {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	go func() {
		if err := s.handleAgentSessionCompletedMessage(context.Background(), workspaceID, agentSessionID); err != nil {
			slog.Warn("app factory agent session message handling failed",
				"workspaceId", workspaceID,
				"agentSessionId", agentSessionID,
				"error", err,
			)
		}
	}()
}

func (s *AppFactoryService) ObserveAgentSessionState(_ context.Context, input agentsessionstore.ReportSessionStateInput, reply agentsessionstore.ReportSessionStateReply) {
	if !reply.Accepted || !reply.StateApplied {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	s.trackAgentSessionTurnLifecycle(workspaceID, agentSessionID, input.State.TurnLifecycle)
	status := factoryAgentTerminalStatus(input.State)
	if status == "" {
		return
	}
	lastError := strings.TrimSpace(input.State.LastError)
	go func() {
		if err := s.handleAgentSessionTerminalState(context.Background(), workspaceID, agentSessionID, status, lastError); err != nil {
			slog.Warn("app factory agent session terminal state handling failed",
				"workspaceId", workspaceID,
				"agentSessionId", agentSessionID,
				"status", status,
				"error", err,
			)
		}
	}()
}

func (s *AppFactoryService) handleAgentSessionTerminalState(ctx context.Context, workspaceID string, agentSessionID string, status string, lastError string) error {
	job, ok, err := s.findAppFactoryJobByAgentSessionID(ctx, workspaceID, agentSessionID)
	if err != nil || !ok {
		return err
	}
	switch status {
	case "completed":
		if job.Status != workspacebiz.AppFactoryJobStatusGenerating &&
			!isRepublishableAppFactoryJobStatus(job) &&
			!isRecoverablePreValidationAgentFailure(job) {
			return nil
		}
		_, err := s.runValidation(ctx, workspaceID, job)
		return err
	case "canceled":
		if !isActiveAppFactoryJobStatus(job.Status) {
			return nil
		}
		job.Status = workspacebiz.AppFactoryJobStatusCanceled
		job.FailureReason = ""
		job.ValidationResultJSON = ""
		return s.putAndPublish(ctx, job)
	case "failed":
		if !isActiveAppFactoryJobStatus(job.Status) {
			return nil
		}
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = firstNonEmptyString(lastError, "App Factory agent session failed before validation.")
		job.ValidationResultJSON = ""
		return s.putAndPublish(ctx, job)
	default:
		return nil
	}
}

func (s *AppFactoryService) findAppFactoryJobByAgentSessionID(ctx context.Context, workspaceID string, agentSessionID string) (workspacebiz.AppFactoryJob, bool, error) {
	jobs, err := s.store().ListAppFactoryJobs(ctx, workspaceID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, false, err
	}
	for _, job := range jobs {
		if strings.TrimSpace(job.AgentSessionID) == agentSessionID {
			return job, true, nil
		}
	}
	return workspacebiz.AppFactoryJob{}, false, nil
}

func (s *AppFactoryService) handleAgentSessionCompletedMessage(ctx context.Context, workspaceID string, agentSessionID string) error {
	if !s.agentSessionHasCompletedFactoryOutput(workspaceID, agentSessionID) {
		return nil
	}
	return s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, "completed", "")
}

func (s *AppFactoryService) reconcileFromPersistedAgentSession(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) (bool, error) {
	if s == nil || s.AgentSessionReader == nil {
		return false, nil
	}
	agentSessionID := strings.TrimSpace(job.AgentSessionID)
	if agentSessionID == "" {
		return false, nil
	}
	session, ok := s.AgentSessionReader.GetSession(workspaceID, agentSessionID)
	if !ok {
		return false, nil
	}
	if status := normalizePersistedFactoryAgentSessionStatus(session.Status); status != "" {
		if status == "completed" && s.agentSessionHasLiveTurn(workspaceID, agentSessionID) {
			// The persisted session status says "completed", but a
			// TurnLifecycle snapshot we observed independently (see
			// trackAgentSessionTurnLifecycle) says a turn is still live for
			// this session. Trust the snapshot: it is copied verbatim from
			// the provider (ADR 0008) rather than folded/re-derived from
			// discrete events, so it is immune to the false-"completed"
			// class of bug this guard exists for. Leave the job alone; a
			// later reconcile pass will pick up the real terminal state.
			return true, nil
		}
		return true, s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, status, session.LastError)
	}
	if strings.ToLower(strings.TrimSpace(session.CurrentPhase)) == "failed" {
		return true, s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, "failed", session.LastError)
	}
	if isPersistedFactoryAgentSessionActive(session.Status, session.CurrentPhase) {
		return true, nil
	}
	return s.reconcileCompletedAgentSessionMessages(ctx, workspaceID, job)
}

func (s *AppFactoryService) reconcileCompletedAgentSessionMessages(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) (bool, error) {
	agentSessionID := strings.TrimSpace(job.AgentSessionID)
	if agentSessionID == "" || !s.agentSessionHasCompletedFactoryOutput(workspaceID, agentSessionID) {
		return false, nil
	}
	return true, s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, "completed", "")
}

// trackAgentSessionTurnLifecycle records whether an agent session currently
// has a live turn in flight, using the ADR 0008 TurnLifecycle snapshot
// (packages/agent/daemon/activity/events/turn_lifecycle_snapshot.go) that
// accompanies every session state report. It exists to close a gap PR #774
// only partly covered: a single codex turn commonly emits several
// role=assistant/kind=text/status=completed message segments before it
// actually finishes -- e.g. a short plan-announcement sentence ("I'll follow
// the app-factory skill; let me read its docs first...") streamed seconds
// before the agent's first tool call in the very same turn. PR #774 stopped
// treating tagged system-notice messages as a completion signal, but a plain
// narration segment like that is not a system notice, and the persisted
// session's own folded/derived Status can still misreport "completed" for
// it (see agentSessionHasCompletedFactoryOutput below, and the "天气查询"
// diagnostic bundle this guard was written from: job
// e6e70f6a-802e-4ac5-9275-ea6272f32b97 was failed at the exact millisecond
// its first narration message completed, while the codex session's own
// TurnLifecycle kept reporting phase "running" for the same turn ID for
// another 44+ seconds). The TurnLifecycle snapshot is copied verbatim by
// design (never re-derived from discrete events), so cross-checking it here
// catches this whole class of premature completion regardless of which
// message shape triggers it.
func (s *AppFactoryService) trackAgentSessionTurnLifecycle(workspaceID string, agentSessionID string, lifecycle *agentsessionstore.WorkspaceAgentTurnLifecycle) {
	if s == nil {
		return
	}
	if lifecycle == nil {
		// No TurnLifecycle snapshot accompanied this state report at all.
		// This is not the same thing as "the turn just settled": plenty of
		// legitimate session-level state reports carry no turn info
		// whatsoever, e.g. CodexAppServerAdapter.refreshStartupMetadataAsync
		// (packages/agent/daemon/runtime/codex_appserver_adapter.go), a
		// background goroutine that periodically refreshes rate
		// limits/model list/goal info and emits a plain EventSessionUpdated
		// with no TurnID on every retry. statePatchFromSessionEvent
		// (packages/agent/daemon/runtime/reporter.go) only populates
		// TurnLifecycle when the event carries a TurnID, so such updates
		// always arrive here with lifecycle == nil, including mid-turn.
		// Treating that as "clear the live marker" reintroduced the exact
		// premature-completion bug this guard was built to close (see the
		// package doc above trackAgentSessionTurnLifecycle): the marker set
		// by the turn-started update got wiped by the very next unrelated
		// session-level update, before the turn actually finished. Do
		// nothing here and leave whatever live/settled state we already
		// have untouched until an update that actually carries a
		// TurnLifecycle snapshot says otherwise.
		return
	}
	key := agentSessionTurnTrackerKey(workspaceID, agentSessionID)
	if agentSessionTurnLifecycleIsLive(lifecycle) {
		s.liveTurnAgentSessions.Store(key, struct{}{})
		return
	}
	s.liveTurnAgentSessions.Delete(key)
}

// agentSessionHasLiveTurn reports whether the last TurnLifecycle snapshot
// observed for this agent session (via ObserveAgentSessionState) says a turn
// is still running. See trackAgentSessionTurnLifecycle for why this is
// tracked independently of the message- and session-status-based completion
// heuristics below.
func (s *AppFactoryService) agentSessionHasLiveTurn(workspaceID string, agentSessionID string) bool {
	if s == nil {
		return false
	}
	_, ok := s.liveTurnAgentSessions.Load(agentSessionTurnTrackerKey(workspaceID, agentSessionID))
	return ok
}

func agentSessionTurnTrackerKey(workspaceID string, agentSessionID string) string {
	return strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
}

func agentSessionTurnLifecycleIsLive(lifecycle *agentsessionstore.WorkspaceAgentTurnLifecycle) bool {
	if lifecycle == nil {
		return false
	}
	if lifecycle.ActiveTurnID == nil || strings.TrimSpace(*lifecycle.ActiveTurnID) == "" {
		return false
	}
	if lifecycle.Outcome != nil && strings.TrimSpace(*lifecycle.Outcome) != "" {
		return false
	}
	return activityshared.TurnLifecyclePhaseIsLive(lifecycle.Phase)
}

func (s *AppFactoryService) agentSessionHasCompletedFactoryOutput(workspaceID string, agentSessionID string) bool {
	if s == nil || s.AgentMessageReader == nil {
		return false
	}
	if s.agentSessionHasLiveTurn(workspaceID, agentSessionID) {
		return false
	}
	if s.AgentSessionReader != nil {
		session, ok := s.AgentSessionReader.GetSession(workspaceID, agentSessionID)
		if !ok {
			return false
		}
		switch normalizeFactoryAgentSessionStatus(session.Status) {
		case "completed":
			return true
		default:
			return false
		}
	}
	page, ok := s.AgentMessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    strings.TrimSpace(workspaceID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		Limit:          1,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok || len(page.Messages) == 0 {
		return false
	}
	latest := page.Messages[0]
	return isCompletedAssistantTextMessage(latest.Role, latest.Kind, latest.Status, latest.Payload)
}

func (s *AppFactoryService) runValidation(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) (workspacebiz.AppFactoryJob, error) {
	job.Status = workspacebiz.AppFactoryJobStatusPreparing
	job.FailureReason = ""
	job.ValidationResultJSON = ""
	if err := s.putAndPublish(ctx, job); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}

	result := workspacebiz.AppFactoryValidationResult{CheckedAt: unixMsNow()}
	if err := prepareAppFactoryJob(ctx, job); err != nil {
		result.Errors = append(result.Errors, err.Error())
		return s.failValidation(ctx, job, result)
	}

	job.Status = workspacebiz.AppFactoryJobStatusValidating
	if err := s.putAndPublish(ctx, job); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if err := s.validatePackage(ctx, workspaceID, job); err != nil {
		result.Errors = append(result.Errors, err.Error())
		return s.failValidation(ctx, job, result)
	}

	result.OK = true
	encoded, err := json.Marshal(result)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("serialize app factory validation result: %w", err)
	}
	job.ValidationResultJSON = string(encoded)
	if strings.TrimSpace(job.PublishedVersion) != "" {
		changed, err := appFactoryDraftChanged(job)
		if err != nil {
			result.Errors = append(result.Errors, err.Error())
			return s.failValidation(ctx, job, result)
		}
		if !changed {
			job.Status = workspacebiz.AppFactoryJobStatusPublished
			job.FailureReason = ""
			return s.putAndPublishReturn(ctx, job)
		}
	}
	job.Status = workspacebiz.AppFactoryJobStatusReady
	job.FailureReason = ""
	return s.putAndPublishReturn(ctx, job)
}

func (s *AppFactoryService) failValidation(ctx context.Context, job workspacebiz.AppFactoryJob, result workspacebiz.AppFactoryValidationResult) (workspacebiz.AppFactoryJob, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("serialize app factory validation result: %w", err)
	}
	job.ValidationResultJSON = string(encoded)
	job.Status = workspacebiz.AppFactoryJobStatusFailed
	if len(result.Errors) > 0 {
		job.FailureReason = result.Errors[0]
	}
	return s.putAndPublishReturn(ctx, job)
}

func isActiveAppFactoryJobStatus(status workspacebiz.AppFactoryJobStatus) bool {
	switch status {
	case workspacebiz.AppFactoryJobStatusQueued,
		workspacebiz.AppFactoryJobStatusGenerating,
		workspacebiz.AppFactoryJobStatusPreparing,
		workspacebiz.AppFactoryJobStatusValidating:
		return true
	default:
		return false
	}
}

func isRepublishableAppFactoryJobStatus(job workspacebiz.AppFactoryJob) bool {
	if strings.TrimSpace(job.PublishedVersion) == "" {
		return false
	}
	switch job.Status {
	case workspacebiz.AppFactoryJobStatusPublished,
		workspacebiz.AppFactoryJobStatusReady,
		workspacebiz.AppFactoryJobStatusFailed:
		return true
	default:
		return false
	}
}

func isFailedValidationAppFactoryJob(job workspacebiz.AppFactoryJob) bool {
	return job.Status == workspacebiz.AppFactoryJobStatusFailed &&
		strings.TrimSpace(job.ValidationResultJSON) != ""
}

func isRecoverablePreValidationAgentFailure(job workspacebiz.AppFactoryJob) bool {
	return job.Status == workspacebiz.AppFactoryJobStatusFailed &&
		strings.TrimSpace(job.ValidationResultJSON) == "" &&
		strings.TrimSpace(job.FailureReason) == "App Factory agent session failed before validation."
}

func normalizeFactoryAgentSessionStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "ended", "succeeded", "success":
		return "completed"
	case "canceled":
		return "canceled"
	case "failed", "failure", "error", "errored":
		return "failed"
	default:
		return ""
	}
}

func normalizePersistedFactoryAgentSessionStatus(status string) string {
	return normalizeFactoryAgentSessionStatus(status)
}

func isPersistedFactoryAgentSessionActive(status string, currentPhase string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "active", "created", "queued", "running", "working", "waiting":
		return true
	}
	switch strings.ToLower(strings.TrimSpace(currentPhase)) {
	case "idle", "working", "running", "streaming", "waiting", "waiting_approval", "awaiting_approval", "waiting_input":
		return true
	default:
		return false
	}
}

func factoryAgentTerminalStatus(state agentsessionstore.WorkspaceAgentSessionStateUpdate) string {
	if status := normalizeFactoryAgentSessionStatus(state.LifecycleStatus); status != "" {
		return status
	}
	if strings.ToLower(strings.TrimSpace(state.CurrentPhase)) == "failed" {
		return "failed"
	}
	if state.Turn == nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(state.Turn.Outcome)) {
	case "completed", "complete", "succeeded", "success":
		return "completed"
	case "failed", "failure", "error", "errored":
		return "failed"
	default:
		return ""
	}
}

func factoryAgentMessageUpdatesContainCompletedAssistantText(updates []agentsessionstore.WorkspaceAgentSessionMessageUpdate) bool {
	for _, update := range updates {
		if isCompletedAssistantTextMessage(update.Role, update.Kind, update.Status, update.Payload) {
			return true
		}
	}
	return false
}

// isCompletedAssistantTextMessage reports whether a message update looks like
// the agent's completed final answer text. System notices (skill/context
// budget warnings, model reroutes, compaction banners, etc.) are reported
// through the same role=assistant/kind=text/status=completed shape as real
// task narration — see acpSystemNoticeEvent in
// packages/agent/daemon/runtime/acp_update_events.go, which always tags its
// payload with "kind": "agent_system_notice". Treating one of those as the
// signal that the whole App Factory job finished caused jobs to be marked
// failed within seconds of creation (validating against a manifest the
// agent hadn't written yet) while the agent kept working in the background
// and went on to succeed. Excluding tagged system notices here keeps the
// heuristic scoped to genuine assistant output.
func isCompletedAssistantTextMessage(role string, kind string, status string, payload map[string]any) bool {
	if isAppFactorySystemNoticeMessagePayload(payload) {
		return false
	}
	return strings.ToLower(strings.TrimSpace(role)) == "assistant" &&
		strings.ToLower(strings.TrimSpace(kind)) == "text" &&
		strings.ToLower(strings.TrimSpace(status)) == "completed"
}

func isAppFactorySystemNoticeMessagePayload(payload map[string]any) bool {
	if len(payload) == 0 {
		return false
	}
	kind, _ := payload["kind"].(string)
	return strings.EqualFold(strings.TrimSpace(kind), "agent_system_notice")
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
