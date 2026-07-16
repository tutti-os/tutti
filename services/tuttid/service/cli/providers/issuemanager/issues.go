package issuemanager

import (
	"context"
	"encoding/json"
	"fmt"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type issueListInput struct {
	TopicID   string `cli:"topic-id" validate:"required" description:"Required topic id. Use issue topic list --json to discover workspace topics before listing issues." hint:"Use issue topic list --json to discover workspace topics."`
	Status    string `cli:"status" description:"Issue status filter." enum:"all,not_started,running,pending_acceptance,completed,failed,canceled"`
	Search    string `cli:"search"`
	PageSize  int    `cli:"page-size" validate:"min=1,max=100"`
	PageToken string `cli:"page-token"`
}

type issueGetInput struct {
	IssueID string `cli:"issue-id" validate:"required"`
}

type issueCreateInput struct {
	IssueID                string   `cli:"issue-id"`
	TopicID                string   `cli:"topic-id" validate:"required" description:"Required topic id. Use issue topic list to discover workspace topics." hint:"Use issue topic list to discover workspace topics."`
	Title                  string   `cli:"title" validate:"required"`
	Content                string   `cli:"content"`
	PlanningSource         string   `cli:"planning-source" enum:"manual,traditional_plan" description:"Origin of the plan that produced this issue."`
	SourceSessionID        string   `cli:"source-session-id" description:"AgentGUI session that produced the plan."`
	ReasoningIntensity     *int     `cli:"reasoning-intensity" validate:"min=0,max=100" description:"Default task reasoning intensity from 0 to 100."`
	OrchestrationIntensity *int     `cli:"orchestration-intensity" validate:"min=0,max=100" description:"Planning and collaboration intensity from 0 to 100."`
	BudgetMode             string   `cli:"budget-mode" enum:"auto,fixed" description:"Automatic or fixed token budget."`
	TokenBudget            *int64   `cli:"token-budget" validate:"min=1" description:"Fixed token limit; required when budget-mode is fixed."`
	QuotaWaterlinePercent  *float64 `cli:"quota-waterline-percent" validate:"min=0,max=100" description:"Pause new dispatch when subscription quota reaches this percentage."`
}

type issueCreateFromPlanInput struct {
	issueCreateInput
	TasksJSON string `cli:"tasks-json" validate:"required" description:"Ordered JSON task array. Each task supports taskId, title, content, priority, agentTargetId, modelPlanId, model, executionDirectory, and dependencyTaskIds."`
}

type issueUpdateInput struct {
	IssueID string  `cli:"issue-id" validate:"required" description:"Issue to update."`
	Title   *string `cli:"title" description:"Replace the issue title."`
	Content *string `cli:"content" description:"Replace the issue content."`
	Status  *string `cli:"status" description:"Issue status." enum:"not_started,running,pending_acceptance,completed,failed,canceled"`
}

func (p Provider) newIssueListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueListInput]{
		ID:          appID + ".issue.list",
		Path:        []string{"issue", "list"},
		Summary:     "List issues in a topic",
		Description: "List issue records in one workspace topic. Requires --topic-id; use `issue topic list --json` first when the topic is unknown. JSON output omits issue content bodies.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueListInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table:       &framework.TableOutputSpec{Columns: issueColumns, Rows: func(result any) []map[string]any { return issueRows(result.(workspaceissues.IssueList).Items) }},
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: issueListJSONValue},
			ListCompact: true,
		},
		Run: p.runIssueList,
	})
}

func (p Provider) newIssueGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueGetInput]{
		ID:          appID + ".issue.get",
		Path:        []string{"issue", "get"},
		Summary:     "Get issue detail",
		Description: "Get an issue detail record and its tasks.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueGetInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewDetail: issueDetailJSONValue},
		},
		Run: p.runIssueGet,
	})
}

