package api

import (
	"context"
	"errors"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// ListAgentProviderPlugins exposes a daemon-owned snapshot only. `prime`
// starts a background refresh; it never turns this request into a synchronous
// App Server discovery call.
func (api DaemonAPI) ListAgentProviderPlugins(
	ctx context.Context,
	request tuttigenerated.ListAgentProviderPluginsRequestObject,
) (tuttigenerated.ListAgentProviderPluginsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListAgentProviderPlugins503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.ListAgentProviderPlugins400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	input := agentservice.ComposerPluginOptionsInput{Provider: string(request.Provider)}
	input.AgentTargetID = strings.TrimSpace(request.Body.AgentTargetId)
	input.Cwd = optionalStringValue(request.Body.Cwd)
	if request.Body.Prime != nil && *request.Body.Prime {
		if err := api.AgentSessionService.PrimeComposerPluginInventory(ctx, input); err != nil {
			return writeListAgentProviderPluginsError(err), nil
		}
	}
	options, err := api.AgentSessionService.GetComposerPluginOptions(ctx, input)
	if err != nil {
		return writeListAgentProviderPluginsError(err), nil
	}
	return tuttigenerated.ListAgentProviderPlugins200JSONResponse(
		generatedAgentProviderPluginOptions(options),
	), nil
}

func writeListAgentProviderPluginsError(
	err error,
) tuttigenerated.ListAgentProviderPluginsResponseObject {
	switch {
	case errors.Is(err, agentservice.ErrComposerPluginInventoryTargetNotFound):
		return tuttigenerated.ListAgentProviderPlugins404JSONResponse{
			AgentTargetNotFoundErrorJSONResponse: agentTargetNotFoundError(),
		}
	case errors.Is(err, agentservice.ErrComposerPluginInventoryUnavailable):
		return tuttigenerated.ListAgentProviderPlugins503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"composer_plugin_inventory_unavailable",
					apierrors.WithCause(err),
				),
			),
		}
	case errors.Is(err, agentservice.ErrInvalidArgument):
		return tuttigenerated.ListAgentProviderPlugins400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(apierrors.ReasonMalformedRequest, apierrors.WithCause(err)),
			),
		}
	default:
		return tuttigenerated.ListAgentProviderPlugins502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)),
			),
		}
	}
}

func generatedAgentProviderPluginOptions(
	options agentservice.ComposerPluginOptions,
) tuttigenerated.AgentProviderPluginListResponse {
	plugins := make([]tuttigenerated.AgentProviderPluginOption, 0, len(options.Plugins))
	for _, option := range options.Plugins {
		id := strings.TrimSpace(option.ID)
		name := strings.TrimSpace(option.Name)
		label := strings.TrimSpace(option.Label)
		semantic := strings.TrimSpace(option.Semantic)
		if id == "" || name == "" || label == "" || semantic == "" {
			continue
		}
		item := tuttigenerated.AgentProviderPluginOption{
			Id:       id,
			Name:     name,
			Label:    label,
			Semantic: tuttigenerated.AgentProviderPluginSemantic(semantic),
			Status:   tuttigenerated.AgentProviderPluginStatus(option.Status),
		}
		if description := strings.TrimSpace(option.Description); description != "" {
			item.Description = &description
		}
		if len(option.BundledSkills) > 0 {
			skills := make([]tuttigenerated.AgentProviderPluginBundledSkill, 0, len(option.BundledSkills))
			for _, skill := range option.BundledSkills {
				name := strings.TrimSpace(skill.Name)
				path := strings.TrimSpace(skill.Path)
				if name == "" || path == "" {
					continue
				}
				skills = append(skills, tuttigenerated.AgentProviderPluginBundledSkill{
					Name: name,
					Path: &path,
				})
			}
			if len(skills) > 0 {
				item.BundledSkills = &skills
			}
		}
		plugins = append(plugins, item)
	}
	return tuttigenerated.AgentProviderPluginListResponse{
		Partial:  options.Partial,
		Plugins:  plugins,
		Provider: tuttigenerated.WorkspaceAgentProvider(options.Provider),
	}
}
