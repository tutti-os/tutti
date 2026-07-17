package workspace

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

type agentSessionCreator interface {
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
}

// Keep automatic parallelism finite even when a plan contains many independent
// roots. The limit is workspace-wide across Issue runs; in-flight work is
// counted before every dispatch pass.
const maxWorkspaceParallelIssueRuns = 4

// dispatchEligibleIssueTasks advances one sequential Task or every isolated,
// dependency-ready parallel Task. The user's execution choice is durable on
// the Issue, and dependency, acceptance, and budget checks are repeated at the
// daemon boundary before every launch.
func (s IssueManagerService) dispatchEligibleIssueTasks(ctx context.Context, workspaceID, issueID string) {
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
	for _, task := range detail.Tasks {
		switch task.Status {
		case workspaceissues.StatusFailed:
			return
		case workspaceissues.StatusRunning, workspaceissues.StatusPendingAcceptance:
			if detail.Issue.SequentialExecution {
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
	parallelSlots := 1
	if detail.Issue.ParallelExecution {
		parallelSlots = min(maxWorkspaceParallelIssueRuns-len(running), budgetSlots)
		if parallelSlots <= 0 {
			return
		}
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
		s.startIssueTask(ctx, detail.Issue, task)
		if detail.Issue.SequentialExecution {
			return
		}
		parallelSlots--
		if parallelSlots <= 0 {
			return
		}
	}
}

func (s IssueManagerService) startIssueTask(ctx context.Context, issue workspaceissues.Issue, task workspaceissues.Task) {
	agentSessionID := uuid.NewString()
	runID := uuid.NewString()
	executionDirectory := strings.TrimSpace(task.ExecutionDirectory)
	if executionDirectory == "" && s.AgentSessionReader != nil && strings.TrimSpace(issue.SourceSessionID) != "" {
		if source, ok := s.AgentSessionReader.GetSession(issue.WorkspaceID, issue.SourceSessionID); ok {
			executionDirectory = strings.TrimSpace(source.Cwd)
		}
	}
	run, err := s.CreateRun(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, CreateIssueManagerRunInput{
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
	var collaborationRunID string
	if s.CollaborationRuns != nil {
		collaborationRun, collaborationErr := s.CollaborationRuns.RecordRun(ctx, collabrunservice.RecordRunInput{
			WorkspaceID:         issue.WorkspaceID,
			Mode:                string(collabrunbiz.ModeDelegate),
			SourceSessionID:     issue.SourceSessionID,
			TargetSessionID:     agentSessionID,
			TargetAgentTargetID: task.AgentTargetID,
			ModelPlanID:         task.ModelPlanID,
			Model:               task.Model,
			ContextScope:        "task_brief",
			TriggerSource:       string(collabrunbiz.TriggerUser),
			TriggerReason:       "issue:" + issue.IssueID + "/task:" + task.TaskID + "/run:" + run.RunID,
		})
		if collaborationErr != nil {
			_, _ = s.CompleteRun(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, run.RunID, CompleteIssueManagerRunInput{
				Status:       string(workspaceissues.StatusFailed),
				ErrorMessage: collaborationErr.Error(),
			})
			return
		}
		collaborationRunID = collaborationRun.ID
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
		AutomationRuleOverride: s.issueAutomationRuleOverride(
			ctx,
			issue.WorkspaceID,
			agentSessionID,
			issue.ExecutionProfile.OrchestrationIntensity,
		),
		InitialContent: []agentservice.PromptContentBlock{{Type: "text", Text: sequentialTaskPrompt(issue, task, executionDirectory)}},
		ClientSubmitID: "issue-run:" + run.RunID,
		Metadata: map[string]any{
			"collaborationRunId": collaborationRunID,
		},
		Title:       &title,
		Cwd:         cwd,
		Model:       model,
		ModelPlanID: modelPlanID,
		Visible:     boolPointerValue(true),
	})
	if err == nil {
		return
	}
	if s.CollaborationRuns != nil && collaborationRunID != "" {
		_, _ = s.CollaborationRuns.SettleRun(ctx, issue.WorkspaceID, collaborationRunID, collabrunservice.SettleRunInput{
			Status:        string(collabrunbiz.StatusFailed),
			FailureReason: err.Error(),
		})
	}
	_, _ = s.CompleteRun(ctx, issue.WorkspaceID, issue.IssueID, task.TaskID, run.RunID, CompleteIssueManagerRunInput{
		Status:       string(workspaceissues.StatusFailed),
		ErrorMessage: err.Error(),
	})
}

func sequentialTaskPrompt(issue workspaceissues.Issue, task workspaceissues.Task, executionDirectory string) string {
	return fmt.Sprintf(`Execute this Issue task and report a concise result with validation evidence.

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
