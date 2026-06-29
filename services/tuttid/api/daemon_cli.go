package api

import (
	"context"
	"errors"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func (api DaemonAPI) ListCliCapabilities(ctx context.Context, request tuttigenerated.ListCliCapabilitiesRequestObject) (tuttigenerated.ListCliCapabilitiesResponseObject, error) {
	if api.CLIRegistry == nil {
		return tuttigenerated.ListCliCapabilities503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("cli_registry_unavailable", apierrors.WithDeveloperMessage("cli registry is unavailable")),
			),
		}, nil
	}

	workspaceID := ""
	if request.Params.WorkspaceID != nil {
		workspaceID = *request.Params.WorkspaceID
	}
	includeHidden := request.Params.IncludeHidden != nil && *request.Params.IncludeHidden
	includeIntegration := request.Params.IncludeIntegration != nil && *request.Params.IncludeIntegration
	capabilities := api.CLIRegistry.Capabilities(ctx, cliservice.InvokeContext{
		Source:                         "cli",
		WorkspaceID:                    workspaceID,
		SkipCapabilityFilters:          includeHidden,
		IncludeIntegrationCapabilities: includeHidden || includeIntegration,
	})
	return tuttigenerated.ListCliCapabilities200JSONResponse{
		Commands: generatedCliCapabilities(capabilities),
	}, nil
}

func (api DaemonAPI) InvokeCliCommand(ctx context.Context, request tuttigenerated.InvokeCliCommandRequestObject) (tuttigenerated.InvokeCliCommandResponseObject, error) {
	if api.CLIRegistry == nil {
		return tuttigenerated.InvokeCliCommand503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("cli_registry_unavailable", apierrors.WithDeveloperMessage("cli registry is unavailable")),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.InvokeCliCommand400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}

	output, err := api.CLIRegistry.Invoke(ctx, cliservice.InvokeRequest{
		CommandID:  request.CommandID,
		Input:      generatedCliInput(request.Body.Input),
		OutputMode: serviceCliOutputMode(request.Body.OutputMode),
		Context:    serviceCliContext(request.Body.Context),
	})
	if err != nil {
		return writeInvokeCliCommandError(err), nil
	}
	return tuttigenerated.InvokeCliCommand200JSONResponse{
		Ok:     true,
		Output: generatedCliCommandOutput(output),
	}, nil
}

