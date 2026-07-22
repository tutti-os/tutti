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

// NotifyTuttiPlanIssueTaskFailed reports one failed task run back to the
// planning conversation. Deduped per run so reconcile replays stay quiet; a
// genuine retry produces a new run and therefore a new report.
func (d *tuttiPlanIssueCompletionDispatcher) NotifyTuttiPlanIssueTaskFailed(
	_ context.Context,
	workspaceID string,
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	run workspaceissues.Run,
) {
	if d == nil || d.Agents == nil {
		return
	}
	d.mu.Lock()
	if d.dispatched == nil {
		d.dispatched = map[string]struct{}{}
	}
	key := workspaceID + "/run-failed/" + run.RunID
	if _, exists := d.dispatched[key]; exists {
		d.mu.Unlock()
		return
	}
	d.dispatched[key] = struct{}{}
	d.mu.Unlock()
	send := func() {
		ctx, cancel := context.WithTimeout(context.Background(), tuttiPlanIssueCompletionDispatchTimeout)
		defer cancel()
		result, err := d.Agents.SendInput(ctx, workspaceID, issue.SourceSessionID, agentservice.SendInput{
			Content: []agentservice.PromptContentBlock{{
				Type: "text",
				Text: tuttiPlanIssueTaskFailedPrompt(issue, task, run),
			}},
			ClientSubmitID: "tutti-plan-issue-task-failed:" + run.RunID,
			Metadata: map[string]any{
				"tuttiModePlanIssueId": issue.IssueID,
			},
		})
		if err != nil {
			slog.Warn("tutti mode plan issue task failure dispatch failed",
				"event", "tutti_mode_plan.issue_task_failure_dispatch_failed",
				"workspaceId", workspaceID,
				"issueId", issue.IssueID,
				"taskId", task.TaskID,
				"runId", run.RunID,
				"sourceSessionId", issue.SourceSessionID,
				"error", err)
			return
		}
		slog.Info("tutti mode plan issue task failure dispatched",
			"event", "tutti_mode_plan.issue_task_failure_dispatched",
			"workspaceId", workspaceID,
			"issueId", issue.IssueID,
			"taskId", task.TaskID,
			"runId", run.RunID,
			"turnId", strings.TrimSpace(result.TurnID))
	}
	if d.Synchronous {
		send()
		return
	}
	go send()
}

// NotifyTuttiPlanIssueTaskSettled wakes the planning conversation with one
// successfully settled task run so the planning agent — the orchestrator of
// its accepted plan — decides how execution advances. Deduped per run, so
// reconcile replays cannot spam the session.
func (d *tuttiPlanIssueCompletionDispatcher) NotifyTuttiPlanIssueTaskSettled(
	_ context.Context,
	workspaceID string,
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	run workspaceissues.Run,
	allTasks []workspaceissues.Task,
	decisionNeeded bool,
) {
	if d == nil || d.Agents == nil {
		return
	}
	d.mu.Lock()
	if d.dispatched == nil {
		d.dispatched = map[string]struct{}{}
	}
	key := workspaceID + "/run-settled/" + run.RunID
	if _, exists := d.dispatched[key]; exists {
		d.mu.Unlock()
		return
	}
	d.dispatched[key] = struct{}{}
	d.mu.Unlock()
	send := func() {
		ctx, cancel := context.WithTimeout(context.Background(), tuttiPlanIssueCompletionDispatchTimeout)
		defer cancel()
		result, err := d.Agents.SendInput(ctx, workspaceID, issue.SourceSessionID, agentservice.SendInput{
			Content: []agentservice.PromptContentBlock{{
				Type: "text",
				Text: tuttiPlanIssueTaskSettledPrompt(issue, task, run, allTasks, decisionNeeded, tuttiModePlanCLICommandName()),
			}},
			ClientSubmitID: "tutti-plan-issue-task-settled:" + run.RunID,
			Metadata: map[string]any{
				"tuttiModePlanIssueId": issue.IssueID,
			},
		})
		if err != nil {
			slog.Warn("tutti mode plan issue task settle dispatch failed",
				"event", "tutti_mode_plan.issue_task_settle_dispatch_failed",
				"workspaceId", workspaceID,
				"issueId", issue.IssueID,
				"taskId", task.TaskID,
				"runId", run.RunID,
				"sourceSessionId", issue.SourceSessionID,
				"error", err)
			return
		}
		slog.Info("tutti mode plan issue task settle dispatched",
			"event", "tutti_mode_plan.issue_task_settle_dispatched",
			"workspaceId", workspaceID,
			"issueId", issue.IssueID,
			"taskId", task.TaskID,
			"runId", run.RunID,
			"decisionNeeded", decisionNeeded,
			"turnId", strings.TrimSpace(result.TurnID))
	}
	if d.Synchronous {
		send()
		return
	}
	go send()
}

