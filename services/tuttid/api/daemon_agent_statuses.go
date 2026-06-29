package api

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

func agentStatusServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.ServiceUnavailable(
			"agent_status_service_unavailable",
			apierrors.WithDeveloperMessage("agent provider status service is unavailable"),
		),
	)
}

func (api DaemonAPI) GetAgentProviderStatuses(ctx context.Context, request tuttigenerated.GetAgentProviderStatusesRequestObject) (tuttigenerated.GetAgentProviderStatusesResponseObject, error) {
	if api.AgentStatusService == nil {
		return tuttigenerated.GetAgentProviderStatuses503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentStatusServiceUnavailableError(),
		}, nil
	}

	snapshot, err := api.AgentStatusService.List(ctx, agentstatusservice.ListInput{
		Providers:      generatedAgentStatusProviders(request.Params.Providers),
		IncludeNetwork: request.Params.IncludeNetwork != nil && *request.Params.IncludeNetwork,
	})
	if err != nil {
		return writeGetAgentProviderStatusesError(err), nil
	}
	return tuttigenerated.GetAgentProviderStatuses200JSONResponse(
		generatedAgentProviderStatusList(snapshot, api.defaultAgentProvider(ctx)),
	), nil
}

func (api DaemonAPI) ProbeAgentProvider(ctx context.Context, request tuttigenerated.ProbeAgentProviderRequestObject) (tuttigenerated.ProbeAgentProviderResponseObject, error) {
	if api.AgentStatusService == nil {
		return tuttigenerated.ProbeAgentProvider503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentStatusServiceUnavailableError(),
		}, nil
	}

	result, err := api.AgentStatusService.Probe(ctx, agentstatusservice.ProbeInput{
		Provider: string(request.Provider),
	})
	if err != nil {
		return writeProbeAgentProviderError(err), nil
	}
	return tuttigenerated.ProbeAgentProvider200JSONResponse(
		generatedAgentProviderProbe(result),
	), nil
}

func (api DaemonAPI) RunAgentProviderAction(ctx context.Context, request tuttigenerated.RunAgentProviderActionRequestObject) (tuttigenerated.RunAgentProviderActionResponseObject, error) {
	if api.AgentStatusService == nil {
		return tuttigenerated.RunAgentProviderAction503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentStatusServiceUnavailableError(),
		}, nil
	}

	result, err := api.AgentStatusService.RunAction(ctx, agentstatusservice.RunActionInput{
		Provider: string(request.Provider),
		ActionID: agentstatusservice.ActionID(request.ActionID),
	})
	if err != nil {
		return writeRunAgentProviderActionError(err), nil
	}
	return tuttigenerated.RunAgentProviderAction200JSONResponse(
		generatedAgentProviderActionRun(result),
	), nil
}

