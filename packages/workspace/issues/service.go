package workspaceissues

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"path"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type IDKind string

const (
	IDKindTopic      IDKind = "topic"
	IDKindIssue      IDKind = "issue"
	IDKindTask       IDKind = "task"
	IDKindRun        IDKind = "run"
	IDKindRunOutput  IDKind = "run-output"
	IDKindContextRef IDKind = "context-ref"
)

type IDGenerator func(IDKind) string

type Clock func() time.Time

type Service struct {
	Clock       Clock
	IDGenerator IDGenerator
	Store       Store
}

type CreateIssueInput struct {
	IssueID             string
	TopicID             string
	WorkspaceID         string
	ActorUserID         string
	Title               string
	Content             string
	PlanningSource      string
	SourceSessionID     string
	SequentialExecution bool
	ParallelExecution   bool
	ExecutionProfile    ExecutionProfile
	HasExecutionProfile bool
	Budget              Budget
	HasBudget           bool
	// AutoTokenBudgetHistoryHint is the summed observed usage of comparable
	// completed task runs. It is ignored for fixed budgets.
	AutoTokenBudgetHistoryHint int64
}

type CreateIssueWithTasksInput struct {
	Issue CreateIssueInput
	Tasks []CreateTaskItemInput
}

type CreateIssueWithContextRefsInput struct {
	Issue CreateIssueInput
	Refs  []AddContextRefInput
}

type CreateTopicInput struct {
	TopicID     string
	WorkspaceID string
	ActorUserID string
	Title       string
	Summary     string
}

type UpdateTopicInput struct {
	TopicID     string
	WorkspaceID string
	ActorUserID string
	Title       string
	HasTitle    bool
	Summary     string
	HasSummary  bool
	Pinned      bool
	HasPinned   bool
}

type UpdateIssueInput struct {
	IssueID             string
	WorkspaceID         string
	ActorUserID         string
	Title               string
	HasTitle            bool
	Content             string
	HasContent          bool
	Status              string
	HasStatus           bool
	DispatchPaused      bool
	HasDispatchPaused   bool
	ExecutionProfile    ExecutionProfile
	HasExecutionProfile bool
	Budget              Budget
	HasBudget           bool
}

type CreateTaskInput struct {
	TaskID             string
	IssueID            string
	WorkspaceID        string
	ActorUserID        string
	Title              string
	Content            string
	Priority           string
	DueAtUnixMS        int64
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	PermissionModeID   string
	ReasoningEffort    string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	Parallelizable     bool
	AutoAccept         bool
}

type CreateTaskItemInput struct {
	TaskID             string
	Title              string
	Content            string
	Priority           string
	DueAtUnixMS        int64
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	PermissionModeID   string
	ReasoningEffort    string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	Parallelizable     bool
	AutoAccept         bool
}

type CreateTasksInput struct {
	IssueID     string
	WorkspaceID string
	ActorUserID string
	Tasks       []CreateTaskItemInput
}

type UpdateTaskInput struct {
	TaskID                string
	IssueID               string
	WorkspaceID           string
	ActorUserID           string
	Title                 string
	HasTitle              bool
	Content               string
	HasContent            bool
	Status                string
	HasStatus             bool
	Priority              string
	HasPriority           bool
	DueAtUnixMS           int64
	HasDueAt              bool
	SortIndex             int
	HasSortIndex          bool
	AgentTargetID         string
	HasAgentTargetID      bool
	ModelPlanID           string
	HasModelPlanID        bool
	Model                 string
	HasModel              bool
	ExecutionDirectory    string
	HasExecutionDirectory bool
	DependencyTaskIDs     []string
	HasDependencyTaskIDs  bool
	Parallelizable        bool
	HasParallelizable     bool
	AutoAccept            bool
	HasAutoAccept         bool
	AcceptanceState       string
	HasAcceptanceState    bool
	AcceptanceSummary     string
	HasAcceptanceSummary  bool
}

