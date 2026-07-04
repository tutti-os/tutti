package issuemanager

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
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
	IssueID string `cli:"issue-id"`
	TopicID string `cli:"topic-id" validate:"required" description:"Required topic id. Use issue topic list to discover workspace topics." hint:"Use issue topic list to discover workspace topics."`
	Title   string `cli:"title" validate:"required"`
	Content string `cli:"content"`
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
	return p.issues.CreateIssue(ctx, invoke.WorkspaceID, workspaceservice.CreateIssueManagerIssueInput{
		IssueID: input.IssueID,
		TopicID: input.TopicID,
		Title:   input.Title,
		Content: input.Content,
	})
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
