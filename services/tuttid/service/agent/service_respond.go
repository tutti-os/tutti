package agent

import (
	"context"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) Respond(ctx context.Context, input RespondInput) (RespondResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	turnID := strings.TrimSpace(input.TurnID)
	requestID := strings.TrimSpace(input.RequestID)
	semantic := strings.ToLower(strings.TrimSpace(input.Semantic))
	if workspaceID == "" || agentSessionID == "" || turnID == "" || requestID == "" {
		return RespondResult{}, ErrInvalidArgument
	}
	if semantic != "" && strings.TrimSpace(value(input.Action)) != "" {
		return RespondResult{}, fmt.Errorf("%w: action and semantic are mutually exclusive", ErrInvalidArgument)
	}

	action := input.Action
	if semantic != "" {
		if s.TurnStore == nil {
			return RespondResult{}, ErrInvalidArgument
		}
		interactions, err := s.TurnStore.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID, RequestID: requestID,
		})
		if err != nil {
			return RespondResult{}, err
		}
		if len(interactions) != 1 || strings.TrimSpace(interactions[0].TurnID) != turnID || strings.TrimSpace(interactions[0].RequestID) != requestID {
			return RespondResult{}, fmt.Errorf("%w: %q", ErrInteractionRequestNotFound, requestID)
		}
		matchingActions := make([]InteractionAction, 0, 1)
		for _, candidate := range interactionActions(interactions[0]) {
			if strings.EqualFold(strings.TrimSpace(candidate.Semantic), semantic) {
				matchingActions = append(matchingActions, candidate)
			}
		}
		switch len(matchingActions) {
		case 0:
			return RespondResult{}, fmt.Errorf("%w: %q for request %q", ErrInteractionSemanticNotFound, semantic, requestID)
		case 1:
			resolved := matchingActions[0].ID
			action = &resolved
		default:
			return RespondResult{}, fmt.Errorf("%w: %q matched %d actions for request %q", ErrInteractionSemanticAmbiguous, semantic, len(matchingActions), requestID)
		}
	}

	result, err := s.ApplicationHost().SubmitInteractive(
		ctx,
		agenthost.InteractionRef{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
			TurnID: turnID, RequestID: requestID,
		},
		agenthost.SubmitInteractiveInput{
			Action: action, OptionID: input.OptionID, Payload: clonePayload(input.Payload),
		},
	)
	if err != nil {
		return RespondResult{}, normalizeRuntimeError(err)
	}
	return RespondResult{
		RequestID: requestID, TurnID: turnID, Disposition: result.Disposition,
	}, nil
}

func interactionActions(interaction agentactivitybiz.Interaction) []InteractionAction {
	rawActions, ok := interaction.Metadata["actions"].([]any)
	if !ok {
		if typed, typedOK := interaction.Metadata["actions"].([]map[string]any); typedOK {
			rawActions = make([]any, 0, len(typed))
			for _, action := range typed {
				rawActions = append(rawActions, action)
			}
		}
	}
	actions := make([]InteractionAction, 0, len(rawActions))
	for _, raw := range rawActions {
		action, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(fmt.Sprint(action["id"]))
		if id == "" || id == "<nil>" {
			continue
		}
		label := strings.TrimSpace(fmt.Sprint(action["label"]))
		if label == "" || label == "<nil>" {
			label = id
		}
		semantic := strings.TrimSpace(fmt.Sprint(action["semantic"]))
		if semantic == "<nil>" {
			semantic = ""
		}
		actions = append(actions, InteractionAction{ID: id, Label: label, Semantic: semantic})
	}
	return actions
}