type CreateRunInput struct {
	RunID              string
	TaskID             string
	IssueID            string
	WorkspaceID        string
	ActorUserID        string
	AgentTargetID      string
	AgentProvider      string
	AgentUserID        string
	AgentSessionID     string
	ModelPlanID        string
	Model              string
	ExecutionDirectory string
}

type PreparedRun struct {
	Run       Run
	Task      Task
	TaskIsNew bool
	Issue     Issue
}

type CompleteRunOutputInput struct {
	OutputID    string
	Path        string
	DisplayName string
	MediaType   string
	SizeBytes   int64
}

type CompleteRunInput struct {
	RunID                    string
	TaskID                   string
	IssueID                  string
	WorkspaceID              string
	ActorUserID              string
	Status                   string
	Summary                  string
	ErrorMessage             string
	Outputs                  []CompleteRunOutputInput
	Usage                    TokenUsage
	RemainingQuotaPercent    float64
	HasRemainingQuotaPercent bool
}

type AddContextRefsInput struct {
	WorkspaceID string
	IssueID     string
	TaskID      string
	ParentKind  string
	Refs        []AddContextRefInput
}

type RemoveContextRefInput struct {
	WorkspaceID  string
	IssueID      string
	TaskID       string
	ParentKind   string
	ContextRefID string
}

type AddContextRefInput struct {
	ContextRefID string
	RefType      string
	Path         string
	DisplayName  string
}

func (s Service) ListRuns(ctx context.Context, workspaceID string, issueID string, taskID string) ([]Run, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	taskID = strings.TrimSpace(taskID)
	if workspaceID == "" || issueID == "" {
		return nil, ErrInvalidArgument
	}
	if err := ensureRunParentExists(ctx, store, workspaceID, issueID, taskID); err != nil {
		return nil, err
	}
	return store.ListRuns(ctx, workspaceID, issueID, taskID)
}

func (s Service) ListRunningRuns(ctx context.Context, workspaceID string, limit int) ([]Run, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	return store.ListRunningRuns(ctx, workspaceID, limit)
}

