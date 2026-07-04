package references

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/refresolve"
)

type referenceListInput struct {
	Source  string `cli:"source" validate:"required" description:"Reference source." enum:"app,task"`
	ID      string `cli:"id" validate:"required" description:"Top container id: appId when source=app, topicId when source=task."`
	GroupID string `cli:"group-id" description:"Optional sub-scope: an app group id when source=app, an issueId when source=task. Empty = whole app / whole topic."`
	Query   string `cli:"query" description:"Optional file name filter."`
	Limit   int    `cli:"limit" description:"Optional max number of files (default and cap 1000)."`
}

var referenceColumns = []cliservice.TableColumn{
	{Key: "displayName", Label: "Name"},
	{Key: "path", Label: "Path"},
	{Key: "sizeBytes", Label: "Size"},
}

func (p Provider) newReferenceListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[referenceListInput]{
		ID:          appID + ".reference.list",
		Path:        []string{"reference", "list"},
		Summary:     "List artifact files behind a workspace-reference mention",
		Description: "Resolve a workspace-reference handle (app+group / topic+issue) into a flat list of artifact files.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[referenceListInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table:       &framework.TableOutputSpec{Columns: referenceColumns, Rows: referenceRows},
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: referenceListJSONValue},
			ListCompact: true,
		},
		Run: p.runReferenceList,
	})
}

func (p Provider) runReferenceList(ctx context.Context, invoke framework.InvokeContext, input referenceListInput) (any, error) {
	return refresolve.Resolver{Apps: p.apps, Issues: p.issues}.Resolve(
		ctx, invoke.WorkspaceID, input.Source, input.ID, input.GroupID, input.Query, input.Limit,
	)
}

func referenceListJSONValue(result any) map[string]any {
	files := result.([]refresolve.File)
	items := make([]any, 0, len(files))
	for _, file := range files {
		items = append(items, map[string]any{
			"path":            file.Path,
			"displayName":     file.DisplayName,
			"sizeBytes":       file.SizeBytes,
			"mediaType":       file.MediaType,
			"createdAtUnixMs": file.CreatedAtUnixMs,
		})
	}
	return map[string]any{"items": items}
}

func referenceRows(result any) []map[string]any {
	files := result.([]refresolve.File)
	rows := make([]map[string]any, 0, len(files))
	for _, file := range files {
		rows = append(rows, map[string]any{
			"displayName": file.DisplayName,
			"path":        file.Path,
			"sizeBytes":   file.SizeBytes,
		})
	}
	return rows
}
