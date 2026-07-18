package workspace

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

// Run lifecycle: create, settle, and the planning-conversation notifications
// that hand orchestration back to the source session.

func (s IssueManagerService) ListRuns(ctx context.Context, workspaceID string, issueID string, taskID string) ([]workspaceissues.Run, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	return s.domainService().ListRuns(ctx, workspaceID, issueID, taskID)
}

func (s IssueManagerService) CreateRun(ctx context.Context, workspaceID string, issueID string, taskID string, input CreateIssueManagerRunInput) (workspaceissues.Run, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	defer unlock()
	return s.createRunLocked(ctx, workspaceID, issueID, taskID, input)
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
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCreated,
	})
	s.enqueueWorkspaceRunReconcile(run.WorkspaceID)
	return run, nil
}

func (s IssueManagerService) GetRunDetail(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) (workspaceissues.RunDetail, error) {
	return s.domainService().GetRunDetail(ctx, workspaceID, issueID, taskID, runID)
}

func (s IssueManagerService) CompleteRun(ctx context.Context, workspaceID string, issueID string, taskID string, runID string, input CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	defer unlock()
	return s.completeRunLocked(ctx, workspaceID, issueID, taskID, runID, input)
}

func (s IssueManagerService) completeRunLocked(ctx context.Context, workspaceID string, issueID string, taskID string, runID string, input CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error) {
	// An idempotent replay of an already-terminal run must not re-fire the
	// planning-conversation notifications: their in-process dedupe does not
	// survive a daemon restart, and a stale wake would misreport a long-settled
	// run as fresh news.
	alreadySettled := false
	if runDetail, err := s.domainService().GetRunDetail(ctx, workspaceID, issueID, taskID, runID); err == nil {
		switch runDetail.Run.Status {
		case workspaceissues.StatusCompleted, workspaceissues.StatusFailed, workspaceissues.StatusCanceled:
			alreadySettled = true
		}
	}
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
		return workspaceissues.RunDetail{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCompleted,
	})
	// A task the plan review marked auto-accept skips the human gate: its
	// successful completion is accepted programmatically, which advances
	// dispatch and the whole-issue completion check through the same path a
	// manual acceptance takes. Either way the planning conversation is woken
	// with the settled result so the planning agent orchestrates what happens
	// next instead of the daemon silently chaining tasks.
	if run.Status == workspaceissues.StatusCompleted {
		autoAccepted := false
		if taskDetail, taskErr := s.domainService().GetTaskDetail(ctx, workspaceID, issueID, taskID); taskErr == nil &&
			taskDetail.Task.AutoAccept && taskDetail.Task.Status == workspaceissues.StatusPendingAcceptance {
			if _, acceptErr := s.updateTaskLocked(ctx, workspaceID, issueID, taskID, UpdateIssueManagerTaskInput{
				Status:    string(workspaceissues.StatusCompleted),
				HasStatus: true,
			}); acceptErr == nil {
				autoAccepted = true
			}
		}
		if !alreadySettled {
			s.notifyTuttiPlanIssueTaskSettledBestEffort(ctx, workspaceID, issueID, taskID, run, !autoAccepted)
		}
		if autoAccepted {
			return workspaceissues.RunDetail{Run: run, Outputs: outputs}, nil
		}
	}
	// A failed run freezes the dispatch frontier; the planning conversation
	// must hear about it instead of waiting in silence.
	if run.Status == workspaceissues.StatusFailed && !alreadySettled {
		s.notifyTuttiPlanIssueTaskFailedBestEffort(ctx, workspaceID, issueID, taskID, run)
	}
	// Parallel Issues keep their bounded workspace slots full as independent
	// runs settle. Sequential successors still remain gated on user acceptance.
	s.dispatchEligibleIssueTasksLocked(ctx, workspaceID, issueID)
	return workspaceissues.RunDetail{Run: run, Outputs: outputs}, nil
}

// notifyTuttiPlanIssueTaskSettledBestEffort wakes the planning conversation
// with one settled task result. It stays silent when the whole Issue just
// finished — the dedicated completion notification already hands control back
// — so the source session never receives two messages for one event.
func (s IssueManagerService) notifyTuttiPlanIssueTaskSettledBestEffort(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	run workspaceissues.Run,
	decisionNeeded bool,
) {
	if s.CompletionNotifier == nil {
		return
	}
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil ||
		detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(detail.Issue.SourceSessionID) == "" {
		return
	}
	allDone := len(detail.Tasks) > 0
	var settled *workspaceissues.Task
	for index, task := range detail.Tasks {
		if task.TaskID == taskID {
			settled = &detail.Tasks[index]
		}
		if task.Status == workspaceissues.StatusCanceled {
			continue
		}
		if task.Status != workspaceissues.StatusCompleted ||
			task.AcceptanceState != workspaceissues.AcceptanceUserAccepted {
			allDone = false
		}
	}
	if settled == nil || allDone {
		return
	}
	s.CompletionNotifier.NotifyTuttiPlanIssueTaskSettled(ctx, workspaceID, detail.Issue, *settled, run, detail.Tasks, decisionNeeded)
}

// notifyTuttiPlanIssueTaskFailedBestEffort reports a failed run of a
// tutti-mode-plan Issue task back to the source conversation. The notifier
// dedupes per run, so reconcile replays cannot spam the session.
func (s IssueManagerService) notifyTuttiPlanIssueTaskFailedBestEffort(ctx context.Context, workspaceID string, issueID string, taskID string, run workspaceissues.Run) {
	if s.CompletionNotifier == nil {
		return
	}
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil ||
		detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(detail.Issue.SourceSessionID) == "" {
		return
	}
	for _, task := range detail.Tasks {
		if task.TaskID == taskID {
			s.CompletionNotifier.NotifyTuttiPlanIssueTaskFailed(ctx, workspaceID, detail.Issue, task, run)
			return
		}
	}
}
