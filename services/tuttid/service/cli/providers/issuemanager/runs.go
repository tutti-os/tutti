package issuemanager

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type runGetInput struct {
	IssueID string `cli:"issue-id" validate:"required"`
	TaskID  string `cli:"task-id" validate:"required"`
	RunID   string `cli:"run-id" validate:"required"`
}

type taskRunCreateInput struct {
	IssueID            string `cli:"issue-id" validate:"required"`
	TaskID             string `cli:"task-id" validate:"required"`
	RunID              string `cli:"run-id"`
	AgentTargetID      string `cli:"agent-target-id" description:"Agent target override; defaults to the task assignment."`
	AgentUserID        string `cli:"agent-user-id"`
	AgentSessionID     string `cli:"agent-session-id" description:"Optional override; defaults to the current AgentGUI session when invoked from an agent runtime."`
	ModelPlanID        string `cli:"model-plan-id" description:"Model Plan override; defaults to the task assignment."`
	Model              string `cli:"model" description:"Concrete model override; defaults to the task assignment."`
	ExecutionDirectory string `cli:"execution-directory" description:"Run-specific execution directory."`
}

type issueRunCreateInput struct {
	IssueID            string `cli:"issue-id" validate:"required"`
	RunID              string `cli:"run-id"`
	AgentTargetID      string `cli:"agent-target-id" description:"Agent target override; defaults to the issue task assignment when available."`
	AgentUserID        string `cli:"agent-user-id"`
	AgentSessionID     string `cli:"agent-session-id" description:"Optional override; defaults to the current AgentGUI session when invoked from an agent runtime."`
	ModelPlanID        string `cli:"model-plan-id"`
	Model              string `cli:"model"`
	ExecutionDirectory string `cli:"execution-directory"`
}

type taskRunCompleteInput struct {
	IssueID               string   `cli:"issue-id" validate:"required"`
	TaskID                string   `cli:"task-id" validate:"required"`
	RunID                 string   `cli:"run-id" validate:"required"`
	Status                string   `cli:"status" validate:"required" enum:"completed,failed,canceled"`
	Summary               string   `cli:"summary"`
	ErrorMessage          string   `cli:"error-message"`
	Outputs               string   `cli:"outputs"`
	InputTokens           int64    `cli:"input-tokens" validate:"min=0"`
	OutputTokens          int64    `cli:"output-tokens" validate:"min=0"`
	CacheReadTokens       int64    `cli:"cache-read-tokens" validate:"min=0"`
	CacheWriteTokens      int64    `cli:"cache-write-tokens" validate:"min=0"`
	Currency              string   `cli:"currency" description:"ISO 4217 currency for run cost; defaults to USD."`
	EstimatedMicros       int64    `cli:"estimated-cost-micros" validate:"min=0"`
	ActualMicros          int64    `cli:"actual-cost-micros" validate:"min=0"`
	RemainingQuotaPercent *float64 `cli:"remaining-quota-percent" validate:"min=0,max=100" description:"Provider-reported remaining subscription quota."`
}

type issueRunCompleteInput struct {
	IssueID               string   `cli:"issue-id" validate:"required"`
	RunID                 string   `cli:"run-id" validate:"required"`
	Status                string   `cli:"status" validate:"required" enum:"completed,failed,canceled"`
	Summary               string   `cli:"summary"`
	ErrorMessage          string   `cli:"error-message"`
	Outputs               string   `cli:"outputs"`
	InputTokens           int64    `cli:"input-tokens" validate:"min=0"`
	OutputTokens          int64    `cli:"output-tokens" validate:"min=0"`
	CacheReadTokens       int64    `cli:"cache-read-tokens" validate:"min=0"`
	CacheWriteTokens      int64    `cli:"cache-write-tokens" validate:"min=0"`
	Currency              string   `cli:"currency" description:"ISO 4217 currency for run cost; defaults to USD."`
	EstimatedMicros       int64    `cli:"estimated-cost-micros" validate:"min=0"`
	ActualMicros          int64    `cli:"actual-cost-micros" validate:"min=0"`
	RemainingQuotaPercent *float64 `cli:"remaining-quota-percent" validate:"min=0,max=100" description:"Provider-reported remaining subscription quota."`
}

