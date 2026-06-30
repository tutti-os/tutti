package core

import "time"

type OutputMode string

const (
	OutputModeTable OutputMode = "table"
	OutputModeJSON  OutputMode = "json"
)

type CommandVisibility string

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
	CapabilitySourceApp CapabilitySourceKind = "app"
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
	Visibility  CommandVisibility
	InputSchema map[string]any
	Output      CapabilityOutput
	Source      CapabilitySource
}

type CommandOutput struct {
	Kind    OutputMode
	Columns []TableColumn
	Rows    []map[string]any
	Value   map[string]any
	Text    string
}

type InputWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Command struct {
	Capability Capability
	Manifest   ManifestCommand
	Timeout    time.Duration
}

type CommandBuildOptions struct {
	AppID             string
	AppName           string
	IconURL           string
	AppDescription    string
	DocumentationFile string
	DocumentationPath string
}
