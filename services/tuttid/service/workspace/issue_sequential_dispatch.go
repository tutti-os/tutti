package workspace

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// Keep automatic parallelism finite even when a plan contains many independent
// roots. The limit is workspace-wide across Issue runs; in-flight work is
// counted before every dispatch pass.
const maxWorkspaceParallelIssueRuns = workspaceissues.MaxWorkspaceParallelRuns

// claimEligibleIssueRunsLocked advances the Issue's execution frontier and
// returns durable launch claims; the caller holds the Issue mutation lock.
// It never calls Agent Host. A sequential Issue runs one
// exclusive Task at a time, except that Tasks the plan review marked
// parallelizable may run alongside each other (each in an isolated per-run
// worktree when they share a checkout). A parallel Issue dispatches every
// isolated, dependency-ready Task. The user's execution choice is durable on
// the Issue, and dependency, acceptance, and budget checks are repeated at
// the daemon boundary before every launch.
func (s IssueManagerService) claimEligibleIssueRunsLocked(ctx context.Context, workspaceID, issueID string) []IssueRunLaunch {
	if s.RunLauncher == nil {
		return nil
	}
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil ||
		detail.Issue.PlanningSource == workspaceissues.PlanningSourceTuttiModePlan ||
		(!detail.Issue.SequentialExecution && !detail.Issue.ParallelExecution) ||
		detail.Issue.DispatchPaused {
		return nil
	}
	if detail.Issue.Budget.Status != workspaceissues.BudgetStatusActive {
		return nil
	}
	inflight := 0
	for _, task := range detail.Tasks {
		switch task.Status {
		case workspaceissues.StatusFailed:
			return nil
		case workspaceissues.StatusRunning, workspaceissues.StatusPendingAcceptance:
			inflight++
			// A live exclusive task keeps the sequential Issue exclusive;
			// live parallelizable tasks only block other exclusive launches.
			if detail.Issue.SequentialExecution && !task.Parallelizable {
				return nil
			}
		}
	}
	running, err := s.domainService().ListRunningRuns(ctx, workspaceID, 1_000)
	if err != nil {
		return nil
	}
	activeIssueRuns := 0
	for _, run := range running {
		if run.IssueID == issueID {
			activeIssueRuns++
		}
	}
	budgetSlots := issueAutomaticBudgetSlots(detail.Issue, activeIssueRuns)
	if budgetSlots <= 0 {
		s.markIssueBudgetSoftLimited(ctx, detail.Issue)
		return nil
	}
	concurrentSlots := workspaceissues.IssueAutomaticRunAdmissionSlots(
		detail.Issue,
		len(running),
		activeIssueRuns,
	)
	if detail.Issue.ParallelExecution && concurrentSlots <= 0 {
		return nil
	}
	tasks := append([]workspaceissues.Task(nil), detail.Tasks...)
	sort.SliceStable(tasks, func(i, j int) bool {
		if tasks[i].SortIndex == tasks[j].SortIndex {
			return tasks[i].ID < tasks[j].ID
		}
		return tasks[i].SortIndex < tasks[j].SortIndex
	})
	byID := make(map[string]workspaceissues.Task, len(tasks))
	for _, task := range tasks {
		byID[task.TaskID] = task
	}
	launches := make([]IssueRunLaunch, 0)
	launchedConcurrent := 0
	for _, task := range tasks {
		if !workspaceissues.IssueTaskEligibleForRun(task, byID) {
			continue
		}
		if detail.Issue.SequentialExecution {
			isolation := issueTaskIsolation{}
			concurrent := task.Parallelizable
			if concurrent {
				// A parallelizable task without a safe isolation story
				// degrades to exclusive dispatch instead of trampling.
				isolation, concurrent = s.sequentialTaskIsolation(detail.Issue, tasks, task)
			}
			if !concurrent {
				// Exclusive task: launch only into an idle Issue, and bar
				// everything behind it until it completes and is accepted.
				if inflight == 0 && launchedConcurrent == 0 {
					if launch, ok := s.claimIssueTaskRunLocked(ctx, detail.Issue, task, issueTaskIsolation{}, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID)); ok {
						launches = append(launches, launch)
					}
				}
				return launches
			}
			if concurrentSlots <= 0 {
				return launches
			}
			if launch, ok := s.claimIssueTaskRunLocked(ctx, detail.Issue, task, isolation, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID)); ok {
				launches = append(launches, launch)
			}
			concurrentSlots--
			launchedConcurrent++
			continue
		}
		if launch, ok := s.claimIssueTaskRunLocked(ctx, detail.Issue, task, issueTaskIsolation{}, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID)); ok {
			launches = append(launches, launch)
		}
		concurrentSlots--
		if concurrentSlots <= 0 {
			return launches
		}
	}
	return launches
}