func (p Provider) runIssueList(ctx context.Context, invoke framework.InvokeContext, input issueListInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.ListIssues(ctx, invoke.WorkspaceID, workspaceservice.ListIssueManagerItemsInput{
		TopicID:      input.TopicID,
		StatusFilter: input.Status,
		SearchQuery:  input.Search,
		PageSize:     input.PageSize,
		PageToken:    input.PageToken,
	})
}

func issueListJSONValue(result any) map[string]any {
	list := result.(workspaceissues.IssueList)
	value := map[string]any{
		"issues":       issueSummaryValues(list.Items),
		"totalCount":   list.TotalCount,
		"statusCounts": statusCountsValue(list.StatusCounts),
	}
	maybeAddNextPageToken(value, list.NextPageToken)
	return value
}

// issueGetResult carries the issue detail plus its resolved referenced input files so the JSON
// view can surface `detail.references` without re-resolving (resolution needs ctx + services).
type issueGetResult struct {
	detail     workspaceissues.IssueDetail
	references []issueReferenceFile
}

func (p Provider) runIssueGet(ctx context.Context, invoke framework.InvokeContext, input issueGetInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	detail, err := p.issues.GetIssueDetail(ctx, invoke.WorkspaceID, input.IssueID)
	if err != nil {
		return nil, err
	}
	return issueGetResult{
		detail:     detail,
		references: p.collectIssueReferences(ctx, invoke.WorkspaceID, detail),
	}, nil
}

func issueDetailJSONValue(result any) map[string]any {
	res := result.(issueGetResult)
	return map[string]any{
		"detail": map[string]any{
			"issue":      issueDetailValue(res.detail.Issue),
			"tasks":      taskSummaryValues(res.detail.Tasks),
			"references": referenceFileValues(res.references),
		},
	}
}

func (p Provider) newIssueCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueCreateInput]{
		ID:          appID + ".issue.create",
		Path:        []string{"issue", "create"},
		Summary:     "Create an issue",
		Description: "Create an issue in a specific workspace topic.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueCreateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"issue": issueSummaryValue(result.(workspaceissues.Issue))}
				},
			},
		},
		Run: p.runIssueCreate,
	})
}

func (p Provider) newIssueCreateFromPlanCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueCreateFromPlanInput]{
		ID:          appID + ".issue.create-from-plan",
		Path:        []string{"issue", "create-from-plan"},
		Summary:     "Create an executable issue from a reviewed plan",
		Description: "Persist a reviewed traditional Plan as one issue with an ordered, validated task dependency graph. Tutti mode plans are materialized only by the daemon workflow after checkpoint approval.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueCreateFromPlanInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					detail := result.(workspaceissues.IssueDetail)
					return map[string]any{"issue": issueDetailValue(detail.Issue), "tasks": taskSummaryValues(detail.Tasks)}
				},
			},
		},
		Run: p.runIssueCreateFromPlan,
	})
}

func (p Provider) newIssueUpdateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueUpdateInput]{
		ID:          appID + ".issue.update",
		Path:        []string{"issue", "update"},
		Summary:     "Update an issue",
		Description: "Update issue title, content, or status.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueUpdateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"issue": issueSummaryValue(result.(workspaceissues.Issue))}
				},
			},
		},
		Run: p.runIssueUpdate,
	})
}

func (p Provider) newIssueDeleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueGetInput]{
		ID:          appID + ".issue.delete",
		Path:        []string{"issue", "delete"},
		Summary:     "Delete an issue",
		Description: "Delete an issue from the current workspace.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueGetInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any { return map[string]any{"removed": result.(bool)} }},
		},
		Run: p.runIssueDelete,
	})
}

func (p Provider) runIssueCreate(ctx context.Context, invoke framework.InvokeContext, input issueCreateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	if workflowbiz.IsReservedTuttiModePlanIssueID(input.IssueID) {
		return nil, cliservice.InvalidInputKeyError("issue-id")
	}
	return p.issues.CreateIssue(ctx, invoke.WorkspaceID, issueCreateServiceInput(input))
}

