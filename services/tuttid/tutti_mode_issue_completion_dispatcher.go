package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const tuttiPlanIssueCompletionDispatchTimeout = 2 * time.Minute

// tuttiPlanIssueCompletionDispatcher hands control back to the planning
// conversation once every task of a tutti-mode-plan Issue is completed and
// accepted: it sends the source Agent session a completion message so the
// conversation continues without the user having to switch surfaces. The
// acceptance is already durable before dispatch; failures are logged and the
// Issue Manager remains the source of truth.
type tuttiPlanIssueCompletionDispatcher struct {
	Agents *agentservice.Service
	// Synchronous is used by tests; production dispatch is fire-and-forget so
	// the accepting call never waits on provider acceptance.
	Synchronous bool

	mu         sync.Mutex
	dispatched map[string]struct{}
}

func (d *tuttiPlanIssueCompletionDispatcher) NotifyTuttiPlanIssueCompleted(
	_ context.Context,
	workspaceID string,
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
) {
	if d == nil || d.Agents == nil {
		return
	}
	// The finishing acceptance fires exactly once per issue in practice, but
	// replays (idempotent accepts, recovery passes) must not spam the
	// conversation.
	d.mu.Lock()
	if d.dispatched == nil {
		d.dispatched = map[string]struct{}{}
	}
	key := workspaceID + "/" + issue.IssueID
	if _, exists := d.dispatched[key]; exists {
		d.mu.Unlock()
		return
	}
	d.dispatched[key] = struct{}{}
	d.mu.Unlock()
	if d.Synchronous {
		d.dispatch(workspaceID, issue, tasks)
		return
	}
	go d.dispatch(workspaceID, issue, tasks)
}

func (d *tuttiPlanIssueCompletionDispatcher) dispatch(
	workspaceID string,
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
) {
	ctx, cancel := context.WithTimeout(context.Background(), tuttiPlanIssueCompletionDispatchTimeout)
	defer cancel()
	result, err := d.Agents.SendInput(ctx, workspaceID, issue.SourceSessionID, agentservice.SendInput{
		Content: []agentservice.PromptContentBlock{{
			Type: "text",
			Text: tuttiPlanIssueCompletionPrompt(issue, tasks),
		}},
		ClientSubmitID: "tutti-plan-issue-completed:" + issue.IssueID,
		Metadata: map[string]any{
			"tuttiModePlanIssueId": issue.IssueID,
		},
	})
	if err != nil {
		slog.Warn("tutti mode plan issue completion dispatch failed",
			"event", "tutti_mode_plan.issue_completion_dispatch_failed",
			"workspaceId", workspaceID,
			"issueId", issue.IssueID,
			"sourceSessionId", issue.SourceSessionID,
			"error", err)
		return
	}
	slog.Info("tutti mode plan issue completion dispatched",
		"event", "tutti_mode_plan.issue_completion_dispatched",
		"workspaceId", workspaceID,
		"issueId", issue.IssueID,
		"turnId", strings.TrimSpace(result.TurnID))
}

func tuttiPlanIssueCompletionPrompt(issue workspaceissues.Issue, tasks []workspaceissues.Task) string {
	lines := make([]string, 0, len(tasks))
	for _, task := range tasks {
		summary := strings.TrimSpace(task.AcceptanceSummary)
		if summary == "" {
			summary = strings.TrimSpace(task.Title)
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", task.TaskID, summary))
	}
	return fmt.Sprintf(`Every task of your accepted Tutti Mode plan has completed and been accepted.

Issue: %s
Tasks:
%s

Review the produced results in the working directories, verify the outcome end to end, and report a concise summary to the user in this conversation. Do not re-run the tasks; the Issue is the durable record. If follow-up work is needed, discuss it with the user first.`,
		issue.Title,
		strings.Join(lines, "\n"),
	)
}
