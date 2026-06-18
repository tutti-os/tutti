package issuemanager

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type topicCreateInput struct {
	TopicID string `cli:"topic-id" description:"Stable topic id to create; generated when omitted."`
	Title   string `cli:"title" validate:"required" description:"Topic title."`
	Summary string `cli:"summary" description:"Topic summary."`
}

type topicUpdateInput struct {
	TopicID string  `cli:"topic-id" validate:"required" description:"Topic to update." hint:"Use issue topic list to discover workspace topics."`
	Title   *string `cli:"title" description:"Replace the topic title."`
	Summary *string `cli:"summary" description:"Replace the topic summary."`
	Pinned  *bool   `cli:"pinned" description:"Set whether the topic is pinned."`
}

type topicIDInput struct {
	TopicID string `cli:"topic-id" validate:"required" description:"Topic to delete." hint:"Use issue topic list to discover workspace topics."`
}

func (p Provider) newTopicListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          appID + ".issue.topic.list",
		Path:        []string{"issue", "topic", "list"},
		Summary:     "List issue topics",
		Description: "List workspace issue topics. Use a returned topicId when listing or creating issues.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table:       &framework.TableOutputSpec{Columns: topicColumns, Rows: func(result any) []map[string]any { return topicRows(result.(workspaceissues.TopicList).Items) }},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"topics": topicSummaryValues(result.(workspaceissues.TopicList).Items)}
				},
			},
			ListCompact: true,
		},
		Run: p.runTopicList,
	})
}

func (p Provider) newTopicCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[topicCreateInput]{
		ID:          appID + ".issue.topic.create",
		Path:        []string{"issue", "topic", "create"},
		Summary:     "Create an issue topic",
		Description: "Create a workspace issue topic.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[topicCreateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"topic": topicSummaryValue(result.(workspaceissues.Topic))}
				},
			},
		},
		Run: p.runTopicCreate,
	})
}

func (p Provider) newTopicUpdateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[topicUpdateInput]{
		ID:          appID + ".issue.topic.update",
		Path:        []string{"issue", "topic", "update"},
		Summary:     "Update an issue topic",
		Description: "Update a workspace issue topic title, summary, or pin state.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[topicUpdateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"topic": topicSummaryValue(result.(workspaceissues.Topic))}
				},
			},
		},
		Run: p.runTopicUpdate,
	})
}

func (p Provider) newTopicDeleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[topicIDInput]{
		ID:          appID + ".issue.topic.delete",
		Path:        []string{"issue", "topic", "delete"},
		Summary:     "Delete an issue topic",
		Description: "Delete an empty non-default issue topic.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[topicIDInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any { return map[string]any{"removed": result.(bool)} }},
		},
		Run: p.runTopicDelete,
	})
}

func (p Provider) runTopicList(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.ListTopics(ctx, invoke.WorkspaceID)
}

func (p Provider) runTopicCreate(ctx context.Context, invoke framework.InvokeContext, input topicCreateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.CreateTopic(ctx, invoke.WorkspaceID, workspaceservice.CreateIssueManagerTopicInput{
		TopicID: input.TopicID,
		Title:   input.Title,
		Summary: input.Summary,
	})
}

func (p Provider) runTopicUpdate(ctx context.Context, invoke framework.InvokeContext, input topicUpdateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	if input.Title == nil && input.Summary == nil && input.Pinned == nil {
		return nil, workspaceissues.ErrInvalidArgument
	}
	update := workspaceservice.UpdateIssueManagerTopicInput{
		HasTitle:   input.Title != nil,
		HasSummary: input.Summary != nil,
		HasPinned:  input.Pinned != nil,
	}
	if input.Title != nil {
		update.Title = *input.Title
	}
	if input.Summary != nil {
		update.Summary = *input.Summary
	}
	if input.Pinned != nil {
		update.Pinned = *input.Pinned
	}
	return p.issues.UpdateTopic(ctx, invoke.WorkspaceID, input.TopicID, update)
}

func (p Provider) runTopicDelete(ctx context.Context, invoke framework.InvokeContext, input topicIDInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.DeleteTopic(ctx, invoke.WorkspaceID, input.TopicID)
}
