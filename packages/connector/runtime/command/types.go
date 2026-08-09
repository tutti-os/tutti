package command

import "context"

type OutputMode string

const OutputModeJSON OutputMode = "json"

type Capability struct {
	ID          string
	Path        []string
	Summary     string
	Description string
	InputSchema map[string]any
	Source      CapabilitySource
}

type CapabilitySource struct {
	Kind    string
	AppID   string
	AppName string
}

type InvokeContext struct {
	Source          string
	WorkspaceID     string
	AgentSessionID  string
	ParentCommandID string
}

type InvokeRequest struct {
	CommandID string
	Input     map[string]any
	Context   InvokeContext
}

type Output struct {
	Value map[string]any
}

type Handler func(context.Context, InvokeRequest) (Output, error)