func (s Service) GetRunDetail(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) (RunDetail, error) {
	store, err := s.store()
	if err != nil {
		return RunDetail{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	taskID = strings.TrimSpace(taskID)
	runID = strings.TrimSpace(runID)
	if workspaceID == "" || issueID == "" || runID == "" {
		return RunDetail{}, ErrInvalidArgument
	}
	if err := ensureRunParentExists(ctx, store, workspaceID, issueID, taskID); err != nil {
		return RunDetail{}, err
	}
	if taskID == "" {
		resolvedTaskID, err := findIssueRunTaskID(ctx, store, workspaceID, issueID, runID)
		if err != nil {
			return RunDetail{}, err
		}
		taskID = resolvedTaskID
	}
	run, err := store.GetRun(ctx, workspaceID, issueID, taskID, runID)
	if err != nil {
		return RunDetail{}, err
	}
	outputs, err := store.ListRunOutputs(ctx, workspaceID, issueID, taskID, runID)
	if err != nil {
		return RunDetail{}, err
	}
	return RunDetail{
		Run:     run,
		Outputs: outputs,
	}, nil
}

func (s Service) CreateRun(ctx context.Context, input CreateRunInput) (Run, error) {
	store, err := s.store()
	if err != nil {
		return Run{}, err
	}
	prepared, err := s.PrepareRun(ctx, input)
	if err != nil {
		return Run{}, err
	}
	if prepared.TaskIsNew {
		createdTasks, err := store.AppendTasks(ctx, []Task{prepared.Task})
		if err != nil {
			return Run{}, err
		}
		if len(createdTasks) != 1 {
			return Run{}, ErrInvalidArgument
		}
		prepared.Task = createdTasks[0]
	}
	created, err := store.CreateRun(ctx, prepared.Run)
	if err != nil {
		return Run{}, err
	}
	task := prepared.Task
	task.Status = StatusRunning
	// A fresh run is a new Agent completion claim; any earlier acceptance
	// verdict or review evidence belongs to the previous run.
	task.AcceptanceState = AcceptanceAgentClaimed
	task.AcceptanceSummary = ""
	task.LatestRunID = created.RunID
	task.UpdatedAtUnixMS = prepared.Run.UpdatedAtUnixMS
	if _, err := store.UpdateTask(ctx, task); err != nil {
		return Run{}, err
	}
	if _, err := store.RecalculateIssueProjection(ctx, prepared.Run.WorkspaceID, prepared.Run.IssueID); err != nil {
		return Run{}, err
	}
	if err := store.TouchTopicActivity(ctx, prepared.Run.WorkspaceID, prepared.Issue.TopicID, prepared.Run.UpdatedAtUnixMS); err != nil {
		return Run{}, err
	}
	return created, nil
}

// PrepareRun validates and normalizes a Run without claiming it durably. A
// product adapter uses this before atomically committing the Run and a durable
// external-launch intent in one transaction.
func (s Service) PrepareRun(ctx context.Context, input CreateRunInput) (PreparedRun, error) {
	store, err := s.store()
	if err != nil {
		return PreparedRun{}, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	taskID := strings.TrimSpace(input.TaskID)
	actorUserID := strings.TrimSpace(input.ActorUserID)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	agentProvider := strings.ToLower(strings.TrimSpace(input.AgentProvider))
	if workspaceID == "" || issueID == "" || actorUserID == "" {
		return PreparedRun{}, ErrInvalidArgument
	}
	issue, task, err := getRunParent(ctx, store, workspaceID, issueID, taskID)
	if err != nil {
		return PreparedRun{}, err
	}
	if err := RejectManagedIssueMutation(issue); err != nil {
		return PreparedRun{}, err
	}
	taskIsNew := false
	if task == nil {
		preparedTask, preparedTaskIsNew, err := s.prepareIssueRunTask(ctx, store, issue, actorUserID)
		if err != nil {
			return PreparedRun{}, err
		}
		task = &preparedTask
		taskIsNew = preparedTaskIsNew
		taskID = task.TaskID
	}
	if !IssueBudgetAllowsNextAutomaticRun(issue) {
		return PreparedRun{}, ErrIssueBudgetSoftLimited
	}
	if !taskDependenciesAccepted(ctx, store, workspaceID, issueID, *task) {
		return PreparedRun{}, ErrTaskDependenciesIncomplete
	}
	if agentTargetID == "" {
		agentTargetID = strings.TrimSpace(task.AgentTargetID)
	}
	if agentTargetID == "" {
		agentTargetID = legacyAgentTargetIDForProvider(agentProvider)
	}
	if agentProvider == "" {
		agentProvider = agentProviderForAgentTargetID(agentTargetID)
	}
	if agentTargetID == "" {
		return PreparedRun{}, ErrInvalidArgument
	}
	modelPlanID := firstNonEmpty(input.ModelPlanID, task.ModelPlanID)
	model := firstNonEmpty(input.Model, task.Model)
	reasoningIntensity := issue.ExecutionProfile.ReasoningIntensity
	if reasoningIntensity < 0 || reasoningIntensity > 100 {
		return PreparedRun{}, ErrInvalidArgument
	}
	executionDirectory := firstNonEmpty(input.ExecutionDirectory, task.ExecutionDirectory)
	now := s.nowUnixMS()
	resolvedRunID := s.resolveID(IDKindRun, input.RunID)
	run := Run{
		RunID:              resolvedRunID,
		TaskID:             taskID,
		IssueID:            issue.IssueID,
		WorkspaceID:        issue.WorkspaceID,
		RequesterUserID:    actorUserID,
		AgentTargetID:      agentTargetID,
		AgentProvider:      agentProvider,
		ModelPlanID:        modelPlanID,
		Model:              model,
		ReasoningIntensity: reasoningIntensity,
		AgentUserID:        firstNonEmpty(input.AgentUserID, actorUserID),
		AgentSessionID:     strings.TrimSpace(input.AgentSessionID),
		Status:             StatusRunning,
		ExecutionDirectory: executionDirectory,
		CreatedAtUnixMS:    now,
		StartedAtUnixMS:    now,
		UpdatedAtUnixMS:    now,
	}
	if run.RunID == "" {
		return PreparedRun{}, ErrInvalidArgument
	}
	return PreparedRun{Run: run, Task: *task, TaskIsNew: taskIsNew, Issue: issue}, nil
}

func taskDependenciesAccepted(ctx context.Context, store Store, workspaceID string, issueID string, task Task) bool {
	if len(task.DependencyTaskIDs) == 0 {
		return true
	}
	for _, dependencyID := range task.DependencyTaskIDs {
		dependency, err := store.GetTask(ctx, workspaceID, issueID, dependencyID)
		if err != nil || dependency.Status != StatusCompleted || dependency.AcceptanceState != AcceptanceUserAccepted {
			return false
		}
	}
	return true
}

func legacyAgentTargetIDForProvider(provider string) string {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return ""
	}
	return descriptor.Target.ID
}

func agentProviderForAgentTargetID(agentTargetID string) string {
	const localPrefix = "local:"
	agentTargetID = strings.TrimSpace(agentTargetID)
	if strings.HasPrefix(agentTargetID, localPrefix) {
		return strings.TrimPrefix(agentTargetID, localPrefix)
	}
	return ""
}

func (s Service) prepareIssueRunTask(ctx context.Context, store Store, issue Issue, actorUserID string) (Task, bool, error) {
	tasks, err := store.ListTasks(ctx, TaskListFilter{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.IssueID,
		ReturnAll:   true,
	})
	if err != nil {
		return Task{}, false, err
	}
	if len(tasks.Items) > 0 {
		return tasks.Items[0], false, nil
	}
	prepared, err := s.buildTasks(issue, actorUserID, []CreateTaskItemInput{{
		Title: issue.Title,
	}})
	if err != nil {
		return Task{}, false, err
	}
	if len(prepared) != 1 {
		return Task{}, false, ErrInvalidArgument
	}
	return prepared[0], true, nil
}

func findIssueRunTaskID(ctx context.Context, store Store, workspaceID string, issueID string, runID string) (string, error) {
	runs, err := store.ListRuns(ctx, workspaceID, issueID, "")
	if err != nil {
		return "", err
	}
	for _, run := range runs {
		if run.RunID == runID {
			return run.TaskID, nil
		}
	}
	return "", ErrRunNotFound
}

func (s Service) CompleteRun(ctx context.Context, input CompleteRunInput) (Run, []RunOutput, error) {
	store, err := s.store()
	if err != nil {
		return Run{}, nil, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	taskID := strings.TrimSpace(input.TaskID)
	runID := strings.TrimSpace(input.RunID)
	if workspaceID == "" || issueID == "" || runID == "" || strings.TrimSpace(input.ActorUserID) == "" {
		return Run{}, nil, ErrInvalidArgument
	}
	status, ok := NormalizeRunCompletionStatus(input.Status)
	if !ok {
		return Run{}, nil, ErrInvalidArgument
	}
	usage, ok := NormalizeTokenUsage(input.Usage)
	if !ok {
		return Run{}, nil, ErrInvalidArgument
	}
	if input.HasRemainingQuotaPercent && (input.RemainingQuotaPercent < 0 || input.RemainingQuotaPercent > 100) {
		return Run{}, nil, ErrInvalidArgument
	}
	if taskID == "" {
		resolvedTaskID, err := findIssueRunTaskID(ctx, store, workspaceID, issueID, runID)
		if err != nil {
			return Run{}, nil, err
		}
		taskID = resolvedTaskID
	}
	issue, task, err := getRunParent(ctx, store, workspaceID, issueID, taskID)
	if err != nil {
		return Run{}, nil, err
	}
	run, err := store.GetRun(ctx, workspaceID, issueID, taskID, runID)
	if err != nil {
		return Run{}, nil, err
	}
	if run.Status == StatusCompleted || run.Status == StatusFailed || run.Status == StatusCanceled {
		outputs, err := store.ListRunOutputs(ctx, workspaceID, issueID, taskID, runID)
		if err != nil {
			return Run{}, nil, err
		}
		return run, outputs, nil
	}
	now := s.nowUnixMS()
	outputs := make([]RunOutput, 0, len(input.Outputs))
	seen := make(map[string]struct{}, len(input.Outputs))
	for _, output := range input.Outputs {
		outputPath := strings.TrimSpace(output.Path)
		if outputPath == "" {
			return Run{}, nil, ErrInvalidArgument
		}
		outputID := s.resolveID(IDKindRunOutput, output.OutputID)
		if _, exists := seen[outputID]; exists {
			outputID = s.resolveID(IDKindRunOutput, "")
		}
		seen[outputID] = struct{}{}
		displayName := strings.TrimSpace(output.DisplayName)
		if displayName == "" {
			displayName = path.Base(outputPath)
		}
		outputs = append(outputs, RunOutput{
			OutputID:        outputID,
			RunID:           run.RunID,
			TaskID:          run.TaskID,
			IssueID:         run.IssueID,
			WorkspaceID:     run.WorkspaceID,
			Path:            outputPath,
			DisplayName:     displayName,
			MediaType:       strings.TrimSpace(output.MediaType),
			SizeBytes:       maxInt64(output.SizeBytes, 0),
			CreatedAtUnixMS: now,
		})
	}
	run.Status = status
	run.Usage = usage
	run.Summary = strings.TrimSpace(input.Summary)
	run.ErrorMessage = strings.TrimSpace(input.ErrorMessage)
	run.CompletedAtUnixMS = now
	run.UpdatedAtUnixMS = now
	completed, savedOutputs, err := store.CompleteRun(ctx, run, outputs)
	if err != nil {
		return Run{}, nil, err
	}
	if task != nil {
		task.Status = TaskStatusForCompletedRun(status)
		// A finished executor turn is the Agent's own completion claim, never
		// evidence that an independent review passed or that the user accepted.
		task.AcceptanceState = AcceptanceAgentClaimed
		if status == StatusCompleted {
			task.AcceptanceSummary = strings.TrimSpace(input.Summary)
		}
		task.LatestRunID = completed.RunID
		task.UpdatedAtUnixMS = now
		if _, err := store.UpdateTask(ctx, *task); err != nil {
			return Run{}, nil, err
		}
		projected, err := store.RecalculateIssueProjection(ctx, workspaceID, issueID)
		if err != nil {
			return Run{}, nil, err
		}
		issue = projected
	} else {
		issue.Status = TaskStatusForCompletedRun(status)
		issue.UpdatedAtUnixMS = now
		if _, err := store.UpdateIssue(ctx, issue); err != nil {
			return Run{}, nil, err
		}
	}
	issue.Budget.ConsumedTokens += usage.Total()
	if input.HasRemainingQuotaPercent {
		issue.Budget.RemainingQuotaPercent = input.RemainingQuotaPercent
		issue.Budget.HasRemainingQuota = true
	}
	if issue.Budget.TokenLimit > 0 && issue.Budget.ConsumedTokens >= issue.Budget.TokenLimit {
		issue.Budget.Status = BudgetStatusSoftLimited
	}
	if issue.Budget.HasRemainingQuota && issue.Budget.RemainingQuotaPercent <= issue.Budget.QuotaWaterlinePercent {
		issue.Budget.Status = BudgetStatusSoftLimited
	}
	issue.UpdatedAtUnixMS = now
	if _, err := store.UpdateIssue(ctx, issue); err != nil {
		return Run{}, nil, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, now); err != nil {
		return Run{}, nil, err
	}
	return completed, savedOutputs, nil
}

func ensureRunParentExists(ctx context.Context, store Store, workspaceID string, issueID string, taskID string) error {
	_, _, err := getRunParent(ctx, store, workspaceID, issueID, taskID)
	return err
}

func getRunParent(ctx context.Context, store Store, workspaceID string, issueID string, taskID string) (Issue, *Task, error) {
	if taskID != "" {
		task, err := store.GetTask(ctx, workspaceID, issueID, taskID)
		if err != nil {
			return Issue{}, nil, err
		}
		issue, err := store.GetIssue(ctx, task.WorkspaceID, task.IssueID)
		if err != nil {
			return Issue{}, nil, err
		}
		return issue, &task, nil
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return Issue{}, nil, err
	}
	return issue, nil, nil
}

func (s Service) AddContextRefs(ctx context.Context, input AddContextRefsInput) ([]ContextRef, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	parentKind, ok := NormalizeContextRefParentKind(input.ParentKind)
	if workspaceID == "" || issueID == "" || !ok {
		return nil, ErrInvalidArgument
	}
	taskID := strings.TrimSpace(input.TaskID)
	if parentKind == ContextRefParentTask && taskID == "" {
		return nil, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	if err := RejectManagedIssueMutation(issue); err != nil {
		return nil, err
	}
	refs, err := s.buildContextRefs(issue, taskID, parentKind, input.Refs)
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	saved, err := store.AddContextRefs(ctx, refs)
	if err != nil {
		return nil, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, refs[0].CreatedAtUnixMS); err != nil {
		return nil, err
	}
	return saved, nil
}

func (s Service) buildContextRefs(
	issue Issue,
	taskID string,
	parentKind ContextRefParentKind,
	input []AddContextRefInput,
) ([]ContextRef, error) {
	refs := make([]ContextRef, 0, len(input))
	now := s.nowUnixMS()
	for _, ref := range input {
		refPath := strings.TrimSpace(ref.Path)
		if refPath == "" {
			return nil, ErrInvalidArgument
		}
		displayName := strings.TrimSpace(ref.DisplayName)
		if displayName == "" {
			displayName = path.Base(refPath)
		}
		contextRefID := s.resolveID(IDKindContextRef, ref.ContextRefID)
		if contextRefID == "" {
			return nil, ErrInvalidArgument
		}
		refs = append(refs, ContextRef{
			ContextRefID:    contextRefID,
			WorkspaceID:     issue.WorkspaceID,
			IssueID:         issue.IssueID,
			TaskID:          taskID,
			ParentKind:      parentKind,
			RefType:         strings.TrimSpace(ref.RefType),
			Path:            refPath,
			DisplayName:     displayName,
			CreatedAtUnixMS: now,
		})
	}
	return refs, nil
}

func (s Service) RemoveContextRef(ctx context.Context, input RemoveContextRefInput) (bool, error) {
	store, err := s.store()
	if err != nil {
		return false, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	taskID := strings.TrimSpace(input.TaskID)
	contextRefID := strings.TrimSpace(input.ContextRefID)
	parentKind, ok := NormalizeContextRefParentKind(input.ParentKind)
	if workspaceID == "" || issueID == "" || contextRefID == "" || !ok {
		return false, ErrInvalidArgument
	}
	if parentKind == ContextRefParentTask && taskID == "" {
		return false, ErrInvalidArgument
	}
	if parentKind == ContextRefParentIssue {
		taskID = ""
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return false, err
	}
	if err := RejectManagedIssueMutation(issue); err != nil {
		return false, err
	}
	removed, err := store.RemoveContextRef(ctx, workspaceID, issueID, taskID, parentKind, contextRefID)
	if err != nil {
		return false, err
	}
	if !removed {
		return false, ErrContextRefNotFound
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, s.nowUnixMS()); err != nil {
		return false, err
	}
	return true, nil
}

func (s Service) store() (Store, error) {
	if s.Store == nil {
		return nil, ErrStoreNotConfigured
	}
	return s.Store, nil
}

func (s Service) nowUnixMS() int64 {
	clock := s.Clock
	if clock == nil {
		clock = time.Now
	}
	return clock().UnixMilli()
}

func (s Service) resolveID(kind IDKind, value string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	if s.IDGenerator != nil {
		return strings.TrimSpace(s.IDGenerator(kind))
	}
	return randomID(kind)
}

func randomID(kind IDKind) string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return ""
	}
	return string(kind) + "-" + hex.EncodeToString(buf[:])
}

func maxInt64(value int64, floor int64) int64 {
	if value < floor {
		return floor
	}
	return value
}
