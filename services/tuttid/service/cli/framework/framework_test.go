package framework

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type sampleInput struct {
	TopicID      string   `cli:"topic-id" validate:"required" description:"Topic id." hint:"Use issue topic list."`
	Attachments  []string `cli:"attachment" description:"Attachment path."`
	PageSize     int      `cli:"page-size" validate:"min=1,max=100"`
	AfterVersion int64    `cli:"after-version" validate:"min=0"`
	Priority     string   `cli:"priority" enum:"high,medium,low"`
	Visible      bool     `cli:"visible"`
}

type optionalInput struct {
	Title  *string `cli:"title"`
	Pinned *bool   `cli:"pinned"`
	DueAt  *int64  `cli:"due-at-unix"`
}

type hiddenInput struct {
	AgentID  string `cli:"agent-id" advertise-required:"true"`
	Provider string `cli:"provider" hidden:"true"`
}

func TestFromStructGeneratesInputSchema(t *testing.T) {
	schema := Schema(FromStruct[sampleInput]())
	properties := schema["properties"].(map[string]any)
	if properties["topic-id"].(map[string]any)["type"] != "string" {
		t.Fatalf("topic-id property = %#v", properties["topic-id"])
	}
	if properties["page-size"].(map[string]any)["type"] != "integer" {
		t.Fatalf("page-size property = %#v", properties["page-size"])
	}
	if properties["page-size"].(map[string]any)["minimum"] != int64(1) || properties["page-size"].(map[string]any)["maximum"] != int64(100) {
		t.Fatalf("page-size range = %#v", properties["page-size"])
	}
	priority := properties["priority"].(map[string]any)
	if !reflect.DeepEqual(priority["enum"], []string{"high", "medium", "low"}) {
		t.Fatalf("priority property = %#v", priority)
	}
	if properties["visible"].(map[string]any)["type"] != "boolean" {
		t.Fatalf("visible property = %#v", properties["visible"])
	}
	attachment := properties["attachment"].(map[string]any)
	if attachment["type"] != "array" {
		t.Fatalf("attachment property = %#v", attachment)
	}
	if attachment["items"].(map[string]any)["type"] != "string" {
		t.Fatalf("attachment items = %#v", attachment["items"])
	}
	if required := schema["required"].([]string); !reflect.DeepEqual(required, []string{"topic-id"}) {
		t.Fatalf("required = %#v", required)
	}
}

func TestHiddenInputBindsWithoutAppearingInSchema(t *testing.T) {
	spec := FromStruct[hiddenInput]()
	schema := Schema(spec)
	properties := schema["properties"].(map[string]any)
	if _, ok := properties["provider"]; ok {
		t.Fatalf("hidden provider field leaked into schema: %#v", schema)
	}
	if required := schema["required"].([]string); !reflect.DeepEqual(required, []string{"agent-id"}) {
		t.Fatalf("required = %#v", required)
	}
	input, err := BindInput[hiddenInput](spec, map[string]any{
		"agent-id": "local:codex",
		"provider": "codex",
	})
	if err != nil {
		t.Fatalf("BindInput: %v", err)
	}
	if input.AgentID != "local:codex" || input.Provider != "codex" {
		t.Fatalf("input = %#v", input)
	}
	legacy, err := BindInput[hiddenInput](spec, map[string]any{"provider": "codex"})
	if err != nil || legacy.Provider != "codex" || legacy.AgentID != "" {
		t.Fatalf("legacy input = %#v, err = %v", legacy, err)
	}
}

func TestBindInputParsesAndValidates(t *testing.T) {
	input, err := BindInput[sampleInput](FromStruct[sampleInput](), map[string]any{
		"topic-id":      " topic-1 ",
		"attachment":    []any{" /tmp/a.png ", "/tmp/b.png"},
		"page-size":     "25",
		"after-version": "10",
		"priority":      "high",
		"visible":       "true",
	})
	if err != nil {
		t.Fatalf("BindInput: %v", err)
	}
	if input.TopicID != "topic-1" || input.PageSize != 25 || input.AfterVersion != 10 || input.Priority != "high" || !input.Visible {
		t.Fatalf("input = %#v", input)
	}
	if !reflect.DeepEqual(input.Attachments, []string{"/tmp/a.png", "/tmp/b.png"}) {
		t.Fatalf("attachments = %#v", input.Attachments)
	}
}