// issueTaskDependencyOutput points a successor task at a prerequisite whose
// work landed on an isolated per-run worktree branch instead of the base
// checkout. Successor prompts carry these so parallel results never strand.
type issueTaskDependencyOutput struct {
	taskID       string
	title        string
	branch       string
	worktreePath string
}

// dependencyWorktreeOutputs collects the isolated-branch outputs of a task's
// direct dependencies. Dependencies that ran in the base checkout need no
// pointer: their work is already in the successor's working tree.
func (s IssueManagerService) dependencyWorktreeOutputs(
	ctx context.Context,
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	byID map[string]workspaceissues.Task,
) []issueTaskDependencyOutput {
	worktreeRoot := filepath.Join(s.taskWorktreeRoot(), issue.IssueID) + string(filepath.Separator)
	outputs := make([]issueTaskDependencyOutput, 0, len(task.DependencyTaskIDs))
	for _, dependencyID := range task.DependencyTaskIDs {
		dependency, ok := byID[dependencyID]
		if !ok || strings.TrimSpace(dependency.LatestRunID) == "" {
			continue
		}
		runDetail, err := s.domainService().GetRunDetail(ctx, issue.WorkspaceID, issue.IssueID, dependency.TaskID, dependency.LatestRunID)
		if err != nil {
			continue
		}
		executionDirectory := strings.TrimSpace(runDetail.Run.ExecutionDirectory)
		if !strings.HasPrefix(executionDirectory, worktreeRoot) {
			continue
		}
		outputs = append(outputs, issueTaskDependencyOutput{
			taskID:       dependency.TaskID,
			title:        dependency.Title,
			branch:       "tutti/task/" + filepath.Base(executionDirectory),
			worktreePath: executionDirectory,
		})
	}
	return outputs
}

func (s IssueManagerService) claimIssueTaskRunLocked(
	ctx context.Context,
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	isolation issueTaskIsolation,
	dependencyOutputs []issueTaskDependencyOutput,
) (IssueRunLaunch, bool) {
	agentSessionID := uuid.NewString()
	runID := uuid.NewString()
	executionDirectory := s.resolveIssueTaskBaseDirectory(issue, task)
	worktreeBranch := ""
	worktreeBase := ""
	if isolation.worktreeBase != "" {
		worktreePath, branch := s.issueTaskRunWorktreePlan(issue.IssueID, task.TaskID, runID)
		worktreeBase = isolation.worktreeBase
		worktreeBranch = branch
		executionDirectory = worktreePath
	}
	run, err := s.createRunLocked(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, CreateIssueManagerRunInput{
		RunID:              runID,
		AgentTargetID:      task.AgentTargetID,
		AgentSessionID:     agentSessionID,
		ExecutionDirectory: executionDirectory,
		ModelPlanID:        task.ModelPlanID,
		Model:              task.Model,
	})
	if err != nil {
		return IssueRunLaunch{}, false
	}
	return IssueRunLaunch{
		WorkspaceID:        issue.WorkspaceID,
		ClientSubmitID:     workspaceissues.IssueRunClientSubmitID(run.RunID),
		AgentSessionID:     agentSessionID,
		AgentTargetID:      task.AgentTargetID,
		RunID:              run.RunID,
		TaskID:             task.TaskID,
		IssueID:            issue.IssueID,
		Title:              task.Title,
		Prompt:             issueTaskPrompt(issue, task, executionDirectory, worktreeBase, worktreeBranch, dependencyOutputs),
		ExecutionDirectory: executionDirectory,
		ModelPlanID:        task.ModelPlanID,
		Model:              task.Model,
		ReasoningIntensity: run.ReasoningIntensity,
		ReasoningEffort:    task.ReasoningEffort,
		PermissionModeID:   task.PermissionModeID,
		WorktreeBase:       worktreeBase,
		WorktreeBranch:     worktreeBranch,
	}, true
}

