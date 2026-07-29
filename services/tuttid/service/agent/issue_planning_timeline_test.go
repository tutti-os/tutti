package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestIssuePlanningTimelineReporterLinksSourceSessionToIssue(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	projection := NewActivityProjection(store)
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider: "codex", CurrentPhase: "idle", OccurredAtUnixMS: 1000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	reporter := IssuePlanningTimelineReporter{Projection: projection}
	reporter.ReportIssuePlanningLink(
		ctx, "ws-1", "session-1", "issue-1", "topic-1", "Plan [migration]", time.UnixMilli(2000),
	)

	page, ok := projection.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Order: agentactivitybiz.MessageOrderAsc, Limit: 20,
	})
	if !ok || len(page.Messages) != 1 {
		t.Fatalf("messages = %#v, ok = %v", page.Messages, ok)
	}
	message := page.Messages[0]
	content, _ := message.Payload["content"].(string)
	if message.MessageID != "plan-issue:issue-1" || message.Kind != "session_audit" {
		t.Fatalf("message = %#v", message)
	}
	if !strings.Contains(content, "[@Plan \\[migration\\]]") ||
		!strings.Contains(content, "mention://workspace-issue/issue-1?") ||
		!strings.Contains(content, "topicId=topic-1") ||
		!strings.Contains(content, "workspaceId=ws-1") {
		t.Fatalf("content = %q", content)
	}
	// The link is a session-level annotation: it must not mint a turn, and it
	// must never occupy the session's live-turn slot (a synthetic live turn
	// here wedged the GUI spinner and blocked later timeline reports).
	if message.TurnID != "" {
		t.Fatalf("message turn id = %q, want session-level (empty)", message.TurnID)
	}
	if _, exists, err := store.GetTurn(ctx, "ws-1", "session-1", "plan-issue:issue-1"); err != nil || exists {
		t.Fatalf("synthetic turn exists = %v, err = %v; want absent", exists, err)
	}
}