func TestBindInputRejectsMissingRequired(t *testing.T) {
	_, err := BindInput[sampleInput](FromStruct[sampleInput](), map[string]any{"page-size": "10"})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), `required input "topic-id" is missing`) || !strings.Contains(err.Error(), "issue topic list") {
		t.Fatalf("err = %v", err)
	}
}

func TestBindInputRejectsInvalidRange(t *testing.T) {
	_, err := BindInput[sampleInput](FromStruct[sampleInput](), map[string]any{"topic-id": "topic-1", "page-size": "200"})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), `invalid input "page-size": must be <= 100`) {
		t.Fatalf("err = %v", err)
	}
}

func TestBindInputRejectsInvalidEnum(t *testing.T) {
	_, err := BindInput[sampleInput](FromStruct[sampleInput](), map[string]any{"topic-id": "topic-1", "priority": "urgent"})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), `invalid input "priority": must be one of high, medium, low`) {
		t.Fatalf("err = %v", err)
	}
}

func TestBindInputIgnoresUnknownInput(t *testing.T) {
	input, err := BindInput[sampleInput](FromStruct[sampleInput](), map[string]any{"topic-id": "topic-1", "extra": "x"})
	if err != nil {
		t.Fatalf("BindInput: %v", err)
	}
	if input.TopicID != "topic-1" {
		t.Fatalf("input = %#v", input)
	}
}

func TestBindInputIgnoresInputForNoInputCommand(t *testing.T) {
	input, err := BindInput[struct{}](FromStruct[struct{}](), map[string]any{"extra": "x"})
	if err != nil {
		t.Fatalf("BindInput: %v", err)
	}
	if input != (struct{}{}) {
		t.Fatalf("input = %#v", input)
	}
}

func TestBindInputTracksOptionalPointerPresence(t *testing.T) {
	input, err := BindInput[optionalInput](FromStruct[optionalInput](), map[string]any{
		"title":       "",
		"pinned":      "false",
		"due-at-unix": "123",
	})
	if err != nil {
		t.Fatalf("BindInput: %v", err)
	}
	if input.Title == nil || *input.Title != "" {
		t.Fatalf("title = %#v", input.Title)
	}
	if input.Pinned == nil || *input.Pinned {
		t.Fatalf("pinned = %#v", input.Pinned)
	}
	if input.DueAt == nil || *input.DueAt != 123 {
		t.Fatalf("dueAt = %#v", input.DueAt)
	}
}

func TestFormatOutputSupportsTableJSONPlainAndMarkdown(t *testing.T) {
	spec := OutputSpec{
		DefaultMode: cliservice.OutputModeTable,
		DefaultView: ViewSummary,
		JSON:        true,
		Table: &TableOutputSpec{
			Columns: []cliservice.TableColumn{{Key: "id", Label: "ID"}},
			Rows: func(result any) []map[string]any {
				return []map[string]any{{"id": result.(string)}}
			},
		},
		JSONViews: map[OutputView]func(any) map[string]any{
			ViewSummary: func(result any) map[string]any { return map[string]any{"id": result} },
		},
		PlainText: func(result any) string { return "plain:" + result.(string) },
		Markdown:  func(result any) string { return "**" + result.(string) + "**" },
	}
	table, err := FormatOutput(spec, cliservice.OutputModeTable, "item-1")
	if err != nil || table.Rows[0]["id"] != "item-1" {
		t.Fatalf("table = %#v err = %v", table, err)
	}
	jsonOutput, err := FormatOutput(spec, cliservice.OutputModeJSON, "item-1")
	if err != nil || jsonOutput.Value["id"] != "item-1" {
		t.Fatalf("json = %#v err = %v", jsonOutput, err)
	}
	plain, err := FormatOutput(spec, cliservice.OutputModePlain, "item-1")
	if err != nil || plain.Text != "plain:item-1" {
		t.Fatalf("plain = %#v err = %v", plain, err)
	}
	markdown, err := FormatOutput(spec, cliservice.OutputModeMarkdown, "item-1")
	if err != nil || markdown.Text != "**item-1**" {
		t.Fatalf("markdown = %#v err = %v", markdown, err)
	}
}