func writeGetAgentProviderStatusesError(err error) tuttigenerated.GetAgentProviderStatusesResponseObject {
	if errors.Is(err, agentstatusservice.ErrInvalidProvider) {
		return tuttigenerated.GetAgentProviderStatuses400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetAgentProviderStatuses400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetAgentProviderStatuses503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.GetAgentProviderStatuses502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeProbeAgentProviderError(err error) tuttigenerated.ProbeAgentProviderResponseObject {
	if errors.Is(err, agentstatusservice.ErrInvalidProvider) {
		return tuttigenerated.ProbeAgentProvider400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ProbeAgentProvider400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ProbeAgentProvider503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.ProbeAgentProvider502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRunAgentProviderActionError(err error) tuttigenerated.RunAgentProviderActionResponseObject {
	if errors.Is(err, agentstatusservice.ErrInvalidProvider) || errors.Is(err, agentstatusservice.ErrInvalidAction) {
		return tuttigenerated.RunAgentProviderAction400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithCause(err)),
			),
		}
	}
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RunAgentProviderAction400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.RunAgentProviderAction503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.RunAgentProviderAction502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func generatedAgentStatusProviders(providers *[]tuttigenerated.WorkspaceAgentProvider) []string {
	if providers == nil || len(*providers) == 0 {
		return nil
	}
	result := make([]string, 0, len(*providers))
	for _, provider := range *providers {
		result = append(result, string(provider))
	}
	return result
}

func (api DaemonAPI) defaultAgentProvider(ctx context.Context) tuttigenerated.WorkspaceAgentProvider {
	defaultProvider := preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	if api.PreferencesService != nil {
		if preferences, err := api.PreferencesService.Get(ctx); err == nil {
			defaultProvider = preferences.DefaultAgentProvider
		}
	}
	normalized := agentproviderbiz.Normalize(defaultProvider)
	if normalized == "" {
		normalized = preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	}
	return tuttigenerated.WorkspaceAgentProvider(normalized)
}

func generatedAgentProviderStatusList(snapshot agentstatusservice.Snapshot, defaultProvider tuttigenerated.WorkspaceAgentProvider) tuttigenerated.AgentProviderStatusListResponse {
	return tuttigenerated.AgentProviderStatusListResponse{
		CapturedAt:      snapshot.CapturedAt,
		DefaultProvider: defaultProvider,
		Providers:       generatedAgentProviderStatuses(snapshot.Providers),
	}
}

func generatedAgentProviderActionRun(result agentstatusservice.RunActionResult) tuttigenerated.AgentProviderActionRunResponse {
	return tuttigenerated.AgentProviderActionRunResponse{
		ActionID:    tuttigenerated.AgentProviderActionID(result.ActionID),
		Command:     stringPointerIfNotBlank(result.Command),
		CompletedAt: result.CompletedAt,
		ExitCode:    result.ExitCode,
		Message:     stringPointerIfNotBlank(result.Message),
		Probe:       generatedAgentProviderProbePointer(result.Probe),
		Provider:    tuttigenerated.WorkspaceAgentProvider(result.Provider),
		ReasonCode:  stringPointerIfNotBlank(result.ReasonCode),
		Status:      tuttigenerated.AgentProviderActionRunStatus(result.Status),
		Stderr:      stringPointerIfNotBlank(result.Stderr),
		Stdout:      stringPointerIfNotBlank(result.Stdout),
	}
}

func generatedAgentProviderProbe(result agentstatusservice.ProbeResult) tuttigenerated.AgentProviderProbeResponse {
	return tuttigenerated.AgentProviderProbeResponse{
		BinaryPath: stringPointerIfNotBlank(result.BinaryPath),
		CheckedAt:  result.CheckedAt,
		Command:    cloneGeneratedStrings(result.Command),
		Message:    stringPointerIfNotBlank(result.Message),
		Provider:   tuttigenerated.WorkspaceAgentProvider(result.Provider),
		ReasonCode: stringPointerIfNotBlank(result.ReasonCode),
		Status:     tuttigenerated.AgentProviderProbeStatus(result.Status),
	}
}

func generatedAgentProviderProbePointer(result *agentstatusservice.ProbeResult) *tuttigenerated.AgentProviderProbeResponse {
	if result == nil {
		return nil
	}
	generated := generatedAgentProviderProbe(*result)
	return &generated
}

func generatedAgentProviderStatuses(statuses []agentstatusservice.ProviderStatus) []tuttigenerated.AgentProviderStatus {
	if len(statuses) == 0 {
		return []tuttigenerated.AgentProviderStatus{}
	}
	result := make([]tuttigenerated.AgentProviderStatus, 0, len(statuses))
	for _, status := range statuses {
		result = append(result, generatedAgentProviderStatus(status))
	}
	return result
}

func generatedAgentProviderStatus(status agentstatusservice.ProviderStatus) tuttigenerated.AgentProviderStatus {
	return tuttigenerated.AgentProviderStatus{
		ActiveAction: generatedAgentProviderActiveAction(status.Provider, status.ActiveAction),
		Actions:      generatedAgentProviderActions(status.Actions),
		Adapter:      generatedAgentProviderAdapterStatus(status.Adapter),
		Auth:         generatedAgentProviderAuthInfo(status.Auth),
		Availability: generatedAgentProviderAvailability(status.Availability),
		Cli:          generatedAgentProviderCLIStatus(status.CLI),
		Network:      generatedAgentProviderNetworkStatus(status.Network),
		Provider:     tuttigenerated.WorkspaceAgentProvider(status.Provider),
	}
}

func generatedAgentProviderActiveAction(provider string, action *agentstatusservice.ActiveAction) *tuttigenerated.AgentProviderActiveAction {
	if action == nil {
		return nil
	}
	logLines := activeActionLog(action.Stdout)
	phase := activeActionPhase(action.Step)
	slog.Info(
		"agent provider API mapped active action",
		"event", "tutti.agent_provider.api.active_action_mapped",
		"provider", provider,
		"phase", phase,
		"step", action.Step,
		"registryPresent", strings.TrimSpace(action.Registry) != "",
		"logLines", len(logLines),
	)
	return &tuttigenerated.AgentProviderActiveAction{
		Error:    nil,
		Log:      logLines,
		Phase:    phase,
		Registry: stringPointerIfNotBlank(action.Registry),
		Steps:    []tuttigenerated.AgentProviderActiveActionStep{},
	}
}

func activeActionPhase(step string) tuttigenerated.AgentProviderActiveActionPhase {
	switch strings.TrimSpace(step) {
	case "verify":
		return tuttigenerated.AgentProviderActiveActionPhaseVerify
	default:
		return tuttigenerated.AgentProviderActiveActionPhaseInstall
	}
}

func activeActionLog(output string) []string {
	output = strings.TrimSpace(output)
	if output == "" {
		return []string{}
	}
	lines := strings.Split(output, "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func generatedAgentProviderNetworkStatus(network *agentstatusservice.NetworkStatus) *tuttigenerated.AgentProviderNetworkStatus {
	if network == nil {
		return nil
	}
	result := tuttigenerated.AgentProviderNetworkStatus{
		Registry: generatedAgentProviderNetworkEndpoint(network.Registry),
	}
	if network.ProviderAPI != nil {
		api := generatedAgentProviderNetworkEndpoint(*network.ProviderAPI)
		result.ProviderApi = &api
	}
	if network.Proxy != nil {
		result.Proxy = &tuttigenerated.AgentProviderNetworkProxy{
			Configured: network.Proxy.Configured,
			Reachable:  network.Proxy.Reachable,
			Url:        stringPointerIfNotBlank(network.Proxy.URL),
			ReasonCode: stringPointerIfNotBlank(network.Proxy.ReasonCode),
		}
	}
	return &result
}

func generatedAgentProviderNetworkEndpoint(endpoint agentstatusservice.NetworkEndpointStatus) tuttigenerated.AgentProviderNetworkEndpoint {
	return tuttigenerated.AgentProviderNetworkEndpoint{
		Reachable:  endpoint.Reachable,
		Endpoint:   stringPointerIfNotBlank(endpoint.Endpoint),
		ReasonCode: stringPointerIfNotBlank(endpoint.ReasonCode),
	}
}

func generatedAgentProviderAvailability(availability agentstatusservice.Availability) tuttigenerated.AgentProviderAvailability {
	return tuttigenerated.AgentProviderAvailability{
		CheckedAt:  availability.CheckedAt,
		ReasonCode: stringPointerIfNotBlank(availability.ReasonCode),
		Status:     tuttigenerated.AgentProviderAvailabilityStatus(availability.Status),
	}
}

func generatedAgentProviderCLIStatus(status agentstatusservice.CLIStatus) tuttigenerated.AgentProviderCliStatus {
	return tuttigenerated.AgentProviderCliStatus{
		BinaryPath: stringPointerIfNotBlank(status.BinaryPath),
		Installed:  status.Installed,
		Version:    stringPointerIfNotBlank(status.Version),
		MinVersion: stringPointerIfNotBlank(status.MinVersion),
	}
}

func generatedAgentProviderAdapterStatus(status agentstatusservice.AdapterStatus) tuttigenerated.AgentProviderAdapterStatus {
	return tuttigenerated.AgentProviderAdapterStatus{
		BinaryPath:      stringPointerIfNotBlank(status.BinaryPath),
		Command:         cloneGeneratedStrings(status.Command),
		Installed:       status.Installed,
		Version:         stringPointerIfNotBlank(status.Version),
		RequiredVersion: stringPointerIfNotBlank(status.RequiredVersion),
	}
}

func generatedAgentProviderAuthInfo(auth agentstatusservice.AuthInfo) tuttigenerated.AgentProviderAuthInfo {
	return tuttigenerated.AgentProviderAuthInfo{
		AccountLabel: stringPointerIfNotBlank(auth.AccountLabel),
		AuthMethod:   stringPointerIfNotBlank(auth.AuthMethod),
		Status:       tuttigenerated.AgentProviderAuthStatus(auth.Status),
	}
}

func generatedAgentProviderActions(actions []agentstatusservice.Action) []tuttigenerated.AgentProviderAction {
	if len(actions) == 0 {
		return []tuttigenerated.AgentProviderAction{}
	}
	result := make([]tuttigenerated.AgentProviderAction, 0, len(actions))
	for _, action := range actions {
		result = append(result, tuttigenerated.AgentProviderAction{
			Command: generatedAgentProviderTerminalCommand(action.Command),
			Id:      tuttigenerated.AgentProviderActionID(action.ID),
			Kind:    tuttigenerated.AgentProviderActionKind(action.Kind),
		})
	}
	return result
}

func generatedAgentProviderTerminalCommand(command *agentstatusservice.TerminalCommand) *tuttigenerated.AgentProviderTerminalCommand {
	if command == nil {
		return nil
	}
	return &tuttigenerated.AgentProviderTerminalCommand{
		Cwd:   stringPointerIfNotBlank(command.CWD),
		Input: command.Input,
	}
}

func stringPointerIfNotBlank(value string) *string {
	if value == "" {
		return nil
	}
	return stringPointer(value)
}

func cloneGeneratedStrings(input []string) []string {
	if len(input) == 0 {
		return []string{}
	}
	result := make([]string, len(input))
	copy(result, input)
	return result
}
