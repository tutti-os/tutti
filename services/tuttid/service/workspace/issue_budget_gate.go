package workspace

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func issueAutomaticBudgetSlots(issue workspaceissues.Issue, activeRunCount int) int {
	return workspaceissues.IssueAutomaticBudgetSlots(issue, activeRunCount)
}

func (s IssueManagerService) markIssueBudgetSoftLimited(ctx context.Context, issue workspaceissues.Issue) {
	if issue.Budget.Status == workspaceissues.BudgetStatusSoftLimited || s.Store == nil {
		return
	}
	issue.Budget.Status = workspaceissues.BudgetStatusSoftLimited
	updated, err := s.Store.UpdateIssue(ctx, issue)
	if err != nil {
		return
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: updated.WorkspaceID,
		IssueID:     updated.IssueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
}
