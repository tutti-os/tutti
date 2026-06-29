package cli

import "context"

type OutputMode string

const (
	OutputModeTable    OutputMode = "table"
	OutputModeJSON     OutputMode = "json"
	OutputModePlain    OutputMode = "plain"
	OutputModeMarkdown OutputMode = "markdown"
)

type CapabilityVisibility string

const (
	CapabilityVisibilityPublic      CapabilityVisibility = "public"
	CapabilityVisibilityIntegration CapabilityVisibility = "integration"
)

type TableColumn struct {
	Key   string
	Label string
}

type TableOutput struct {
	Columns []TableColumn
}

type CapabilityOutput struct {
	DefaultMode OutputMode
	JSON        bool
	Table       *TableOutput
}

type CapabilitySourceKind string

const (
	CapabilitySourceBuiltin CapabilitySourceKind = "builtin"
	CapabilitySourceApp     CapabilitySourceKind = "app"
)

type CapabilitySource struct {
	Kind              CapabilitySourceKind
	AppID             string
	AppName           string
	IconURL           string
	CLIDescription    string
	AppDescription    string
	DocumentationFile string
	DocumentationPath string
}

type Capability struct {
	ID          string
	Path        []string
	Summary     string
	Description string
	Visibility  CapabilityVisibility
	InputSchema map[string]any
	Output      CapabilityOutput
	Source      CapabilitySource
}

type InvokeContext struct {
	Source                         string
	WorkspaceID                    string
	ParentCommandID                string
	AgentSessionID                 string
	SkipCapabilityFilters          bool
	IncludeIntegrationCapabilities bool
}

type InvokeRequest struct {
	CommandID  string
	Input      map[string]any
	OutputMode OutputMode
	Context    InvokeContext
}

type CommandOutput struct {
	Kind     OutputMode
	Columns  []TableColumn
	Rows     []map[string]any
	Value    map[string]any
	Text     string
	Warnings []CommandWarning
}

type CommandWarning struct {
	Code    string
	Message string
}

type Handler func(context.Context, InvokeRequest) (CommandOutput, error)

type Command struct {
	Capability Capability
	Handler    Handler
}
