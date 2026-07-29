package workspace

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

// Run lifecycle: create and settle. Tutti-mode checkpoint wakes are durable
// execution-service operations, not Issue-service notifications.

func (s IssueManagerService) ListRuns(ctx context.Context, workspaceID string, issueID string, taskID string) ([]workspaceissues.Run, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	return s.domainService().ListRuns(ctx, workspaceID, issueID, taskID)
}

func (s IssueManagerService) CreateRun(ctx context.Context, workspaceID string, issueID string, taskID string, input CreateIssueManagerRunInput) (workspaceissues.Run, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	run, err := s.createRunLocked(ctx, workspaceID, issueID, taskID, input)
	unlock()
	if err != nil {
		return workspaceissues.Run{}, err
	}
	s.publishRunCreated(ctx, run)
	return run, nil
}

func (s IssueManagerService) createRunLocked(ctx context.Context, workspaceID string, issueID string, taskID string, input CreateIssueManagerRunInput) (workspaceissues.Run, error) {
	run, err := s.domainService().CreateRun(ctx, workspaceissues.CreateRunInput{
		RunID:              input.RunID,
		TaskID:             taskID,
		IssueID:            issueID,
		WorkspaceID:        workspaceID,
		ActorUserID:        issueManagerLocalActorUserID,
		AgentTargetID:      input.AgentTargetID,
		AgentProvider:      input.AgentProvider,
		AgentUserID:        input.AgentUserID,
		AgentSessionID:     input.AgentSessionID,
		ExecutionDirectory: input.ExecutionDirectory,
		ModelPlanID:        input.ModelPlanID,
		Model:              input.Model,
	})
	if err != nil {
		return workspaceissues.Run{}, err
	}
	return run, nil
}

func (s IssueManagerService) publishRunCreated(ctx context.Context, run workspaceissues.Run) {
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCreated,
	})
	s.enqueueWorkspaceRunReconcile(run.WorkspaceID)
}

func (s IssueManagerService) GetRunDetail(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) (workspaceissues.RunDetail, error) {
	return s.domainService().GetRunDetail(ctx, workspaceID, issueID, taskID, runID)
}

func (s IssueManagerService) CompleteRun(ctx context.Context, workspaceID string, issueID string, taskID string, runID string, input CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	detail, effects, err := s.completeRunLocked(ctx, workspaceID, issueID, taskID, runID, input)
	unlock()
	if err != nil {
		return workspaceissues.RunDetail{}, err
	}
	s.applyRunCompletionEffects(ctx, detail.Run, effects)
	return detail, nil
}

type issueRunCompletionEffects struct {
	autoAccepted bool
	tuttiManaged bool
}

func (s IssueManagerService) completeRunLocked(ctx context.Context, workspaceID string, issueID string, taskID string, runID string, input CompleteIssueManagerRunInput) (workspaceissues.RunDetail, issueRunCompletionEffects, error) {
	issue, issueErr := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if issueErr != nil {
		return workspaceissues.RunDetail{}, issueRunCompletionEffects{}, issueErr
	}
	tuttiManaged := issue.Issue.PlanningSource == workspaceissues.PlanningSourceTuttiModePlan
	run, outputs, err := s.domainService().CompleteRun(ctx, workspaceissues.CompleteRunInput{
		RunID:                    runID,
		TaskID:                   taskID,
		IssueID:                  issueID,
		WorkspaceID:              workspaceID,
		ActorUserID:              issueManagerLocalActorUserID,
		Status:                   input.Status,
		Summary:                  input.Summary,
		ErrorMessage:             input.ErrorMessage,
		Outputs:                  input.Outputs,
		Usage:                    input.Usage,
		RemainingQuotaPercent:    input.RemainingQuotaPercent,
		HasRemainingQuotaPercent: input.HasRemainingQuotaPercent,
	})
	if err != nil {
		return workspaceissues.RunDetail{}, issueRunCompletionEffects{}, err
	}
	// A task the plan review marked auto-accept skips the human gate: its
	// successful completion is accepted programmatically, which advances
	// dispatch and the whole-issue completion check through the same path a
	// manual acceptance takes. Either way the planning conversation is woken
	// with the settled result so the planning agent orchestrates what happens
	// next instead of the daemon silently chaining tasks.
	if run.Status == workspaceissues.StatusCompleted {
		autoAccepted := false
		if !tuttiManaged {
			if taskDetail, taskErr := s.domainService().GetTaskDetail(ctx, workspaceID, issueID, taskID); taskErr == nil &&
				taskDetail.Task.AutoAccept && taskDetail.Task.Status == workspaceissues.StatusPendingAcceptance {
				if _, acceptErr := s.updateTaskLocked(ctx, workspaceID, issueID, taskID, UpdateIssueManagerTaskInput{
					Status:    string(workspaceissues.StatusCompleted),
					HasStatus: true,
				}); acceptErr == nil {
					autoAccepted = true
				}
			}
		}
		if err := s.ensureTuttiModeRunSettlement(ctx, run, tuttiManaged); err != nil {
			return workspaceissues.RunDetail{}, issueRunCompletionEffects{}, err
		}
		return workspaceissues.RunDetail{Run: run, Outputs: outputs}, issueRunCompletionEffects{
			autoAccepted: autoAccepted,
			tuttiManaged: tuttiManaged,
		}, nil
	}
	if err := s.ensureTuttiModeRunSettlement(ctx, run, tuttiManaged); err != nil {
		return workspaceissues.RunDetail{}, issueRunCompletionEffects{}, err
	}
	return workspaceissues.RunDetail{Run: run, Outputs: outputs}, issueRunCompletionEffects{
		tuttiManaged: tuttiManaged,
	}, nil
}

func (s IssueManagerService) ensureTuttiModeRunSettlement(
	ctx context.Context,
	run workspaceissues.Run,
	tuttiManaged bool,
) error {
	if !tuttiManaged {
		return nil
	}
	if s.TuttiModeExecutions == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	_, _, err := s.TuttiModeExecutions.EnsureRunSettlement(ctx, executionbiz.RunSettlement{
		WorkspaceID: run.WorkspaceID, IssueID: run.IssueID,
		TaskID: run.TaskID, RunID: run.RunID, Status: run.Status,
	})
	return err
}

// applyRunCompletionEffects performs every cross-domain or potentially
// re-entrant side effect after the Issue mutation lock has been released.
func (s IssueManagerService) applyRunCompletionEffects(ctx context.Context, run workspaceissues.Run, effects issueRunCompletionEffects) {
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCompleted,
	})
	if effects.tuttiManaged {
		// Durable checkpoint/wake workers own Tutti-mode orchestration. Never
		// enter the generic auto-dispatch or in-memory notifier paths.
		s.enqueueWorkspaceRunReconcile(run.WorkspaceID)
		return
	}
	if run.Status == workspaceissues.StatusCompleted {
		if effects.autoAccepted {
			s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
				WorkspaceID: run.WorkspaceID,
				IssueID:     run.IssueID,
				TaskID:      run.TaskID,
				ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskUpdated,
			})
			s.dispatchEligibleIssueTasks(ctx, run.WorkspaceID, run.IssueID)
		}
	}
	// Parallel Issues keep their bounded workspace slots full as independent
	// runs settle. Sequential successors still remain gated on user acceptance.
	if !effects.autoAccepted {
		s.dispatchEligibleIssueTasks(ctx, run.WorkspaceID, run.IssueID)
	}
}
