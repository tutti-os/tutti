package workspace

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type agentSessionCreator interface {
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
}

// Keep automatic parallelism finite even when a plan contains many independent
// roots. The limit is workspace-wide across Issue runs; in-flight work is
// counted before every dispatch pass.
const maxWorkspaceParallelIssueRuns = 4

// dispatchEligibleIssueTasksLocked advances the Issue's execution frontier;
// the caller holds the Issue mutation lock. A sequential Issue runs one
// exclusive Task at a time, except that Tasks the plan review marked
// parallelizable may run alongside each other (each in an isolated per-run
// worktree when they share a checkout). A parallel Issue dispatches every
// isolated, dependency-ready Task. The user's execution choice is durable on
// the Issue, and dependency, acceptance, and budget checks are repeated at
// the daemon boundary before every launch.
func (s IssueManagerService) dispatchEligibleIssueTasksLocked(ctx context.Context, workspaceID, issueID string) {
	if s.AgentSessionCreator == nil {
		return
	}
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil || (!detail.Issue.SequentialExecution && !detail.Issue.ParallelExecution) || detail.Issue.DispatchPaused {
		return
	}
	if detail.Issue.Budget.Status != workspaceissues.BudgetStatusActive {
		return
	}
	inflight := 0
	for _, task := range detail.Tasks {
		switch task.Status {
		case workspaceissues.StatusFailed:
			return
		case workspaceissues.StatusRunning, workspaceissues.StatusPendingAcceptance:
			inflight++
			// A live exclusive task keeps the sequential Issue exclusive;
			// live parallelizable tasks only block other exclusive launches.
			if detail.Issue.SequentialExecution && !task.Parallelizable {
				return
			}
		}
	}
	running, err := s.domainService().ListRunningRuns(ctx, workspaceID, 1_000)
	if err != nil {
		return
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
		return
	}
	concurrentSlots := min(maxWorkspaceParallelIssueRuns-len(running), budgetSlots)
	if detail.Issue.ParallelExecution && concurrentSlots <= 0 {
		return
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
	launchedConcurrent := 0
	for _, task := range tasks {
		if task.Status != workspaceissues.StatusNotStarted || strings.TrimSpace(task.AgentTargetID) == "" {
			continue
		}
		ready := true
		for _, dependencyID := range task.DependencyTaskIDs {
			dependency, ok := byID[dependencyID]
			if !ok || dependency.Status != workspaceissues.StatusCompleted || dependency.AcceptanceState != workspaceissues.AcceptanceUserAccepted {
				ready = false
				break
			}
		}
		if !ready {
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
					s.startIssueTask(ctx, detail.Issue, task, issueTaskIsolation{}, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID))
				}
				return
			}
			if concurrentSlots <= 0 {
				return
			}
			s.startIssueTask(ctx, detail.Issue, task, isolation, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID))
			concurrentSlots--
			launchedConcurrent++
			continue
		}
		s.startIssueTask(ctx, detail.Issue, task, issueTaskIsolation{}, s.dependencyWorktreeOutputs(ctx, detail.Issue, task, byID))
		concurrentSlots--
		if concurrentSlots <= 0 {
			return
		}
	}
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

func (s IssueManagerService) startIssueTask(ctx context.Context, issue workspaceissues.Issue, task workspaceissues.Task, isolation issueTaskIsolation, dependencyOutputs []issueTaskDependencyOutput) {
	agentSessionID := uuid.NewString()
	runID := uuid.NewString()
	executionDirectory := s.resolveIssueTaskBaseDirectory(issue, task)
	worktreeBranch := ""
	worktreeBase := ""
	if isolation.worktreeBase != "" {
		worktreePath, branch, worktreeErr := s.createIssueTaskRunWorktree(ctx, isolation.worktreeBase, issue.IssueID, task.TaskID, runID)
		if worktreeErr != nil {
			// Surface the failed launch as a durable failed run, same as a
			// failed session creation, so the Issue shows why nothing ran.
			if run, err := s.createRunLocked(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, CreateIssueManagerRunInput{
				RunID:              runID,
				AgentTargetID:      task.AgentTargetID,
				AgentSessionID:     agentSessionID,
				ExecutionDirectory: executionDirectory,
				ModelPlanID:        task.ModelPlanID,
				Model:              task.Model,
			}); err == nil {
				_, _ = s.completeRunLocked(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, run.RunID, CompleteIssueManagerRunInput{
					Status:       string(workspaceissues.StatusFailed),
					ErrorMessage: worktreeErr.Error(),
				})
			}
			return
		}
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
		return
	}
	title := task.Title
	model := optionalTrimmedString(task.Model)
	modelPlanID := optionalTrimmedString(task.ModelPlanID)
	cwd := optionalTrimmedString(executionDirectory)
	// Task-level launch overrides recorded from the Tutti Mode plan review.
	// An explicit reasoning effort wins over the Issue-inherited intensity;
	// an explicit permission mode wins over the target's composer default.
	// The permission mode the user confirmed in the review panel must never
	// silently broaden: an unsupported/stale explicit mode fails the launch
	// (run lands failed) instead of degrading to the provider default, per
	// the unattended-automation StrictPermissionMode precedent.
	reasoningEffort := optionalTrimmedString(task.ReasoningEffort)
	permissionModeID := optionalTrimmedString(task.PermissionModeID)
	_, err = s.AgentSessionCreator.Create(ctx, issue.WorkspaceID, agentservice.CreateSessionInput{
		AgentSessionID:       agentSessionID,
		AgentTargetID:        task.AgentTargetID,
		ReasoningIntensity:   &run.ReasoningIntensity,
		ReasoningEffort:      reasoningEffort,
		PermissionModeID:     permissionModeID,
		StrictPermissionMode: permissionModeID != nil,
		InitialContent:       []agentservice.PromptContentBlock{{Type: "text", Text: issueTaskPrompt(issue, task, executionDirectory, worktreeBase, worktreeBranch, dependencyOutputs)}},
		ClientSubmitID:       "issue-run:" + run.RunID,
		Title:                &title,
		Cwd:                  cwd,
		Model:                model,
		ModelPlanID:          modelPlanID,
		Visible:              boolPointerValue(true),
	})
	if err == nil {
		return
	}
	_, _ = s.completeRunLocked(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, run.RunID, CompleteIssueManagerRunInput{
		Status:       string(workspaceissues.StatusFailed),
		ErrorMessage: err.Error(),
	})
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
	return prompt
}

func optionalTrimmedString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func boolPointerValue(value bool) *bool { return &value }

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
