package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
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
	status := factoryAgentTerminalStatus(input.State)
	if workspaceID == "" || agentSessionID == "" || status == "" {
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
	status := normalizePersistedFactoryAgentSessionStatus(session.Status)
	if status == "" {
		return s.reconcileCompletedAgentSessionMessages(ctx, workspaceID, job)
	}
	return true, s.handleAgentSessionTerminalState(ctx, workspaceID, agentSessionID, status, session.LastError)
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
		switch normalizeFactoryAgentSessionStatus(session.Status) {
		case "completed":
			return true
		case "canceled":
			return false
		case "failed":
			return false
		default:
			if strings.ToLower(strings.TrimSpace(session.Status)) != "active" ||
				strings.ToLower(strings.TrimSpace(session.CurrentPhase)) != "idle" {
				return false
			}
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
	return isCompletedAssistantTextMessage(latest.Role, latest.Kind, latest.Status)
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
	case "completed", "complete", "succeeded", "success":
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

func factoryAgentTerminalStatus(state agentsessionstore.WorkspaceAgentSessionStateUpdate) string {
	if status := normalizeFactoryAgentSessionStatus(state.LifecycleStatus); status != "" {
		return status
	}
	if state.Turn == nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(state.Turn.Outcome)) {
	case "completed", "complete", "succeeded", "success":
		return "completed"
	default:
		return ""
	}
}

func factoryAgentMessageUpdatesContainCompletedAssistantText(updates []agentsessionstore.WorkspaceAgentSessionMessageUpdate) bool {
	for _, update := range updates {
		if isCompletedAssistantTextMessage(update.Role, update.Kind, update.Status) {
			return true
		}
	}
	return false
}

func isCompletedAssistantTextMessage(role string, kind string, status string) bool {
	return strings.ToLower(strings.TrimSpace(role)) == "assistant" &&
		strings.ToLower(strings.TrimSpace(kind)) == "text" &&
		strings.ToLower(strings.TrimSpace(status)) == "completed"
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