func (p Provider) runIssueCreateFromPlan(ctx context.Context, invoke framework.InvokeContext, input issueCreateFromPlanInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	if input.PlanningSource != string(workspaceissues.PlanningSourceTraditionalPlan) {
		return nil, cliservice.InvalidInputKeyError("planning-source")
	}
	if workflowbiz.IsReservedTuttiModePlanIssueID(input.IssueID) {
		return nil, cliservice.InvalidInputKeyError("issue-id")
	}
	manager, ok := p.issues.(issueFromPlanManager)
	if !ok {
		return nil, workspaceissues.ErrInvalidArgument
	}
	var parsed []taskCreateBatchItemInput
	if err := json.Unmarshal([]byte(input.TasksJSON), &parsed); err != nil || len(parsed) == 0 {
		return nil, fmt.Errorf("%w: tasks-json must be a non-empty task array", cliservice.ErrInvalidInput)
	}
	tasks := make([]workspaceservice.CreateIssueManagerTaskItemInput, 0, len(parsed))
	for _, item := range parsed {
		tasks = append(tasks, taskCreateBatchServiceInput(item))
	}
	return manager.CreateIssueFromPlan(ctx, invoke.WorkspaceID, workspaceservice.CreateIssueManagerIssueFromPlanInput{
		Issue: issueCreateServiceInput(input.issueCreateInput),
		Tasks: tasks,
	})
}

func issueCreateServiceInput(input issueCreateInput) workspaceservice.CreateIssueManagerIssueInput {
	profile := workspaceissues.DefaultExecutionProfile()
	if input.ReasoningIntensity != nil {
		profile.ReasoningIntensity = *input.ReasoningIntensity
	}
	if input.OrchestrationIntensity != nil {
		profile.OrchestrationIntensity = *input.OrchestrationIntensity
	}
	budget := workspaceissues.DefaultBudget()
	if input.BudgetMode != "" {
		budget.Mode = workspaceissues.BudgetMode(input.BudgetMode)
	}
	if input.TokenBudget != nil {
		budget.TokenLimit = *input.TokenBudget
	}
	if input.QuotaWaterlinePercent != nil {
		budget.QuotaWaterlinePercent = *input.QuotaWaterlinePercent
	}
	return workspaceservice.CreateIssueManagerIssueInput{
		IssueID:             input.IssueID,
		TopicID:             input.TopicID,
		Title:               input.Title,
		Content:             input.Content,
		PlanningSource:      input.PlanningSource,
		SourceSessionID:     input.SourceSessionID,
		ExecutionProfile:    profile,
		HasExecutionProfile: input.ReasoningIntensity != nil || input.OrchestrationIntensity != nil,
		Budget:              budget,
		HasBudget:           input.BudgetMode != "" || input.TokenBudget != nil || input.QuotaWaterlinePercent != nil,
	}
}

func (p Provider) runIssueUpdate(ctx context.Context, invoke framework.InvokeContext, input issueUpdateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	if input.Title == nil && input.Content == nil && input.Status == nil {
		return nil, workspaceissues.ErrInvalidArgument
	}
	update := workspaceservice.UpdateIssueManagerIssueInput{
		HasTitle:   input.Title != nil,
		HasContent: input.Content != nil,
		HasStatus:  input.Status != nil,
	}
	if input.Title != nil {
		update.Title = *input.Title
	}
	if input.Content != nil {
		update.Content = *input.Content
	}
	if input.Status != nil {
		update.Status = *input.Status
	}
	return p.issues.UpdateIssue(ctx, invoke.WorkspaceID, input.IssueID, update)
}

func (p Provider) runIssueDelete(ctx context.Context, invoke framework.InvokeContext, input issueGetInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.DeleteIssue(ctx, invoke.WorkspaceID, input.IssueID)
}
