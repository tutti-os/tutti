package agent

import (
	"context"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

// CollaborationTimelineReporter projects collaboration runs into the source
// session's durable timeline as messages of kind "collaboration", so every
// consult, fork, delegate, and handoff is a visible card in the transcript
// instead of an invisible side process. The message id and turn id derive
// from the run id, so status transitions update one row in place.
type CollaborationTimelineReporter struct {
	Projection *ActivityProjection
}

func (r CollaborationTimelineReporter) ReportCollaborationTimeline(ctx context.Context, run collabrunbiz.Run) {
	if r.Projection == nil {
		return
	}
	workspaceID := strings.TrimSpace(run.WorkspaceID)
	sourceSessionID := strings.TrimSpace(run.SourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return
	}
	occurredAt := run.UpdatedAt
	if occurredAt.IsZero() {
		occurredAt = run.CreatedAt
	}
	status := "completed"
	switch run.Status {
	case collabrunbiz.StatusRunning:
		status = "running"
	case collabrunbiz.StatusFailed:
		status = "failed"
	case collabrunbiz.StatusCanceled:
		status = "canceled"
	}
	payload := map[string]any{
		"runId":         run.ID,
		"mode":          string(run.Mode),
		"status":        string(run.Status),
		"triggerSource": string(run.TriggerSource),
		"adoption":      string(run.Adoption),
	}
	if run.TriggerReason != "" {
		payload["triggerReason"] = run.TriggerReason
	}
	if run.TargetSessionID != "" {
		payload["targetSessionId"] = run.TargetSessionID
	}
	if run.TargetAgentTargetID != "" {
		payload["targetAgentTargetId"] = run.TargetAgentTargetID
	}
	if run.ModelPlanID != "" {
		payload["modelPlanId"] = run.ModelPlanID
	}
	if run.Model != "" {
		payload["model"] = run.Model
	}
	if run.ContextScope != "" {
		payload["contextScope"] = run.ContextScope
	}
	if run.ResultText != "" {
		payload["resultText"] = run.ResultText
	}
	if run.FailureReason != "" {
		payload["failureReason"] = run.FailureReason
	}
	if run.DurationMs > 0 {
		payload["durationMs"] = run.DurationMs
	}
	if run.Usage.InputTokens > 0 || run.Usage.OutputTokens > 0 {
		payload["usage"] = map[string]any{
			"inputTokens":  run.Usage.InputTokens,
			"outputTokens": run.Usage.OutputTokens,
		}
	}
	// Session-level system annotation: deliberately no TurnID. Collaboration
	// records are updated in place by MessageID and belong to no agent turn; a
	// synthetic turn id would either be rejected while a real turn is live or
	// wedge the session's active-turn slot when none is.
	update := canonical.WorkspaceAgentSessionMessageUpdate{
		MessageID:        "collab:" + run.ID,
		Role:             "assistant",
		Kind:             "collaboration",
		Status:           status,
		Payload:          payload,
		OccurredAtUnixMS: occurredAt.UnixMilli(),
	}
	if !run.StartedAt.IsZero() {
		update.StartedAtUnixMS = run.StartedAt.UnixMilli()
	}
	if !run.CompletedAt.IsZero() {
		update.CompletedAtUnixMS = run.CompletedAt.UnixMilli()
	}
	if _, err := r.Projection.ReportSessionMessages(ctx, canonical.ReportSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sourceSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Updates:        []canonical.WorkspaceAgentSessionMessageUpdate{update},
	}); err != nil {
		slog.Warn("report collaboration timeline failed",
			"event", "agent.collaboration.timeline_report_failed",
			"workspace_id", workspaceID,
			"agent_session_id", sourceSessionID,
			"collaboration_run_id", run.ID,
			"error", err,
		)
	}
}