func (p Provider) newRunListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueTaskInput]{
		ID:          appID + ".issue.task.run.list",
		Path:        []string{"issue", "task", "run", "list"},
		Summary:     "List issue task runs",
		Description: "List runs for an issue task.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueTaskInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table:       &framework.TableOutputSpec{Columns: runColumns, Rows: func(result any) []map[string]any { return runRows(result.([]workspaceissues.Run)) }},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"runs": runSummaryValues(result.([]workspaceissues.Run))}
				},
			},
			ListCompact: true,
		},
		Run: p.runRunList,
	})
}

func (p Provider) newRunGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[runGetInput]{
		ID:          appID + ".issue.task.run.get",
		Path:        []string{"issue", "task", "run", "get"},
		Summary:     "Get issue task run detail",
		Description: "Get run detail and outputs for an issue task.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[runGetInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewDetail: runDetailJSONValue},
		},
		Run: p.runRunGet,
	})
}

func (p Provider) newRunCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskRunCreateInput]{
		ID:          appID + ".issue.task.run.create",
		Path:        []string{"issue", "task", "run", "create"},
		Summary:     "Create an issue task run",
		Description: "Create an execution run for an issue task. Do not use for breakdown-only work.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskRunCreateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any {
				return map[string]any{"run": runSummaryValue(result.(workspaceissues.Run))}
			}},
		},
		Run: p.runTaskRunCreate,
	})
}

func (p Provider) newIssueRunCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueRunCreateInput]{
		ID:          appID + ".issue.run.create",
		Path:        []string{"issue", "run", "create"},
		Summary:     "Create an issue run",
		Description: "Create an execution run for an issue. Do not use for breakdown-only work.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueRunCreateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any {
				return map[string]any{"run": runSummaryValue(result.(workspaceissues.Run))}
			}},
		},
		Run: p.runIssueRunCreate,
	})
}

func (p Provider) newRunCompleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskRunCompleteInput]{
		ID:          appID + ".issue.task.run.complete",
		Path:        []string{"issue", "task", "run", "complete"},
		Summary:     "Complete an issue task run",
		Description: "Complete an execution run and attach output metadata. Do not use for breakdown-only work.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskRunCompleteInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: completedRunJSONValue},
		},
		Run: p.runTaskRunComplete,
	})
}

func (p Provider) newIssueRunCompleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueRunCompleteInput]{
		ID:          appID + ".issue.run.complete",
		Path:        []string{"issue", "run", "complete"},
		Summary:     "Complete an issue run",
		Description: "Complete an issue-level execution run and attach output metadata. Do not use for breakdown-only work.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueRunCompleteInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: completedRunJSONValue},
		},
		Run: p.runIssueRunComplete,
	})
}

func (p Provider) runRunList(ctx context.Context, invoke framework.InvokeContext, input issueTaskInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.ListRuns(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID)
}

func (p Provider) runRunGet(ctx context.Context, invoke framework.InvokeContext, input runGetInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.GetRunDetail(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID, input.RunID)
}

func runDetailJSONValue(result any) map[string]any {
	detail := result.(workspaceissues.RunDetail)
	return map[string]any{
		"detail": map[string]any{
			"run":     runDetailValue(detail.Run),
			"outputs": runOutputValues(detail.Outputs),
		},
	}
}

func (p Provider) runTaskRunCreate(ctx context.Context, invoke framework.InvokeContext, input taskRunCreateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	agentSessionID, err := issueRunAgentSessionID(invoke, input.AgentSessionID)
	if err != nil {
		return nil, err
	}
	return p.issues.CreateRun(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID, workspaceservice.CreateIssueManagerRunInput{
		RunID:              input.RunID,
		AgentTargetID:      input.AgentTargetID,
		AgentUserID:        input.AgentUserID,
		AgentSessionID:     agentSessionID,
		ModelPlanID:        input.ModelPlanID,
		Model:              input.Model,
		ExecutionDirectory: input.ExecutionDirectory,
	})
}

