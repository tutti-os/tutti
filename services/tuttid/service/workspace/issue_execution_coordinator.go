package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// IssueExecutionCoordinator is the product-owned seam between durable Issue
// execution facts and Agent lifecycle operations. Issue Manager remains the
// owner of task/run state; this coordinator maps user intent and settled Agent
// facts into short, independently locked Issue commands.
type IssueExecutionCoordinator struct {
	Issues              *IssueManagerService
	RunSessionCanceller IssueRunSessionCanceller
	SettlementReader    IssueRunSettlementReader
}

// CancelIssueExecution stops an Issue's execution as one user intent: it
// durably pauses future dispatch first (so no successor can slip in), cancels
// the live agent turn of every running run's session, and settles those runs
// as canceled. Settlement here is deterministic — the turn-cancel fan-out
// would eventually settle the runs too, but stop must not depend on an
// asynchronous observer. Repeating the call is idempotent.
func (c *IssueExecutionCoordinator) CancelIssueExecution(ctx context.Context, workspaceID string, issueID string) (int, error) {
	if c == nil || c.Issues == nil {
		return 0, workspaceissues.ErrInvalidArgument
	}
	running, err := c.Issues.pauseIssueExecution(ctx, workspaceID, issueID)
	if err != nil {
		return 0, err
	}
	canceled := 0
	cancelErrors := make([]error, 0)
	for _, run := range running {
		gate := c.Issues.runLaunchGate()
		launching := gate.requestCancel(workspaceID, run.RunID)
		if !launching {
			gate.clear(workspaceID, run.RunID)
		}
		var result IssueRunCancelResult
		if c.RunSessionCanceller != nil && strings.TrimSpace(run.AgentSessionID) != "" {
			var cancelErr error
			result, cancelErr = c.RunSessionCanceller.RequestRunCancellation(ctx, IssueRunCancellationRequest{
				WorkspaceID:    workspaceID,
				AgentSessionID: run.AgentSessionID,
				RunID:          run.RunID,
			})
			if cancelErr != nil {
				slog.Warn("cancel Issue run agent session failed",
					"event", "workspace_issue.run_session_cancel_failed",
					"workspace_id", workspaceID,
					"issue_id", issueID,
					"run_id", run.RunID,
					"agent_session_id", run.AgentSessionID,
					"error", cancelErr,
				)
				cancelErrors = append(cancelErrors, fmt.Errorf("cancel run %s: %w", run.RunID, cancelErr))
				c.Issues.enqueueWorkspaceRunReconcile(workspaceID)
				continue
			}
			switch result.State {
			case IssueRunCancelAccepted:
				// The exact Agent Turn settlement owns the outcome. Queue
				// recovery in case projection delivery was delayed.
				c.Issues.enqueueWorkspaceRunReconcile(workspaceID)
				continue
			case IssueRunCancelCanceled:
				if result.Settlement == nil {
					result.Settlement = &IssueRunSettlement{
						WorkspaceID:    workspaceID,
						AgentSessionID: run.AgentSessionID,
						Status:         workspaceissues.StatusCanceled,
					}
				}
			case IssueRunCancelSettled:
				if result.Settlement == nil {
					cancelErrors = append(cancelErrors, fmt.Errorf("cancel run %s: settled result omitted settlement", run.RunID))
					continue
				}
			case IssueRunCancelNotFound:
				// The launch gate now owns the pending intent. If launch has
				// not begun it will be skipped; if it is in flight, completion
				// performs exact-turn compensation.
				continue
			default:
				cancelErrors = append(cancelErrors, fmt.Errorf("cancel run %s: unsupported cancellation result %q", run.RunID, result.State))
				continue
			}
		} else {
			cancelErrors = append(cancelErrors, fmt.Errorf("cancel run %s: agent session canceller is unavailable", run.RunID))
			continue
		}
		if result.Settlement == nil {
			cancelErrors = append(cancelErrors, fmt.Errorf("cancel run %s: authoritative result omitted settlement", run.RunID))
			continue
		}
		if _, err := c.Issues.CompleteRun(ctx, workspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
			Status:                   string(result.Settlement.Status),
			ErrorMessage:             result.Settlement.ErrorMessage,
			Usage:                    result.Settlement.Usage,
			RemainingQuotaPercent:    result.Settlement.RemainingQuotaPercent,
			HasRemainingQuotaPercent: result.Settlement.HasRemainingQuotaPercent,
		}); err != nil {
			slog.Warn("settle canceled Issue run failed",
				"event", "workspace_issue.run_cancel_settle_failed",
				"workspace_id", workspaceID,
				"issue_id", issueID,
				"run_id", run.RunID,
				"error", err,
			)
			cancelErrors = append(cancelErrors, fmt.Errorf("settle canceled run %s: %w", run.RunID, err))
			continue
		}
		if result.Settlement.Status == workspaceissues.StatusCanceled {
			canceled++
		}
	}
	c.Issues.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: workspaceID,
		IssueID:     issueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
	return canceled, errors.Join(cancelErrors...)
}

func (s IssueManagerService) pauseIssueExecution(ctx context.Context, workspaceID string, issueID string) ([]workspaceissues.Run, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	defer unlock()
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	if !detail.Issue.DispatchPaused {
		issue := detail.Issue
		issue.DispatchPaused = true
		if _, err := s.Store.UpdateIssue(ctx, issue); err != nil {
			return nil, err
		}
	}
	allRunning, err := s.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return nil, err
	}
	running := make([]workspaceissues.Run, 0, len(allRunning))
	for _, run := range allRunning {
		if run.IssueID == issueID {
			running = append(running, run)
		}
	}
	return running, nil
}

// CancelIssueExecutionForSourceSession stops every running tutti-mode-plan
// Issue that the given planning session created. It backs the user's stop
// gesture on the planning conversation: stopping the orchestrator stops all
// work in flight.
func (c *IssueExecutionCoordinator) CancelIssueExecutionForSourceSession(ctx context.Context, workspaceID string, agentSessionID string) (int, error) {
	if c == nil || c.Issues == nil {
		return 0, workspaceissues.ErrInvalidArgument
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return 0, nil
	}
	running, err := c.Issues.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
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
		detail, err := c.Issues.domainService().GetIssueDetail(ctx, workspaceID, issueID)
		if err != nil ||
			detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
			strings.TrimSpace(detail.Issue.SourceSessionID) != agentSessionID {
			continue
		}
		count, cancelErr := c.CancelIssueExecution(ctx, workspaceID, issueID)
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
func (c *IssueExecutionCoordinator) ObserveUserTurnCanceled(ctx context.Context, workspaceID string, agentSessionID string) {
	if _, err := c.CancelIssueExecutionForSourceSession(ctx, workspaceID, agentSessionID); err != nil {
		slog.Warn("issue execution cascade on turn cancel failed",
			"event", "workspace_issue.turn_cancel_cascade_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"error", err,
		)
	}
}
