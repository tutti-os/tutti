package runtime

import "context"

type CapabilityList struct {
	Commands []Capability `json:"commands"`
}

type Capability struct {
	ID          string           `json:"id"`
	Path        []string         `json:"path"`
	Summary     string           `json:"summary"`
	Description *string          `json:"description,omitempty"`
	Visibility  *string          `json:"visibility,omitempty"`
	InputSchema *map[string]any  `json:"inputSchema,omitempty"`
	Output      CapabilityOutput `json:"output"`
	Source      CapabilitySource `json:"source"`
}

type CapabilityListOptions struct {
	IncludeHidden      bool
	IncludeIntegration bool
}

type CapabilitySource struct {
	Kind              string  `json:"kind"`
	AppID             *string `json:"appId,omitempty"`
	AppName           *string `json:"appName,omitempty"`
	IconURL           *string `json:"iconUrl,omitempty"`
	CLIDescription    *string `json:"cliDescription,omitempty"`
	AppDescription    *string `json:"appDescription,omitempty"`
	DocumentationFile *string `json:"documentationFile,omitempty"`
	DocumentationPath *string `json:"documentationPath,omitempty"`
}

type CapabilityOutput struct {
	DefaultMode string       `json:"defaultMode"`
	JSON        bool         `json:"json"`
	Table       *TableOutput `json:"table,omitempty"`
}

type TableOutput struct {
	Columns []TableColumn `json:"columns"`
}

type TableColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type InvokeRequest struct {
	Input      *map[string]any `json:"input,omitempty"`
	OutputMode *string         `json:"outputMode,omitempty"`
	Context    *InvokeContext  `json:"context,omitempty"`
}

type InvokeContext struct {
	Source          string  `json:"source"`
	WorkspaceID     *string `json:"workspaceID,omitempty"`
	ParentCommandID *string `json:"parentCommandId,omitempty"`
	AgentSessionID  *string `json:"agentSessionId,omitempty"`
}

type InvokeResponse struct {
	OK     bool           `json:"ok"`
	Output *CommandOutput `json:"output,omitempty"`
}

type CommandOutput struct {
	Kind     string            `json:"kind"`
	Columns  *[]TableColumn    `json:"columns,omitempty"`
	Rows     *[]map[string]any `json:"rows,omitempty"`
	Value    *map[string]any   `json:"value,omitempty"`
	Text     *string           `json:"text,omitempty"`
	Warnings *[]CommandWarning `json:"warnings,omitempty"`
}

type CommandWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type APIErrorResponse struct {
	Error APIErrorDetails `json:"error"`
}

type APIErrorDetails struct {
	Code             string          `json:"code"`
	Reason           *string         `json:"reason,omitempty"`
	Params           *map[string]any `json:"params,omitempty"`
	Retryable        *bool           `json:"retryable,omitempty"`
	DeveloperMessage *string         `json:"developerMessage,omitempty"`
	CorrelationID    *string         `json:"correlationId,omitempty"`
}

type CatalogClient interface {
	ListCapabilities(context.Context, string, CapabilityListOptions) (CapabilityList, error)
	Invoke(context.Context, string, InvokeRequest) (InvokeResponse, error)
}
