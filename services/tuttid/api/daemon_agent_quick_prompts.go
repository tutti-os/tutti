package api

import (
	"context"
	"errors"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

type AgentQuickPromptService interface {
	List(context.Context) ([]agentquickpromptbiz.Prompt, error)
	Create(context.Context, agentquickpromptbiz.CreateInput) (agentquickpromptbiz.Prompt, error)
	Update(context.Context, agentquickpromptbiz.UpdateInput) (agentquickpromptbiz.Prompt, error)
	Delete(context.Context, agentquickpromptbiz.DeleteInput) error
	Move(context.Context, agentquickpromptbiz.MoveInput) ([]agentquickpromptbiz.Prompt, error)
}

func (api DaemonAPI) ListAgentQuickPrompts(ctx context.Context, _ tuttigenerated.ListAgentQuickPromptsRequestObject) (tuttigenerated.ListAgentQuickPromptsResponseObject, error) {
	if api.AgentQuickPromptService == nil {
		return tuttigenerated.ListAgentQuickPrompts503JSONResponse{ServiceUnavailableErrorJSONResponse: agentQuickPromptServiceUnavailableError()}, nil
	}
	prompts, err := api.AgentQuickPromptService.List(ctx)
	if err != nil {
		return tuttigenerated.ListAgentQuickPrompts502JSONResponse{AgentQuickPromptOperationErrorJSONResponse: quickPromptOperationError()}, nil
	}
	return tuttigenerated.ListAgentQuickPrompts200JSONResponse{Prompts: generatedAgentQuickPrompts(prompts)}, nil
}

func (api DaemonAPI) CreateAgentQuickPrompt(ctx context.Context, request tuttigenerated.CreateAgentQuickPromptRequestObject) (tuttigenerated.CreateAgentQuickPromptResponseObject, error) {
	if api.AgentQuickPromptService == nil {
		return tuttigenerated.CreateAgentQuickPrompt503JSONResponse{ServiceUnavailableErrorJSONResponse: agentQuickPromptServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	prompt, err := api.AgentQuickPromptService.Create(ctx, agentquickpromptbiz.CreateInput{Title: request.Body.Title, Content: request.Body.Content})
	if err != nil {
		switch {
		case errors.Is(err, agentquickpromptbiz.ErrInvalidArgument):
			return tuttigenerated.CreateAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: quickPromptInvalidRequestError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrLimitExceeded):
			return tuttigenerated.CreateAgentQuickPrompt409JSONResponse{AgentQuickPromptConflictErrorJSONResponse: quickPromptConflictError(apierrors.ReasonAgentQuickPromptLimitExceeded)}, nil
		default:
			return tuttigenerated.CreateAgentQuickPrompt502JSONResponse{AgentQuickPromptOperationErrorJSONResponse: quickPromptOperationError()}, nil
		}
	}
	return tuttigenerated.CreateAgentQuickPrompt201JSONResponse{Prompt: generatedAgentQuickPrompt(prompt)}, nil
}

func (api DaemonAPI) UpdateAgentQuickPrompt(ctx context.Context, request tuttigenerated.UpdateAgentQuickPromptRequestObject) (tuttigenerated.UpdateAgentQuickPromptResponseObject, error) {
	if api.AgentQuickPromptService == nil {
		return tuttigenerated.UpdateAgentQuickPrompt503JSONResponse{ServiceUnavailableErrorJSONResponse: agentQuickPromptServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	prompt, err := api.AgentQuickPromptService.Update(ctx, agentquickpromptbiz.UpdateInput{
		ID: request.PromptId, Title: request.Body.Title, Content: request.Body.Content, ExpectedVersion: request.Body.ExpectedVersion,
	})
	if err != nil {
		switch {
		case errors.Is(err, agentquickpromptbiz.ErrInvalidArgument):
			return tuttigenerated.UpdateAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: quickPromptInvalidRequestError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrNotFound):
			return tuttigenerated.UpdateAgentQuickPrompt404JSONResponse{AgentQuickPromptNotFoundErrorJSONResponse: quickPromptNotFoundError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrVersionConflict):
			return tuttigenerated.UpdateAgentQuickPrompt409JSONResponse{AgentQuickPromptConflictErrorJSONResponse: quickPromptConflictError(apierrors.ReasonAgentQuickPromptVersionConflict)}, nil
		default:
			return tuttigenerated.UpdateAgentQuickPrompt502JSONResponse{AgentQuickPromptOperationErrorJSONResponse: quickPromptOperationError()}, nil
		}
	}
	return tuttigenerated.UpdateAgentQuickPrompt200JSONResponse{Prompt: generatedAgentQuickPrompt(prompt)}, nil
}

func (api DaemonAPI) DeleteAgentQuickPrompt(ctx context.Context, request tuttigenerated.DeleteAgentQuickPromptRequestObject) (tuttigenerated.DeleteAgentQuickPromptResponseObject, error) {
	if api.AgentQuickPromptService == nil {
		return tuttigenerated.DeleteAgentQuickPrompt503JSONResponse{ServiceUnavailableErrorJSONResponse: agentQuickPromptServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.DeleteAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	err := api.AgentQuickPromptService.Delete(ctx, agentquickpromptbiz.DeleteInput{ID: request.PromptId, ExpectedVersion: request.Body.ExpectedVersion})
	if err != nil {
		switch {
		case errors.Is(err, agentquickpromptbiz.ErrInvalidArgument):
			return tuttigenerated.DeleteAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: quickPromptInvalidRequestError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrNotFound):
			return tuttigenerated.DeleteAgentQuickPrompt404JSONResponse{AgentQuickPromptNotFoundErrorJSONResponse: quickPromptNotFoundError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrVersionConflict):
			return tuttigenerated.DeleteAgentQuickPrompt409JSONResponse{AgentQuickPromptConflictErrorJSONResponse: quickPromptConflictError(apierrors.ReasonAgentQuickPromptVersionConflict)}, nil
		default:
			return tuttigenerated.DeleteAgentQuickPrompt502JSONResponse{AgentQuickPromptOperationErrorJSONResponse: quickPromptOperationError()}, nil
		}
	}
	return tuttigenerated.DeleteAgentQuickPrompt204Response{}, nil
}

func (api DaemonAPI) MoveAgentQuickPrompt(ctx context.Context, request tuttigenerated.MoveAgentQuickPromptRequestObject) (tuttigenerated.MoveAgentQuickPromptResponseObject, error) {
	if api.AgentQuickPromptService == nil {
		return tuttigenerated.MoveAgentQuickPrompt503JSONResponse{ServiceUnavailableErrorJSONResponse: agentQuickPromptServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.MoveAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	prompts, err := api.AgentQuickPromptService.Move(ctx, agentquickpromptbiz.MoveInput{
		PromptID: request.Body.PromptId, BeforePromptID: request.Body.BeforePromptId, ExpectedVersion: request.Body.ExpectedVersion,
	})
	if err != nil {
		switch {
		case errors.Is(err, agentquickpromptbiz.ErrInvalidArgument):
			return tuttigenerated.MoveAgentQuickPrompt400JSONResponse{InvalidRequestErrorJSONResponse: quickPromptInvalidRequestError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrNotFound):
			return tuttigenerated.MoveAgentQuickPrompt404JSONResponse{AgentQuickPromptNotFoundErrorJSONResponse: quickPromptNotFoundError()}, nil
		case errors.Is(err, agentquickpromptbiz.ErrVersionConflict):
			return tuttigenerated.MoveAgentQuickPrompt409JSONResponse{AgentQuickPromptConflictErrorJSONResponse: quickPromptConflictError(apierrors.ReasonAgentQuickPromptVersionConflict)}, nil
		case errors.Is(err, agentquickpromptbiz.ErrOrderConflict):
			return tuttigenerated.MoveAgentQuickPrompt409JSONResponse{AgentQuickPromptConflictErrorJSONResponse: quickPromptConflictError(apierrors.ReasonAgentQuickPromptOrderConflict)}, nil
		default:
			return tuttigenerated.MoveAgentQuickPrompt502JSONResponse{AgentQuickPromptOperationErrorJSONResponse: quickPromptOperationError()}, nil
		}
	}
	return tuttigenerated.MoveAgentQuickPrompt200JSONResponse{Prompts: generatedAgentQuickPrompts(prompts)}, nil
}

func generatedAgentQuickPrompts(prompts []agentquickpromptbiz.Prompt) []tuttigenerated.AgentQuickPrompt {
	result := make([]tuttigenerated.AgentQuickPrompt, 0, len(prompts))
	for _, prompt := range prompts {
		result = append(result, generatedAgentQuickPrompt(prompt))
	}
	return result
}

func generatedAgentQuickPrompt(prompt agentquickpromptbiz.Prompt) tuttigenerated.AgentQuickPrompt {
	return tuttigenerated.AgentQuickPrompt{
		Id: prompt.ID, Title: prompt.Title, Content: prompt.Content, Version: prompt.Version,
		CreatedAtUnixMs: prompt.CreatedAtUnixMS, UpdatedAtUnixMs: prompt.UpdatedAtUnixMS,
	}
}

func agentQuickPromptServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.AgentQuickPromptServiceUnavailable(apierrors.WithDeveloperMessage("agent quick prompt service is unavailable")))
}

func quickPromptInvalidRequestError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(apierrors.ReasonMalformedRequest,
		apierrors.WithDeveloperMessage("agent quick prompt fields are invalid"),
		apierrors.WithParams(map[string]any{"maxTitleCodePoints": agentquickpromptbiz.MaxTitleRunes, "maxContentBytes": agentquickpromptbiz.MaxContentBytes}),
	))
}

func quickPromptNotFoundError() tuttigenerated.AgentQuickPromptNotFoundErrorJSONResponse {
	return agentQuickPromptNotFoundError(apierrors.AgentQuickPromptNotFound(apierrors.WithDeveloperMessage("agent quick prompt not found")))
}

func quickPromptConflictError(reason string) tuttigenerated.AgentQuickPromptConflictErrorJSONResponse {
	return agentQuickPromptConflictError(apierrors.AgentQuickPromptConflict(reason, apierrors.WithDeveloperMessage("agent quick prompt state conflicts with the request")))
}

func quickPromptOperationError() tuttigenerated.AgentQuickPromptOperationErrorJSONResponse {
	return agentQuickPromptOperationError(apierrors.AgentQuickPromptOperationFailed(apierrors.WithDeveloperMessage("agent quick prompt operation failed")))
}
