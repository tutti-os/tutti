package workspace

import (
	"context"
	"errors"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// RecoverEligibleIssueDispatches retries automatic dispatch frontiers after a
// transient context-ref or store read error. Startup and the durable workspace
// recovery queue call this, so a failed attachment lookup cannot strand an
// otherwise eligible sequential Issue indefinitely.
func (s IssueManagerService) RecoverEligibleIssueDispatches(ctx context.Context, workspaceID string) error {
	topics, err := s.domainService().ListTopics(ctx, workspaceID)
	if err != nil {
		return err
	}
	var recoveryErr error
	for _, topic := range topics.Items {
		issues, err := s.domainService().ListIssues(ctx, workspaceissues.IssueListFilter{
			WorkspaceID: workspaceID,
			TopicID:     topic.TopicID,
			ReturnAll:   true,
		})
		if err != nil {
			recoveryErr = errors.Join(recoveryErr, err)
			continue
		}
		for _, issue := range issues.Items {
			if issue.DispatchPaused ||
				(!issue.SequentialExecution && !issue.ParallelExecution) ||
				issue.PlanningSource == workspaceissues.PlanningSourceTuttiModePlan {
				continue
			}
			recoveryErr = errors.Join(recoveryErr, s.dispatchEligibleIssueTasks(ctx, workspaceID, issue.IssueID))
		}
	}
	return recoveryErr
}
