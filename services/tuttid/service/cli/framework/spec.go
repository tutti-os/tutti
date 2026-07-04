package framework

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type CommandKind string

const (
	KindList   CommandKind = "list"
	KindGet    CommandKind = "get"
	KindAction CommandKind = "action"
)

type OutputView string

const (
	ViewSummary OutputView = "summary"
	ViewDetail  OutputView = "detail"
)

type WorkspacePolicy string

const (
	WorkspaceOptional       WorkspacePolicy = "optional"
	WorkspaceStartupDefault WorkspacePolicy = "startup-default"
	WorkspaceRequired       WorkspacePolicy = "required"
)

type InvokeContext struct {
	Request     cliservice.InvokeRequest
	WorkspaceID string
}

type CommandSpec[T any] struct {
	ID          string
	Path        []string
	Summary     string
	Description string
	Kind        CommandKind
	Visibility  cliservice.CapabilityVisibility
	Workspace   WorkspacePolicy
	Workspaces  cliservice.WorkspaceCatalog
	Inputs      InputSpec
	Output      OutputSpec
	Source      cliservice.CapabilitySource
	Run         func(context.Context, InvokeContext, T) (any, error)
}

type FieldSpec struct {
	Name        string
	Type        string
	Description string
	Required    bool
	Hint        string
	Min         *int64
	Max         *int64
	Enum        []string
}

type InputSpec struct {
	Fields       []FieldSpec
	InputType    string
	AcceptsInput bool
}

type OutputSpec struct {
	DefaultMode   cliservice.OutputMode
	DefaultView   OutputView
	JSON          bool
	Table         *TableOutputSpec
	JSONViews     map[OutputView]func(any) map[string]any
	JSONValue     func(any) map[string]any
	RawJSON       bool
	RawJSONReason string
	PlainText     func(any) string
	Markdown      func(any) string
	ListCompact   bool
}

type TableOutputSpec struct {
	Columns []cliservice.TableColumn
	Rows    func(any) []map[string]any
}
