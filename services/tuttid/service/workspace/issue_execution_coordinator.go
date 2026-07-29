package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

// IssueExecutionCoordinator is the product-owned seam between durable Issue
// execution facts and Agent lifecycle operations. Issue Manager remains the
// owner of task/run state; this coordinator maps user intent and settled Agent
// facts into short, independently locked Issue commands.
type IssueExecutionCoordinator struct {
	Issues              *IssueManagerService
	RunSessionCanceller IssueRunSessionCanceller
	SettlementReader    IssueRunSettlementReader
	Clock               func() time.Time
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
	return c.cancelIssueRuns(ctx, workspaceID, issueID, running)
}

// CancelTuttiModeIssueExecution is the product-authorized stop path for an
// Issue already proven to be owned by a Tutti execution. Generic Issue
// cancellation remains rejected for managed graphs.
func (c *IssueExecutionCoordinator) CancelTuttiModeIssueExecution(
	ctx context.Context, workspaceID string, issueID string,
) (int, error) {
	if c == nil || c.Issues == nil {
		return 0, workspaceissues.ErrInvalidArgument
	}
	running, err := c.Issues.pauseTuttiModeIssueExecution(ctx, workspaceID, issueID)
	if err != nil {
		return 0, err
	}
	return c.cancelIssueRuns(ctx, workspaceID, issueID, running)
}

func (c *IssueExecutionCoordinator) cancelIssueRuns(
	ctx context.Context,
	workspaceID string,
	issueID string,
	running []workspaceissues.Run,
) (int, error) {
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
			clientSubmitID, identityErr := c.Issues.issueRunClientSubmitID(ctx, run)
			if identityErr != nil {
				cancelErrors = append(cancelErrors, fmt.Errorf(
					"resolve cancel identity for run %s: %w", run.RunID, identityErr,
				))
				c.Issues.enqueueWorkspaceRunReconcile(workspaceID)
				continue
			}
			var cancelErr error
			result, cancelErr = c.RunSessionCanceller.RequestRunCancellation(ctx, IssueRunCancellationRequest{
				WorkspaceID:    workspaceID,
				AgentSessionID: run.AgentSessionID,
				RunID:          run.RunID,
				ClientSubmitID: clientSubmitID,
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
				if launching {
					// The in-flight launch gate owns exact-turn compensation
					// once canonical delivery becomes observable.
					continue
				}
				// No launch owns this prepared Run, so the product can settle
				// it immediately instead of leaving archive recovery blocked
				// on a Run that never acquired a canonical Agent Turn.
				result.Settlement = &IssueRunSettlement{
					WorkspaceID: workspaceID, AgentSessionID: run.AgentSessionID,
					Status: workspaceissues.StatusCanceled,
				}
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
	if err := workspaceissues.RejectManagedIssueMutation(detail.Issue); err != nil {
		return nil, err
	}
	if !detail.Issue.DispatchPaused {
		issue := detail.Issue
		issue.DispatchPaused = true
		if _, err := s.Store.UpdateIssue(ctx, issue); err != nil {
			return nil, err
		}
	}
	running := make([]workspaceissues.Run, 0, len(detail.RecentRuns))
	for _, run := range detail.RecentRuns {
		if run.Status == workspaceissues.StatusRunning {
			running = append(running, run)
		}
	}
	return running, nil
}

func (s IssueManagerService) pauseTuttiModeIssueExecution(
	ctx context.Context, workspaceID string, issueID string,
) ([]workspaceissues.Run, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	defer unlock()
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	if detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan {
		return nil, workspaceissues.ErrInvalidArgument
	}
	if !detail.Issue.DispatchPaused {
		issue := detail.Issue
		issue.DispatchPaused = true
		if _, err := s.Store.UpdateIssue(ctx, issue); err != nil {
			return nil, err
		}
	}
	running := make([]workspaceissues.Run, 0, len(detail.RecentRuns))
	for _, run := range detail.RecentRuns {
		if run.Status == workspaceissues.StatusRunning {
			running = append(running, run)
		}
	}
	return running, nil
}

// CancelIssueExecutionForSourceSession durably archives every nonterminal
// Tutti execution owned by the planning session. Archive is the product's
// terminal stop boundary: it fences future dispatch before canceling Runs,
// main wakes, reviewers, checkpoints, and workflow recovery.
func (c *IssueExecutionCoordinator) CancelIssueExecutionForSourceSession(ctx context.Context, workspaceID string, agentSessionID string) (int, error) {
	if c == nil || c.Issues == nil || c.Issues.TuttiModeExecutions == nil {
		return 0, workspaceissues.ErrInvalidArgument
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return 0, nil
	}
	return c.Issues.TuttiModeExecutions.StopSourceSession(
		ctx,
		tuttimodeexecutionservice.StopSourceSessionInput{
			WorkspaceID: workspaceID, SourceSessionID: agentSessionID,
			RequestID: "source-session-stop", Reason: "source_turn_canceled",
		},
	)
}

// ObserveUserTurnCanceled implements the agent service's turn-cancel
// observer: a user stopping the planning conversation enters the durable
// source-session stop boundary. Sessions that are not a Tutti plan source are
// a no-op, so cascaded child-session cancels cannot loop.
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
