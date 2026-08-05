package cli

import (
	"context"
	"errors"
	"strings"
)

// HostRouteContext is fixed by daemon wiring. Untrusted connector input never
// receives an InvokeContext and therefore cannot impersonate another
// workspace/session/source or disable capability filters.
type HostRouteContext struct {
	AppID           string
	WorkspaceID     string
	AgentSessionID  string
	ParentCommandID string
	Source          string
}

type HostInvokeRequest struct {
	CommandID  string
	Input      map[string]any
	OutputMode OutputMode
}

type HostRoute struct {
	registry      *Registry
	invokeContext InvokeContext
}

func NewHostRoute(registry *Registry, hostContext HostRouteContext) (*HostRoute, error) {
	if registry == nil {
		return nil, errors.New("host CLI route registry is required")
	}
	source := strings.TrimSpace(hostContext.Source)
	if source == "" {
		return nil, errors.New("host CLI route source is required")
	}
	return &HostRoute{
		registry: registry,
		invokeContext: InvokeContext{
			AppID:           strings.TrimSpace(hostContext.AppID),
			Source:          source,
			WorkspaceID:     strings.TrimSpace(hostContext.WorkspaceID),
			ParentCommandID: strings.TrimSpace(hostContext.ParentCommandID),
			AgentSessionID:  strings.TrimSpace(hostContext.AgentSessionID),
			// SkipCapabilityFilters and IncludeIntegrationCapabilities are
			// intentionally impossible to set through HostRouteContext.
		},
	}, nil
}

func (route *HostRoute) Invoke(ctx context.Context, request HostInvokeRequest) (CommandOutput, error) {
	if route == nil || route.registry == nil {
		return CommandOutput{}, ErrServiceUnavailable
	}
	input := make(map[string]any, len(request.Input))
	for key, value := range request.Input {
		input[key] = value
	}
	return route.registry.Invoke(ctx, InvokeRequest{
		CommandID:  strings.TrimSpace(request.CommandID),
		Input:      input,
		OutputMode: request.OutputMode,
		Context:    route.invokeContext,
	})
}
