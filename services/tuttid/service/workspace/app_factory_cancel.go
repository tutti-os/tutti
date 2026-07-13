package workspace

import (
	"context"
	"log/slog"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *AppFactoryService) Cancel(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if job.AgentSessionID != "" && s.AgentSessionService != nil {
		turnID := ""
		if s.AgentSessionReader != nil {
			if session, ok := s.AgentSessionReader.GetSession(workspaceID, job.AgentSessionID); ok {
				turnID = strings.TrimSpace(session.ActiveTurnID)
			}
		}
		if turnID != "" {
			if _, err := s.AgentSessionService.CancelTurn(ctx, workspaceID, job.AgentSessionID, turnID); err != nil {
				slog.Warn("cancel app factory agent turn failed", "workspaceId", workspaceID, "jobId", jobID, "turnId", turnID, "error", err)
			}
		}
	}
	job.Status = workspacebiz.AppFactoryJobStatusCanceled
	job.FailureReason = ""
	return s.putAndPublishReturn(ctx, job)
}