func (p Provider) runIssueRunCreate(ctx context.Context, invoke framework.InvokeContext, input issueRunCreateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	agentSessionID, err := issueRunAgentSessionID(invoke, input.AgentSessionID)
	if err != nil {
		return nil, err
	}
	return p.issues.CreateRun(ctx, invoke.WorkspaceID, input.IssueID, "", workspaceservice.CreateIssueManagerRunInput{
		RunID:              input.RunID,
		AgentTargetID:      input.AgentTargetID,
		AgentUserID:        input.AgentUserID,
		AgentSessionID:     agentSessionID,
		ModelPlanID:        input.ModelPlanID,
		Model:              input.Model,
		ExecutionDirectory: input.ExecutionDirectory,
	})
}

func issueRunAgentSessionID(
	invoke framework.InvokeContext,
	override string,
) (string, error) {
	if agentSessionID := strings.TrimSpace(override); agentSessionID != "" {
		return agentSessionID, nil
	}
	if agentSessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID); agentSessionID != "" {
		return agentSessionID, nil
	}
	return "", cliservice.MissingRequiredInputError("agent-session-id")
}

func (p Provider) runTaskRunComplete(ctx context.Context, invoke framework.InvokeContext, input taskRunCompleteInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	outputs, err := parseRunOutputs(input.Outputs)
	if err != nil {
		return nil, cliservice.InvalidInputKeyError("outputs")
	}
	return p.issues.CompleteRun(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID, input.RunID, workspaceservice.CompleteIssueManagerRunInput{
		Status:       input.Status,
		Summary:      input.Summary,
		ErrorMessage: input.ErrorMessage,
		Outputs:      outputs,
		Usage: workspaceissues.TokenUsage{
			InputTokens:      input.InputTokens,
			OutputTokens:     input.OutputTokens,
			CacheReadTokens:  input.CacheReadTokens,
			CacheWriteTokens: input.CacheWriteTokens,
		},
		Cost:                     workspaceissues.Cost{Currency: input.Currency, EstimatedMicros: input.EstimatedMicros, ActualMicros: input.ActualMicros},
		RemainingQuotaPercent:    float64Value(input.RemainingQuotaPercent),
		HasRemainingQuotaPercent: input.RemainingQuotaPercent != nil,
	})
}

func (p Provider) runIssueRunComplete(ctx context.Context, invoke framework.InvokeContext, input issueRunCompleteInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	outputs, err := parseRunOutputs(input.Outputs)
	if err != nil {
		return nil, cliservice.InvalidInputKeyError("outputs")
	}
	return p.issues.CompleteRun(ctx, invoke.WorkspaceID, input.IssueID, "", input.RunID, workspaceservice.CompleteIssueManagerRunInput{
		Status:       input.Status,
		Summary:      input.Summary,
		ErrorMessage: input.ErrorMessage,
		Outputs:      outputs,
		Usage: workspaceissues.TokenUsage{
			InputTokens:      input.InputTokens,
			OutputTokens:     input.OutputTokens,
			CacheReadTokens:  input.CacheReadTokens,
			CacheWriteTokens: input.CacheWriteTokens,
		},
		Cost:                     workspaceissues.Cost{Currency: input.Currency, EstimatedMicros: input.EstimatedMicros, ActualMicros: input.ActualMicros},
		RemainingQuotaPercent:    float64Value(input.RemainingQuotaPercent),
		HasRemainingQuotaPercent: input.RemainingQuotaPercent != nil,
	})
}

func float64Value(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func completedRunJSONValue(result any) map[string]any {
	detail := result.(workspaceissues.RunDetail)
	return map[string]any{
		"run":     runSummaryValue(detail.Run),
		"outputs": runOutputSummaryValues(detail.Outputs),
	}
}
