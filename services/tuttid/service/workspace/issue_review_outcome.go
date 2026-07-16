package workspace

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

const maxIssueReviewSummaryChars = 16 * 1024

// RecordAutomationReviewOutcome projects the fixed review result onto the
// Issue task that owns the source Agent session. A passing automated review
// reaches auto_checked only; user_accepted remains an explicit user action.
// Ordinary Agent sessions simply have no matching Issue run and are ignored.
func (s IssueManagerService) RecordAutomationReviewOutcome(ctx context.Context, workspaceID string, agentSessionID string, resultText string, passed bool, verdictValid bool) error {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s.Store == nil || workspaceID == "" || agentSessionID == "" {
		return nil
	}
	// Store.ListRuns intentionally permits an empty Issue scope for
	// workspace-wide accounting/linkage lookups; the user-facing domain method
	// requires a concrete Issue parent.
	runs, err := s.Store.ListRuns(ctx, workspaceID, "", "")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if strings.TrimSpace(run.AgentSessionID) != agentSessionID {
			continue
		}
		task, err := s.Store.GetTask(ctx, workspaceID, run.IssueID, run.TaskID)
		if err != nil {
			return err
		}
		input := workspaceissues.UpdateTaskInput{
			WorkspaceID:          workspaceID,
			IssueID:              run.IssueID,
			TaskID:               run.TaskID,
			ActorUserID:          issueManagerLocalActorUserID,
			AcceptanceSummary:    boundedIssueReviewSummary(resultText),
			HasAcceptanceSummary: true,
		}
		if passed && verdictValid && task.AcceptanceState != workspaceissues.AcceptanceUserAccepted {
			input.AcceptanceState = string(workspaceissues.AcceptanceAutoChecked)
			input.HasAcceptanceState = true
		}
		updated, err := s.domainService().UpdateTask(ctx, input)
		if err != nil {
			return err
		}
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: updated.WorkspaceID,
			IssueID:     updated.IssueID,
			TaskID:      updated.TaskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskUpdated,
		})
		return nil
	}
	return nil
}

func boundedIssueReviewSummary(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxIssueReviewSummaryChars {
		return value
	}
	return strings.TrimSpace(value[:maxIssueReviewSummaryChars])
}