func writeInvokeCliCommandError(err error) tuttigenerated.InvokeCliCommandResponseObject {
	if errors.Is(err, cliservice.ErrCommandNotFound) {
		return tuttigenerated.InvokeCliCommand404JSONResponse(protocolErrorResponse(
			apierrors.InvalidRequest("cli_command_not_found", apierrors.WithDeveloperMessage("cli command not found")),
		))
	}
	if errors.Is(err, cliservice.ErrInvalidInput) {
		return tuttigenerated.InvokeCliCommand400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithCause(err)),
			),
		}
	}
	if errors.Is(err, cliservice.ErrServiceUnavailable) {
		reason := cliservice.InvokeErrorReason(err)
		if reason == "" {
			reason = "cli_service_unavailable"
		}
		return tuttigenerated.InvokeCliCommand503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(reason, apierrors.WithCause(err)),
			),
		}
	}
	if errors.Is(err, cliservice.ErrWorkspaceOperation) {
		return tuttigenerated.InvokeCliCommand502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.InvokeCliCommand400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.InvokeCliCommand503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.InvokeCliCommand502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func generatedCliCapabilities(capabilities []cliservice.Capability) []tuttigenerated.CliCapability {
	if len(capabilities) == 0 {
		return []tuttigenerated.CliCapability{}
	}
	result := make([]tuttigenerated.CliCapability, 0, len(capabilities))
	for _, capability := range capabilities {
		result = append(result, generatedCliCapability(capability))
	}
	return result
}

func generatedCliCapability(capability cliservice.Capability) tuttigenerated.CliCapability {
	var description *string
	if capability.Description != "" {
		description = stringPointer(capability.Description)
	}
	var inputSchema *map[string]interface{}
	if len(capability.InputSchema) > 0 {
		schema := make(map[string]interface{}, len(capability.InputSchema))
		for key, value := range capability.InputSchema {
			schema[key] = value
		}
		inputSchema = &schema
	}
	return tuttigenerated.CliCapability{
		Id:          capability.ID,
		Path:        capability.Path,
		Summary:     capability.Summary,
		Description: description,
		Visibility:  generatedCliCapabilityVisibility(capability.Visibility),
		InputSchema: inputSchema,
		Output:      generatedCliCapabilityOutput(capability.Output),
		Source:      generatedCliCapabilitySource(capability.Source),
	}
}

func generatedCliCapabilityVisibility(visibility cliservice.CapabilityVisibility) *tuttigenerated.CliCapabilityVisibility {
	result := tuttigenerated.Public
	if cliservice.NormalizeCapabilityVisibility(visibility) == cliservice.CapabilityVisibilityIntegration {
		result = tuttigenerated.Integration
	}
	return &result
}

func generatedCliCapabilitySource(source cliservice.CapabilitySource) tuttigenerated.CliCapabilitySource {
	if source.Kind == cliservice.CapabilitySourceApp {
		return tuttigenerated.CliCapabilitySource{
			Kind:              tuttigenerated.App,
			AppId:             stringPointerIfNotBlank(source.AppID),
			AppName:           stringPointerIfNotBlank(source.AppName),
			IconUrl:           stringPointerIfNotBlank(source.IconURL),
			CliDescription:    stringPointerIfNotBlank(source.CLIDescription),
			AppDescription:    stringPointerIfNotBlank(source.AppDescription),
			DocumentationFile: stringPointerIfNotBlank(source.DocumentationFile),
			DocumentationPath: stringPointerIfNotBlank(source.DocumentationPath),
		}
	}
	return tuttigenerated.CliCapabilitySource{Kind: tuttigenerated.Builtin}
}

func generatedCliCapabilityOutput(output cliservice.CapabilityOutput) tuttigenerated.CliCapabilityOutput {
	return tuttigenerated.CliCapabilityOutput{
		DefaultMode: generatedCliOutputMode(output.DefaultMode),
		Json:        output.JSON,
		Table:       generatedCliTableOutput(output.Table),
	}
}

func generatedCliTableOutput(output *cliservice.TableOutput) *tuttigenerated.CliTableOutput {
	if output == nil {
		return nil
	}
	return &tuttigenerated.CliTableOutput{Columns: generatedCliTableColumns(output.Columns)}
}

func generatedCliCommandOutput(output cliservice.CommandOutput) *tuttigenerated.CliCommandOutput {
	result := &tuttigenerated.CliCommandOutput{
		Kind: generatedCliOutputMode(output.Kind),
	}
	if len(output.Columns) > 0 {
		columns := generatedCliTableColumns(output.Columns)
		result.Columns = &columns
	}
	if output.Rows != nil {
		rows := make([]map[string]interface{}, 0, len(output.Rows))
		for _, row := range output.Rows {
			converted := make(map[string]interface{}, len(row))
			for key, value := range row {
				converted[key] = value
			}
			rows = append(rows, converted)
		}
		result.Rows = &rows
	}
	if len(output.Value) > 0 {
		value := make(map[string]interface{}, len(output.Value))
		for key, entry := range output.Value {
			value[key] = entry
		}
		result.Value = &value
	}
	if len(output.Warnings) > 0 {
		warnings := make([]tuttigenerated.CliCommandWarning, 0, len(output.Warnings))
		for _, warning := range output.Warnings {
			warnings = append(warnings, tuttigenerated.CliCommandWarning{
				Code:    warning.Code,
				Message: warning.Message,
			})
		}
		result.Warnings = &warnings
	}
	if output.Text != "" {
		result.Text = stringPointer(output.Text)
	}
	return result
}

func generatedCliTableColumns(columns []cliservice.TableColumn) []tuttigenerated.CliTableColumn {
	if len(columns) == 0 {
		return []tuttigenerated.CliTableColumn{}
	}
	result := make([]tuttigenerated.CliTableColumn, 0, len(columns))
	for _, column := range columns {
		result = append(result, tuttigenerated.CliTableColumn{
			Key:   column.Key,
			Label: column.Label,
		})
	}
	return result
}

func generatedCliOutputMode(mode cliservice.OutputMode) tuttigenerated.CliOutputMode {
	switch mode {
	case cliservice.OutputModeJSON:
		return tuttigenerated.Json
	case cliservice.OutputModePlain:
		return tuttigenerated.Plain
	case cliservice.OutputModeMarkdown:
		return tuttigenerated.Markdown
	default:
		return tuttigenerated.Table
	}
}

func serviceCliOutputMode(mode *tuttigenerated.CliOutputMode) cliservice.OutputMode {
	if mode == nil {
		return ""
	}
	switch *mode {
	case tuttigenerated.Json:
		return cliservice.OutputModeJSON
	case tuttigenerated.Plain:
		return cliservice.OutputModePlain
	case tuttigenerated.Markdown:
		return cliservice.OutputModeMarkdown
	default:
		return cliservice.OutputModeTable
	}
}

func serviceCliContext(contextValue *tuttigenerated.CliInvokeContext) cliservice.InvokeContext {
	if contextValue == nil {
		return cliservice.InvokeContext{Source: "cli"}
	}
	workspaceID := ""
	if contextValue.WorkspaceID != nil {
		workspaceID = *contextValue.WorkspaceID
	}
	parentCommandID := ""
	if contextValue.ParentCommandId != nil {
		parentCommandID = *contextValue.ParentCommandId
	}
	agentSessionID := ""
	if contextValue.AgentSessionId != nil {
		agentSessionID = *contextValue.AgentSessionId
	}
	return cliservice.InvokeContext{
		Source:          contextValue.Source,
		WorkspaceID:     workspaceID,
		ParentCommandID: parentCommandID,
		AgentSessionID:  agentSessionID,
	}
}

func generatedCliInput(input *map[string]interface{}) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	result := make(map[string]any, len(*input))
	for key, value := range *input {
		result[key] = value
	}
	return result
}