func (s IssueManagerService) launchClaimedIssueRuns(ctx context.Context, launches []IssueRunLaunch) {
	for _, launch := range launches {
		s.deliverIssueRunLaunch(ctx, launch, issueRunLaunchDeliveryOutcomes{
			onGateBusy: func() {
				s.runLaunchGate().clear(launch.WorkspaceID, launch.RunID)
				_, _ = s.CompleteRun(ctx, launch.WorkspaceID, launch.IssueID, launch.TaskID, launch.RunID, CompleteIssueManagerRunInput{
					Status: string(workspaceissues.StatusCanceled),
				})
			},
			onRejected: func(decision issueRunLaunchDecision) {
				if decision == issueRunCancelClaim {
					_, _ = s.CompleteRun(ctx, launch.WorkspaceID, launch.IssueID, launch.TaskID, launch.RunID, CompleteIssueManagerRunInput{
						Status: string(workspaceissues.StatusCanceled),
					})
				}
			},
			onFailure: func(err error) {
				_, _ = s.CompleteRun(ctx, launch.WorkspaceID, launch.IssueID, launch.TaskID, launch.RunID, CompleteIssueManagerRunInput{
					Status:       string(workspaceissues.StatusFailed),
					ErrorMessage: err.Error(),
				})
			},
		})
	}
}

type issueRunLaunchDeliveryOutcomes struct {
	onGateBusy  func()
	onRejected  func(issueRunLaunchDecision)
	onFailure   func(error)
	onDelivered func()
}

// deliverIssueRunLaunch is the single deep delivery seam for generic and
// Tutti-owned Run claims. Claim persistence and terminal outcome policy stay
// strategy-specific; gate fencing, durable revalidation, worktree creation,
// Agent delivery, and post-launch cancellation are shared.
func (s IssueManagerService) deliverIssueRunLaunch(
	ctx context.Context,
	launch IssueRunLaunch,
	outcomes issueRunLaunchDeliveryOutcomes,
) {
	gate := s.runLaunchGate()
	if !gate.begin(launch.WorkspaceID, launch.RunID) {
		if outcomes.onGateBusy != nil {
			outcomes.onGateBusy()
		}
		return
	}
	decision := s.issueRunLaunchDecision(ctx, launch)
	if decision != issueRunLaunch {
		gate.finish(launch.WorkspaceID, launch.RunID)
		if outcomes.onRejected != nil {
			outcomes.onRejected(decision)
		}
		return
	}
	var err error
	if launch.WorktreeBase != "" {
		_, _, err = s.createIssueTaskRunWorktree(
			ctx,
			launch.WorktreeBase,
			launch.IssueID,
			launch.TaskID,
			launch.RunID,
		)
	}
	if err == nil {
		err = s.RunLauncher.Launch(ctx, launch)
	}
	if err != nil {
		if outcomes.onFailure != nil {
			outcomes.onFailure(err)
		}
		cancelRequested := gate.finish(launch.WorkspaceID, launch.RunID)
		if cancelRequested {
			s.cancelIssueRunAfterLaunch(ctx, launch)
		}
		return
	}
	if outcomes.onDelivered != nil {
		outcomes.onDelivered()
	}
	cancelRequested := gate.finish(launch.WorkspaceID, launch.RunID)
	if cancelRequested {
		s.cancelIssueRunAfterLaunch(ctx, launch)
	}
}

func (s IssueManagerService) cancelIssueRunAfterLaunch(ctx context.Context, launch IssueRunLaunch) {
	if s.prepareAndRecoverTuttiModeRunCancelCompensation(ctx, launch) {
		return
	}
	if s.RunCancellationRequester == nil {
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
		return
	}
	result, err := s.RunCancellationRequester.RequestRunCancellation(ctx, IssueRunCancellationRequest{
		WorkspaceID:    launch.WorkspaceID,
		AgentSessionID: launch.AgentSessionID,
		RunID:          launch.RunID,
		ClientSubmitID: launch.ClientSubmitID,
	})
	if err != nil {
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
		return
	}
	if result.Settlement != nil {
		s.applyIssueRunCancellationSettlement(ctx, launch.IssueID, launch.TaskID, launch.RunID, *result.Settlement)
		return
	}
	s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
}

func (s IssueManagerService) applyIssueRunCancellationSettlement(
	ctx context.Context,
	issueID string,
	taskID string,
	runID string,
	settlement IssueRunSettlement,
) {
	_, _ = s.CompleteRun(ctx, settlement.WorkspaceID, issueID, taskID, runID, CompleteIssueManagerRunInput{
		Status:                   string(settlement.Status),
		ErrorMessage:             settlement.ErrorMessage,
		Usage:                    settlement.Usage,
		RemainingQuotaPercent:    settlement.RemainingQuotaPercent,
		HasRemainingQuotaPercent: settlement.HasRemainingQuotaPercent,
	})
}

type issueRunLaunchDecision uint8

const (
	issueRunSkipLaunch issueRunLaunchDecision = iota
	issueRunLaunch
	issueRunCancelClaim
)