func tuttiPlanIssueTaskBoardLine(task workspaceissues.Task) string {
	marks := make([]string, 0, 3)
	marks = append(marks, string(task.Status))
	if task.Status == workspaceissues.StatusCompleted && task.AcceptanceState == workspaceissues.AcceptanceUserAccepted {
		marks = append(marks, "accepted")
	} else if task.Status == workspaceissues.StatusPendingAcceptance {
		marks = append(marks, "awaiting acceptance")
	}
	if task.AutoAccept {
		marks = append(marks, "autoAccept")
	}
	line := fmt.Sprintf("- %s (%s): %s", task.TaskID, strings.TrimSpace(task.Title), strings.Join(marks, ", "))
	if len(task.DependencyTaskIDs) > 0 {
		line += " — depends on " + strings.Join(task.DependencyTaskIDs, ", ")
	}
	return line
}

func tuttiPlanIssueTaskSettledPrompt(
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	run workspaceissues.Run,
	allTasks []workspaceissues.Task,
	decisionNeeded bool,
	cliName string,
) string {
	board := make([]string, 0, len(allTasks))
	for _, item := range allTasks {
		board = append(board, tuttiPlanIssueTaskBoardLine(item))
	}
	summary := strings.TrimSpace(run.Summary)
	if summary == "" {
		summary = strings.TrimSpace(task.AcceptanceSummary)
	}
	if summary == "" {
		summary = "The run reported no summary; inspect its outputs in the working directory."
	}
	workingDirectory := strings.TrimSpace(run.ExecutionDirectory)
	if workingDirectory == "" {
		workingDirectory = "(planning session directory)"
	}
	header := fmt.Sprintf(`A task of your accepted Tutti Mode plan finished. You are the orchestrator of this plan: review the result and advance execution in this turn — the daemon does not chain tasks past a pending acceptance on its own.

Issue: %s
Settled task: %s (%s)
Working directory: %s
Result claim:
%s

Task board:
%s`,
		issue.Title,
		task.TaskID,
		strings.TrimSpace(task.Title),
		workingDirectory,
		summary,
		strings.Join(board, "\n"),
	)
	if decisionNeeded {
		return header + fmt.Sprintf(`

This task is pending acceptance and its plan did not mark it autoAccept, so the acceptance decision is yours (the user already approved the plan; they can still override from the issue panel or steer you with a message). Every command below is a %[1]s shell command:
- Verify the claim first (read the produced files, run checks) in this turn.
- Accept when the result holds: %[1]s issue task update --issue-id %[2]s --task-id %[3]s --status completed
- Send it back for rework when it does not: %[1]s issue task update --issue-id %[2]s --task-id %[3]s --status not_started  (refine --content first so the retry fixes the gap)
- Reshape the remaining graph if needed (%[1]s issue task update / create / delete), or pause everything: %[1]s issue update --issue-id %[2]s --dispatch-paused true
Accepting re-opens the dispatch frontier automatically; end the turn with a one-line progress note for the user.`,
			cliName, issue.IssueID, task.TaskID)
	}
	return header + fmt.Sprintf(`

The task was auto-accepted per the plan and eligible successors are being dispatched automatically. Intervene only if the result claim or the board looks wrong (every command is a %[1]s shell command): send a task back with "%[1]s issue task update --issue-id %[2]s --task-id <id> --status not_started", or pause dispatch with "%[1]s issue update --issue-id %[2]s --dispatch-paused true". Otherwise end the turn with a one-line progress note for the user.`,
		cliName, issue.IssueID)
}

func tuttiPlanIssueTaskFailedPrompt(issue workspaceissues.Issue, task workspaceissues.Task, run workspaceissues.Run) string {
	reason := strings.TrimSpace(run.ErrorMessage)
	if reason == "" {
		reason = "The run ended without a reported reason."
	}
	return fmt.Sprintf(`A task of your accepted Tutti Mode plan failed, and dispatch is paused until it is resolved.

Issue: %s
Failed task: %s (%s)
Reason: %s

Inspect what went wrong (the Issue records the run and any outputs), then tell the user what happened and recommend a next step in this conversation. The user can send the task back to rework from the issue panel; do not silently re-run anything yourself.`,
		issue.Title,
		task.TaskID,
		strings.TrimSpace(task.Title),
		reason,
	)
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
