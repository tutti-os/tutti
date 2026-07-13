package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *AppFactoryService) ObserveAgentSessionMessages(_ context.Context, input agentsessionstore.ReportSessionMessagesInput, reply agentsessionstore.ReportSessionMessagesReply) {
	if reply.AcceptedCount <= 0 {
		return
	}
	hasCanceledTurnToolCall := factoryAgentMessageUpdatesContainCanceledTurnToolCall(input.Updates)
	hasCompletedAssistantText := factoryAgentMessageUpdatesContainCompletedAssistantText(input.Updates)
	if !hasCanceledTurnToolCall && !hasCompletedAssistantText {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	go func() {
		err := s.handleAgentSessionCompletedMessage(context.Background(), workspaceID, agentSessionID)
		if err != nil {
			slog.Warn("app factory agent session message handling failed",
				"workspaceId", workspaceID,
				"agentSessionId", agentSessionID,
				"candidateCanceled", hasCanceledTurnToolCall,
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
	status := factorySettledTurnOutcome(input.State.Turn)
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
	if strings.TrimSpace(session.ActiveTurnID) != "" {
		return true, nil
	}
	if reader, ok := s.AgentSessionReader.(interface {
		ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error)
	}); ok {
		turns, err := reader.ListLatestTurns(ctx, workspaceID, []string{agentSessionID})
		if err != nil {
			return false, err
		}
		if turn, found := turns[agentSessionID]; found && strings.TrimSpace(turn.Phase) == "settled" {
			status := normalizeFactoryAgentSessionStatus(turn.Outcome)
			if status != "" {
				return true, s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, status, strings.TrimSpace(turn.ErrorMessage))
			}
		}
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

func (s *AppFactoryService) agentSessionHasCompletedFactoryOutput(workspaceID string, agentSessionID string) bool {
	if s == nil || s.AgentMessageReader == nil {
		return false
	}
	if s.AgentSessionReader != nil {
		session, ok := s.AgentSessionReader.GetSession(workspaceID, agentSessionID)
		if !ok {
			return false
		}
		if strings.TrimSpace(session.ActiveTurnID) != "" {
			return false
		}
		if reader, ok := s.AgentSessionReader.(interface {
			ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error)
		}); ok {
			turns, err := reader.ListLatestTurns(context.Background(), workspaceID, []string{agentSessionID})
			if err != nil {
				return false
			}
			turn, found := turns[agentSessionID]
			return found && strings.TrimSpace(turn.Phase) == "settled" && strings.TrimSpace(turn.Outcome) == "completed"
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
	case "completed":
		return "completed"
	case "canceled":
		return "canceled"
	case "failed", "interrupted":
		return "failed"
	default:
		return ""
	}
}

func factorySettledTurnOutcome(turn *agentsessionstore.WorkspaceAgentTurnStateUpdate) string {
	if turn == nil || strings.TrimSpace(turn.Phase) != "settled" {
		return ""
	}
	return normalizeFactoryAgentSessionStatus(turn.Outcome)
}

func factoryAgentMessageUpdatesContainCompletedAssistantText(updates []agentsessionstore.WorkspaceAgentSessionMessageUpdate) bool {
	for _, update := range updates {
		if isCompletedAssistantTextMessage(update.Role, update.Kind, update.Status, update.Payload) {
			return true
		}
	}
	return false
}

func factoryAgentMessageUpdatesContainCanceledTurnToolCall(updates []agentsessionstore.WorkspaceAgentSessionMessageUpdate) bool {
	for _, update := range updates {
		if isCanceledTurnToolCallMessage(update.Kind, update.Status, update.Payload) {
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

func isCanceledTurnToolCallMessage(kind string, status string, payload map[string]any) bool {
	if strings.ToLower(strings.TrimSpace(kind)) != "tool_call" ||
		strings.ToLower(strings.TrimSpace(status)) != "failed" ||
		strings.EqualFold(strings.TrimSpace(appFactoryPayloadString(payload, "callType")), "approval") {
		return false
	}
	errorPayload, _ := payload["error"].(map[string]any)
	canceled := appFactoryStatusMeansCanceled(appFactoryPayloadString(payload, "status")) ||
		appFactoryStatusMeansCanceled(appFactoryPayloadString(errorPayload, "status"))
	if !canceled {
		return false
	}
	return appFactoryPayloadMeansInterrupted(payload) || appFactoryPayloadMeansInterrupted(errorPayload)
}

func appFactoryStatusMeansCanceled(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "canceled", "cancelled":
		return true
	default:
		return false
	}
}

func appFactoryPayloadMeansInterrupted(payload map[string]any) bool {
	for _, key := range []string{"reason", "message", "text"} {
		if strings.EqualFold(strings.TrimSpace(appFactoryPayloadString(payload, key)), "interrupted") {
			return true
		}
	}
	return false
}

func appFactoryPayloadString(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	value, _ := payload[key].(string)
	return value
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
