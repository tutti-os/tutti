package workspace

import (
	"context"
	"log/slog"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// IssueRunSessionCanceller cancels the live agent turn of one run's delegate
// session. The method shape matches the collaboration canceller so hosts wire
// one adapter for both.
type IssueRunSessionCanceller interface {
	CancelTargetSession(ctx context.Context, workspaceID string, agentSessionID string) error
}

// CancelIssueExecution stops an Issue's execution as one user intent: it
// durably pauses future dispatch first (so no successor can slip in), cancels
// the live agent turn of every running run's session, and settles those runs
// as canceled. Settlement here is deterministic — the turn-cancel fan-out
// would eventually settle the runs too, but stop must not depend on an
// asynchronous observer. Repeating the call is idempotent.
func (s IssueManagerService) CancelIssueExecution(ctx context.Context, workspaceID string, issueID string) (int, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	defer unlock()
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		return 0, err
	}
	if !detail.Issue.DispatchPaused {
		issue := detail.Issue
		issue.DispatchPaused = true
		if _, err := s.Store.UpdateIssue(ctx, issue); err != nil {
			return 0, err
		}
	}
	running, err := s.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return 0, err
	}
	canceled := 0
	for _, run := range running {
		if run.IssueID != issueID {
			continue
		}
		if s.RunSessionCanceller != nil && strings.TrimSpace(run.AgentSessionID) != "" {
			if cancelErr := s.RunSessionCanceller.CancelTargetSession(ctx, workspaceID, run.AgentSessionID); cancelErr != nil {
				slog.Warn("cancel Issue run agent session failed",
					"event", "workspace_issue.run_session_cancel_failed",
					"workspace_id", workspaceID,
					"issue_id", issueID,
					"run_id", run.RunID,
					"agent_session_id", run.AgentSessionID,
					"error", cancelErr,
				)
			}
		}
		if _, err := s.completeRunLocked(ctx, workspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
			Status: string(workspaceissues.StatusCanceled),
		}); err != nil {
			slog.Warn("settle canceled Issue run failed",
				"event", "workspace_issue.run_cancel_settle_failed",
				"workspace_id", workspaceID,
				"issue_id", issueID,
				"run_id", run.RunID,
				"error", err,
			)
			continue
		}
		canceled++
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: workspaceID,
		IssueID:     issueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
	return canceled, nil
}

// CancelIssueExecutionForSourceSession stops every running tutti-mode-plan
// Issue that the given planning session created. It backs the user's stop
// gesture on the planning conversation: stopping the orchestrator stops all
// work in flight.
func (s IssueManagerService) CancelIssueExecutionForSourceSession(ctx context.Context, workspaceID string, agentSessionID string) (int, error) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return 0, nil
	}
	running, err := s.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return 0, err
	}
	issueIDs := make([]string, 0, len(running))
	seen := make(map[string]struct{}, len(running))
	for _, run := range running {
		if _, exists := seen[run.IssueID]; exists {
			continue
		}
		seen[run.IssueID] = struct{}{}
		issueIDs = append(issueIDs, run.IssueID)
	}
	canceled := 0
	for _, issueID := range issueIDs {
		detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
		if err != nil ||
			detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
			strings.TrimSpace(detail.Issue.SourceSessionID) != agentSessionID {
			continue
		}
		count, cancelErr := s.CancelIssueExecution(ctx, workspaceID, issueID)
		if cancelErr != nil {
			slog.Warn("cancel Issue execution for source session failed",
				"event", "workspace_issue.source_session_cancel_failed",
				"workspace_id", workspaceID,
				"issue_id", issueID,
				"agent_session_id", agentSessionID,
				"error", cancelErr,
			)
			continue
		}
		canceled += count
	}
	return canceled, nil
}

// ObserveUserTurnCanceled implements the agent service's turn-cancel
// observer: a user stopping the planning conversation stops every running
// task of the plans that conversation orchestrates. Sessions that are not a
// tutti-mode-plan source are a no-op, so cascaded child-session cancels
// cannot loop.
func (s IssueManagerService) ObserveUserTurnCanceled(ctx context.Context, workspaceID string, agentSessionID string) {
	if _, err := s.CancelIssueExecutionForSourceSession(ctx, workspaceID, agentSessionID); err != nil {
		slog.Warn("issue execution cascade on turn cancel failed",
			"event", "workspace_issue.turn_cancel_cascade_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"error", err,
		)
	}
}
