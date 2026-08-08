package connectormarket

import (
	"context"
	"errors"

	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const (
	connectorAvailableCommandID = "connector.available"
)

type ConnectorBroker struct {
	broker *implementationhost.ConnectorBroker
}

type ConnectorRoutingHint = implementationhost.ConnectorRoutingHint

func NewConnectorBroker(registry *ConnectorRuntimeRegistry) (*ConnectorBroker, error) {
	if registry == nil {
		return nil, errors.New("connector runtime registry is required")
	}
	broker, err := implementationhost.NewConnectorBroker(registry.runtime)
	if err != nil {
		return nil, err
	}
	return &ConnectorBroker{broker: broker}, nil
}

func (broker *ConnectorBroker) RoutingHints() []ConnectorRoutingHint {
	if broker == nil || broker.broker == nil {
		return nil
	}
	return broker.broker.RoutingHints()
}

func (*ConnectorBroker) Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability {
	return []cliservice.Capability{
		brokerCapability(connectorAvailableCommandID, []string{"connector", "available"}, "List installed connectors available to every Agent", objectSchema(nil, nil)),
	}
}

func (broker *ConnectorBroker) Invoke(_ context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	if broker == nil || broker.broker == nil {
		return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
	}
	switch request.CommandID {
	case connectorAvailableCommandID:
		connectors, err := broker.broker.Available()
		if err != nil {
			return cliservice.CommandOutput{}, serviceError(err)
		}
		return jsonValue(map[string]any{"connectors": connectors, "nextCursor": nil}), nil
	default:
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
}

func serviceError(err error) error {
	switch {
	case errors.Is(err, command.ErrNotFound):
		return cliservice.ErrCommandNotFound
	case errors.Is(err, command.ErrInvalidInput):
		return cliservice.InvalidInputReasonError(command.ErrorCode(err), err.Error(), err)
	case errors.Is(err, command.ErrExecutionFailed):
		return cliservice.WorkspaceOperationError(err.Error(), err)
	default:
		return cliservice.ServiceUnavailableError(err.Error(), err)
	}
}

func brokerCapability(id string, path []string, summary string, schema map[string]any) cliservice.Capability {
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