func TestValidateSpecChecksCompliance(t *testing.T) {
	spec := validSpec()
	if err := ValidateSpec(spec); err != nil {
		t.Fatalf("ValidateSpec: %v", err)
	}
	spec.Path = []string{"IssueList"}
	if err := ValidateSpec(spec); !errors.Is(err, cliservice.ErrInvalidCommand) {
		t.Fatalf("err = %v, want ErrInvalidCommand", err)
	}
}

func TestValidateSpecChecksJSONViews(t *testing.T) {
	spec := validSpec()
	spec.Output.DefaultView = ViewDetail
	if err := ValidateSpec(spec); !errors.Is(err, cliservice.ErrInvalidCommand) {
		t.Fatalf("err = %v, want ErrInvalidCommand", err)
	}

	spec = validSpec()
	spec.Output.JSONViews = nil
	spec.Output.JSONValue = func(any) map[string]any { return map[string]any{} }
	if err := ValidateSpec(spec); !errors.Is(err, cliservice.ErrInvalidCommand) {
		t.Fatalf("err = %v, want ErrInvalidCommand", err)
	}

	spec.Output.RawJSON = true
	spec.Output.RawJSONReason = "legacy diagnostic payload"
	if err := ValidateSpec(spec); err != nil {
		t.Fatalf("ValidateSpec raw json: %v", err)
	}
}

func TestRegisterBindsResolvesWorkspaceRunsAndFormats(t *testing.T) {
	workspaces := fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}
	command := Register(CommandSpec[sampleInput]{
		ID:          "tutti.issue.list",
		Path:        []string{"issue", "list"},
		Summary:     "List issues",
		Description: "List issue records.",
		Kind:        KindList,
		Workspace:   WorkspaceRequired,
		Workspaces:  workspaces,
		Inputs:      FromStruct[sampleInput](),
		Output: OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: ViewSummary,
			JSON:        true,
			JSONViews: map[OutputView]func(any) map[string]any{
				ViewSummary: func(result any) map[string]any { return map[string]any{"workspaceId": result.(string)} },
			},
			ListCompact: true,
		},
		Run: func(_ context.Context, ctx InvokeContext, input sampleInput) (any, error) {
			if input.TopicID != "topic-1" {
				t.Fatalf("input = %#v", input)
			}
			return ctx.WorkspaceID, nil
		},
	})
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"topic-id": "topic-1"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["workspaceId"] != "workspace-1" {
		t.Fatalf("output = %#v", output)
	}
}

func validSpec() CommandSpec[sampleInput] {
	return CommandSpec[sampleInput]{
		ID:          "tutti.issue.list",
		Path:        []string{"issue", "list"},
		Summary:     "List issues",
		Description: "List issue records.",
		Kind:        KindList,
		Workspace:   WorkspaceRequired,
		Inputs:      FromStruct[sampleInput](),
		Output: OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: ViewSummary,
			JSON:        true,
			JSONViews:   map[OutputView]func(any) map[string]any{ViewSummary: func(any) map[string]any { return map[string]any{} }},
			ListCompact: true,
		},
		Run: func(context.Context, InvokeContext, sampleInput) (any, error) {
			return nil, nil
		},
	}
}

type fakeWorkspaceCatalog struct {
	startup workspacebiz.Summary
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &f.startup, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID}, nil
}