// issueRunLaunchDecision revalidates the durable claim while holding the Run
// operation fence. The Issue lock is held only for these local reads and is
// released before any worktree or Agent call.
func (s IssueManagerService) issueRunLaunchDecision(ctx context.Context, launch IssueRunLaunch) issueRunLaunchDecision {
	unlockIssue := s.MutationLocks.Lock(launch.WorkspaceID, launch.IssueID)
	defer unlockIssue()
	detail, err := s.domainService().GetIssueDetail(ctx, launch.WorkspaceID, launch.IssueID)
	if err != nil {
		return issueRunSkipLaunch
	}
	run, err := s.domainService().GetRunDetail(ctx, launch.WorkspaceID, launch.IssueID, launch.TaskID, launch.RunID)
	if err != nil || run.Run.Status != workspaceissues.StatusRunning {
		return issueRunSkipLaunch
	}
	if detail.Issue.DispatchPaused {
		return issueRunCancelClaim
	}
	return issueRunLaunch
}

func (s IssueManagerService) issueRunIsTerminal(
	ctx context.Context,
	launch IssueRunLaunch,
) (bool, error) {
	unlockIssue := s.MutationLocks.Lock(launch.WorkspaceID, launch.IssueID)
	defer unlockIssue()
	run, err := s.domainService().GetRunDetail(
		ctx, launch.WorkspaceID, launch.IssueID, launch.TaskID, launch.RunID,
	)
	if err != nil {
		return false, err
	}
	return run.Run.Status != workspaceissues.StatusRunning, nil
}

func issueTaskPrompt(issue workspaceissues.Issue, task workspaceissues.Task, executionDirectory string, worktreeBase string, worktreeBranch string, dependencyOutputs []issueTaskDependencyOutput) string {
	prompt := fmt.Sprintf(`Execute this Issue task and report a concise result with validation evidence.

Issue: %s
Issue plan:
%s

Task: %s
Task details:
%s

Working directory: %s

Do not mark the task finally accepted. Completion enters pending acceptance; only the user may accept it.`,
		issue.Title,
		issue.Content,
		task.Title,
		task.Content,
		firstNonEmptyText(executionDirectory, "."),
	)
	if worktreeBranch != "" {
		prompt += fmt.Sprintf(`

Isolation: your working directory is a dedicated git worktree of %s on branch %s; other tasks may run in parallel from the same checkout. Commit your work on this branch. Do not push, do not switch branches, and do not modify the base checkout.`,
			worktreeBase,
			worktreeBranch,
		)
	}
	if len(dependencyOutputs) > 0 {
		lines := make([]string, 0, len(dependencyOutputs))
		for _, output := range dependencyOutputs {
			lines = append(lines, fmt.Sprintf("- %s (%s): branch %s (worktree %s)", output.taskID, output.title, output.branch, output.worktreePath))
		}
		prompt += fmt.Sprintf(`

Dependency outputs: these prerequisite tasks ran in isolated worktrees, so their results are NOT in your working tree yet. Merge each branch below (same repository, e.g. `+"`git merge <branch>`"+`) and resolve any overlaps before building on their results:
%s`, strings.Join(lines, "\n"))
	}
	if issue.PlanningSource == workspaceissues.PlanningSourceTuttiModePlan {
		prompt += fmt.Sprintf(`

Tutti effect preference: %d/100. %s`,
			issue.ExecutionProfile.ReasoningIntensity,
			tuttiEffectValidationGuidance(issue.ExecutionProfile.ReasoningIntensity),
		)
	}
	return prompt
}

func tuttiEffectValidationGuidance(effect int) string {
	switch {
	case effect <= 33:
		return "Run at least one focused check that directly covers this task, and report the evidence."
	case effect <= 66:
		return "Run the relevant tests plus an integration check when applicable, and report the evidence."
	default:
		return "Run broad relevant tests, cover an edge or variant case, perform a final review, and report the evidence."
	}
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func parallelIssueTasksAreIsolated(tasks []CreateIssueManagerTaskItemInput) bool {
	seen := make(map[string]struct{}, len(tasks))
	for _, task := range tasks {
		if strings.TrimSpace(task.AgentTargetID) == "" {
			continue
		}
		directory := filepath.Clean(strings.TrimSpace(task.ExecutionDirectory))
		if directory == "." || !filepath.IsAbs(directory) {
			return false
		}
		if _, exists := seen[directory]; exists {
			return false
		}
		seen[directory] = struct{}{}
	}
	return true
}
