package agent

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

// IssuePlanningTimelineReporter writes the durable reverse link from a Plan
// session to the Issue that became the plan's canonical persisted form.
type IssuePlanningTimelineReporter struct {
	Projection *ActivityProjection
}

func (r IssuePlanningTimelineReporter) ReportIssuePlanningLink(
	ctx context.Context,
	workspaceID string,
	sourceSessionID string,
	issueID string,
	topicID string,
	title string,
	occurredAt time.Time,
) {
	if r.Projection == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	issueID = strings.TrimSpace(issueID)
	if workspaceID == "" || sourceSessionID == "" || issueID == "" {
		return
	}
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}
	// Session-level system annotation: deliberately no TurnID. This entry does
	// not belong to any agent turn (the source turn already settled when the
	// user accepted), and a synthetic turn id would open a live turn record no
	// terminal event ever settles — wedging the session's active-turn slot.
	update := agentsessionstore.WorkspaceAgentSessionMessageUpdate{
		MessageID:         "plan-issue:" + issueID,
		Role:              "assistant",
		Kind:              "session_audit",
		Status:            "completed",
		Payload:           map[string]any{"content": issuePlanningLinkMarkdown(workspaceID, issueID, topicID, title)},
		OccurredAtUnixMS:  occurredAt.UnixMilli(),
		CompletedAtUnixMS: occurredAt.UnixMilli(),
	}
	if _, err := r.Projection.ReportSessionMessages(ctx, agentsessionstore.ReportSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sourceSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Updates:        []agentsessionstore.WorkspaceAgentSessionMessageUpdate{update},
	}); err != nil {
		slog.Warn("report plan Issue timeline link failed",
			"event", "agent.plan_issue.timeline_report_failed",
			"workspace_id", workspaceID,
			"agent_session_id", sourceSessionID,
			"issue_id", issueID,
			"error", err,
		)
	}
}

func issuePlanningLinkMarkdown(workspaceID string, issueID string, topicID string, title string) string {
	query := url.Values{"workspaceId": []string{strings.TrimSpace(workspaceID)}}
	if topicID = strings.TrimSpace(topicID); topicID != "" {
		query.Set("topicId", topicID)
	}
	label := strings.TrimSpace(title)
	if label == "" {
		label = issueID
	}
	label = strings.NewReplacer(
		"\\", "\\\\",
		"[", "\\[",
		"]", "\\]",
		"(", "\\(",
		")", "\\)",
	).Replace(label)
	return "[@" + label + "](mention://workspace-issue/" + url.PathEscape(issueID) + "?" + query.Encode() + ")"
}
