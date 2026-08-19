package connectormarket

import (
	"context"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const connectorAvailableCommandID = "connector.available"

// ConnectorCommandProvider exposes daemon CLI discovery from the immutable
// RouteRegistry projection. Connector execution is owned by native MCP and CLI
// surfaces; this provider has no transport or lifecycle of its own.
type ConnectorCommandProvider struct {
	routes *implementationhost.RouteRegistry
}

func NewConnectorCommandProvider(registry *ConnectorRuntimeRegistry) *ConnectorCommandProvider {
	if registry == nil {
		return &ConnectorCommandProvider{}
	}
	return &ConnectorCommandProvider{routes: registry.runtime}
}

func (*ConnectorCommandProvider) Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability {
	return []cliservice.Capability{
		connectorCommandCapability(connectorAvailableCommandID, []string{"connector", "available"},
			"List installed connectors available to every Agent", objectSchema(nil, nil)),
	}
}

func (provider *ConnectorCommandProvider) Invoke(_ context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	if provider == nil || provider.routes == nil {
		return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
	}
	if request.CommandID != connectorAvailableCommandID {
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
	return jsonValue(map[string]any{"connectors": provider.routes.ConnectorSummaries(), "nextCursor": nil}), nil
}

func connectorCommandCapability(id string, path []string, summary string, schema map[string]any) cliservice.Capability {
	return cliservice.Capability{ID: id, Path: path, Summary: summary, Description: summary,
		Visibility: cliservice.CapabilityVisibilityPublic, InputSchema: schema,
		Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
		Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceBuiltin}}
}

func objectSchema(properties map[string]any, required []string) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	result := map[string]any{"type": "object", "additionalProperties": false, "properties": properties}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func jsonValue(value map[string]any) cliservice.CommandOutput {
	return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: value}
}
