package workspace

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func (s IssueManagerService) applyVisibleIssueSubtaskCounts(ctx context.Context, list *workspaceissues.IssueList) error {
	if list == nil || len(list.Items) == 0 {
		return nil
	}

	service := s.domainService()
	for index := range list.Items {
		issue := &list.Items[index]
		tasks, err := service.ListTasks(ctx, workspaceissues.TaskListFilter{
			WorkspaceID: issue.WorkspaceID,
			IssueID:     issue.IssueID,
			ReturnAll:   true,
		})
		if err != nil {
			return err
		}
		runs, err := service.ListRuns(ctx, issue.WorkspaceID, issue.IssueID, "")
		if err != nil {
			return err
		}
		var latestRun *workspaceissues.Run
		if len(runs) > 0 {
			latestRun = &runs[0]
		}
		applyVisibleIssueSubtaskCount(issue, tasks.Items, latestRun)
	}
	return nil
}

func applyVisibleIssueSubtaskCount(issue *workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) {
	if issue == nil {
		return
	}
	counts := countVisibleIssueSubtaskStatuses(*issue, tasks, latestRun)
	issue.TaskCount = counts.All
	issue.NotStartedCount = counts.NotStarted
	issue.RunningCount = counts.Running
	issue.PendingAcceptanceCount = counts.PendingAcceptance
	issue.CompletedCount = counts.Completed + counts.PendingAcceptance
	issue.FailedCount = counts.Failed
	issue.CanceledCount = counts.Canceled
}

func countVisibleIssueSubtaskStatuses(issue workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) workspaceissues.StatusCounts {
	hiddenTaskID := hiddenIssueRunTaskID(issue, tasks, latestRun)
	var counts workspaceissues.StatusCounts
	for _, task := range tasks {
		if task.TaskID == hiddenTaskID {
			continue
		}
		incrementIssueManagerStatusCount(&counts, task.Status)
	}
	return counts
}

func hiddenIssueRunTaskID(issue workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) string {
	if latestRun == nil {
		return ""
	}
	taskID := strings.TrimSpace(latestRun.TaskID)
	if taskID == "" {
		return ""
	}
	issueTitle := strings.TrimSpace(issue.Title)
	for _, task := range tasks {
		if task.TaskID != taskID {
			continue
		}
		taskTitle := strings.TrimSpace(task.Title)
		if taskTitle != "" && taskTitle != issueTitle {
			return ""
		}
		return taskID
	}
	return ""
}

func incrementIssueManagerStatusCount(counts *workspaceissues.StatusCounts, status workspaceissues.Status) {
	counts.All++
	switch status {
	case workspaceissues.StatusNotStarted:
		counts.NotStarted++
	case workspaceissues.StatusRunning:
		counts.Running++
	case workspaceissues.StatusPendingAcceptance:
		counts.PendingAcceptance++
	case workspaceissues.StatusCompleted:
		counts.Completed++
	case workspaceissues.StatusFailed:
		counts.Failed++
	case workspaceissues.StatusCanceled:
		counts.Canceled++
	default:
		counts.NotStarted++
	}
}
