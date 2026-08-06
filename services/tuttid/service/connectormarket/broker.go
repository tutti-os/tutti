package connectormarket

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const (
	connectorAvailableCommandID    = "connector.available"
	connectorCapabilitiesCommandID = "connector.capabilities"
	connectorSkillsCommandID       = "connector.skills"
	connectorSkillReadCommandID    = "connector.skill.read"
	connectorInvokeCommandID       = "connector.invoke"
)

type ConnectorBroker struct {
	broker *implementationhost.ConnectorBroker
}

func NewConnectorBroker(commands *ConnectorCommandRegistry) (*ConnectorBroker, error) {
	if commands == nil {
		return nil, errors.New("connector command registry is required")
	}
	broker, err := implementationhost.NewConnectorBroker(commands.runtime)
	if err != nil {
		return nil, err
	}
	return &ConnectorBroker{broker: broker}, nil
}

func (*ConnectorBroker) Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability {
	return []cliservice.Capability{
		brokerCapability(connectorAvailableCommandID, []string{"connector", "available"}, "List installed connectors available to every Agent", objectSchema(nil, nil)),
		brokerCapability(connectorCapabilitiesCommandID, []string{"connector", "capabilities"}, "List an installed connector's canonical capabilities", objectSchema(
			map[string]any{"connector": map[string]any{"type": "string"}}, []string{"connector"})),
		brokerCapability(connectorSkillsCommandID, []string{"connector", "skills"}, "List a connector's Skills", objectSchema(
			map[string]any{"connector": map[string]any{"type": "string"}}, []string{"connector"})),
		brokerCapability(connectorSkillReadCommandID, []string{"connector", "skill", "read"}, "Read one connector Skill", objectSchema(
			map[string]any{"connector": map[string]any{"type": "string"}, "skill": map[string]any{"type": "string"}}, []string{"connector", "skill"})),
		brokerCapability(connectorInvokeCommandID, []string{"connector", "invoke"}, "Invoke an installed connector capability", objectSchema(
			map[string]any{"connector": map[string]any{"type": "string"}, "capability": map[string]any{"type": "string", "description": "Canonical connector capability id"},
				"input-json": map[string]any{"type": "string", "description": "JSON object passed to the connector capability"}},
			[]string{"connector", "capability"})),
	}
}

func (broker *ConnectorBroker) Invoke(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
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
	case connectorCapabilitiesCommandID:
		capabilities, err := broker.broker.Capabilities(stringInput(request.Input, "connector"))
		if err != nil {
			return cliservice.CommandOutput{}, serviceError(err)
		}
		return jsonValue(map[string]any{"connectorKey": stringInput(request.Input, "connector"),
			"capabilities": capabilities, "nextCursor": nil}), nil
	case connectorSkillsCommandID:
		skills, err := broker.broker.Skills(stringInput(request.Input, "connector"))
		if err != nil {
			return cliservice.CommandOutput{}, serviceError(err)
		}
		return jsonValue(map[string]any{"connectorKey": stringInput(request.Input, "connector"), "skills": skills, "nextCursor": nil}), nil
	case connectorSkillReadCommandID:
		skill, err := broker.broker.ReadSkill(stringInput(request.Input, "connector"), stringInput(request.Input, "skill"))
		if err != nil {
			return cliservice.CommandOutput{}, serviceError(err)
		}
		value, _ := json.Marshal(skill)
		var result map[string]any
		_ = json.Unmarshal(value, &result)
		result["connectorKey"] = stringInput(request.Input, "connector")
		return jsonValue(result), nil
	case connectorInvokeCommandID:
		input := map[string]any{}
		if raw := stringInput(request.Input, "input-json"); raw != "" {
			if err := json.Unmarshal([]byte(raw), &input); err != nil {
				return cliservice.CommandOutput{}, cliservice.InvalidInputReasonError("connector_input_json_invalid", "--input-json must be a JSON object", err)
			}
		}
		output, err := broker.broker.Invoke(ctx, stringInput(request.Input, "connector"), stringInput(request.Input, "capability"), input,
			command.InvokeContext{Source: request.Context.Source, WorkspaceID: request.Context.WorkspaceID,
				AgentSessionID: request.Context.AgentSessionID, ParentCommandID: request.Context.ParentCommandID})
		if err != nil {
			return cliservice.CommandOutput{}, serviceError(err)
		}
		return jsonValue(output.Value), nil
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

func stringInput(input map[string]any, key string) string {
	value, _ := input[key].(string)
	return strings.TrimSpace(value)
}
