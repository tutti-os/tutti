package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func (api DaemonAPI) CreateWorkspaceAgentSession(ctx context.Context, request tuttigenerated.CreateWorkspaceAgentSessionRequestObject) (tuttigenerated.CreateWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.CreateWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	if request.Body.AgentSessionId == uuid.Nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("agentSessionId must be a UUID")),
			),
		}, nil
	}
	agentSessionID := request.Body.AgentSessionId.String()
	agentTargetID := strings.TrimSpace(request.Body.AgentTargetId)
	if agentTargetID == "" {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("agentTargetId is required")),
			),
		}, nil
	}
	capabilityRefs, capabilityRefsErr := capabilityReferencesFromGenerated(request.Body.CapabilityRefs)
	if capabilityRefsErr != nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(capabilityRefsErr),
		}, nil
	}
	initialTuttiModeActivation, activationErr := tuttiModeActivationIntentFromGenerated(request.Body.InitialTuttiModeActivation)
	if activationErr != nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(activationErr),
		}, nil
	}
	clientSubmitID := strings.TrimSpace(request.Body.ClientSubmitId)
	metadata := agentSubmitMetadata(request.Body.SubmitDiagnostics)
	logCreateAgentSubmitTrace("api.create.received", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, "", "", nil)
	session, err := api.AgentSessionService.Create(ctx, string(request.WorkspaceID), agentservice.CreateSessionInput{
		AgentSessionID:             agentSessionID,
		ClientSubmitID:             clientSubmitID,
		AgentTargetID:              agentTargetID,
		InitialTuttiModeActivation: initialTuttiModeActivation,
		CapabilityRefs:             capabilityRefs,
		Cwd:                        request.Body.Cwd,
		InitialContent:             agentPromptContentFromGenerated(request.Body.InitialContent),
		InitialDisplayPrompt:       stringPtrValue(request.Body.InitialDisplayPrompt),
		Metadata:                   metadata,
		Model:                      request.Body.Model,
		PermissionModeID:           request.Body.PermissionModeId,
		PlanMode:                   request.Body.PlanMode,
		BrowserUse:                 request.Body.BrowserUse,
		ReasoningEffort:            request.Body.ReasoningEffort,
		RuntimeContext:             createSessionRuntimeContext(request.Body.NoProject),
		Speed:                      request.Body.Speed,
		Title:                      request.Body.Title,
		Visible:                    request.Body.Visible,
		ConversationDetailMode:     api.agentConversationDetailMode(ctx),
	})
	if err != nil {
		logCreateAgentSubmitTrace("api.create.failed", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, "", "", err)
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	logCreateAgentSubmitTrace("api.create.completed", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, session.Provider, agentSessionTurnPhase(session), nil)
	return tuttigenerated.CreateWorkspaceAgentSession201JSONResponse{
		Session: generatedSession,
	}, nil
}

func tuttiModeActivationIntentFromGenerated(input *tuttigenerated.TuttiModeActivationIntent) (*agentservice.TuttiModeActivationIntent, *apierrors.ProtocolError) {
	if input == nil {
		return nil, nil
	}
	if err := validateTuttiModeActivationEnums(input.Status, input.Source); err != nil {
		return nil, err
	}
	return &agentservice.TuttiModeActivationIntent{
		State:                  string(input.Status),
		Source:                 string(input.Source),
		OrchestrationIntensity: input.OrchestrationIntensity,
	}, nil
}

func createSessionRuntimeContext(noProject *bool) map[string]any {
	if noProject == nil || !*noProject {
		return nil
	}
	return map[string]any{"noProject": true}
}

func (api DaemonAPI) SendWorkspaceAgentSessionInput(ctx context.Context, request tuttigenerated.SendWorkspaceAgentSessionInputRequestObject) (tuttigenerated.SendWorkspaceAgentSessionInputResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	capabilityRefs, capabilityRefsErr := capabilityReferencesFromGenerated(request.Body.CapabilityRefs)
	if capabilityRefsErr != nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(capabilityRefsErr),
		}, nil
	}
	clientSubmitID := strings.TrimSpace(request.Body.ClientSubmitId)
	metadata := agentSubmitMetadata(request.Body.SubmitDiagnostics)
	logSendAgentSubmitTrace("api.send.received", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, "", "", "", nil)
	result, err := api.AgentSessionService.SendInput(ctx, string(request.WorkspaceID), string(request.AgentSessionID), agentservice.SendInput{
		CapabilityRefs: capabilityRefs,
		Content:        agentPromptContentFromGenerated(request.Body.Content),
		DisplayPrompt:  stringPtrValue(request.Body.DisplayPrompt),
		Guidance:       request.Body.Guidance != nil && *request.Body.Guidance,
		ClientSubmitID: clientSubmitID,
		Metadata:       metadata,
	})
	if err != nil {
		logSendAgentSubmitTrace("api.send.failed", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, "", "", "", err)
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	generatedSession, err := generatedAgentSession(result.Session)
	if err != nil {
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	logSendAgentSubmitTrace("api.send.completed", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, agentSessionTurnPhase(result.Session), result.TurnID, result.TurnLifecycle.Phase, nil)
	var response tuttigenerated.SendWorkspaceAgentSessionInputResponse
	if result.Kind == "goalControl" && result.GoalControl != nil {
		goalResult := result.GoalControl
		goalResponse := tuttigenerated.SendWorkspaceAgentSessionInputGoalControlResponse{
			Kind:    tuttigenerated.SendWorkspaceAgentSessionInputGoalControlResponseKindGoalControl,
			Session: generatedSession,
		}
		if goalResult.OperationID != "" {
			goalResponse.OperationId = &goalResult.OperationID
		}
		if goalResult.GoalState != nil {
			state := generatedAgentSessionGoalState(*goalResult.GoalState)
			goalResponse.GoalState = &state
		}
		if len(goalResult.Goal) > 0 {
			var goal tuttigenerated.WorkspaceAgentSessionGoal
			if decodeTypedAgentSessionField(goalResult.Goal, &goal) {
				goalResponse.Goal = &goal
			}
		}
		if err := response.FromSendWorkspaceAgentSessionInputGoalControlResponse(goalResponse); err != nil {
			return nil, err
		}
		return tuttigenerated.SendWorkspaceAgentSessionInput200JSONResponse(response), nil
	}
	turnID := strings.TrimSpace(result.TurnID)
	if turnID == "" || result.Turn == nil || strings.TrimSpace(result.Turn.TurnID) != turnID {
		return writeSendWorkspaceAgentSessionInputError(agentservice.ErrSubmitDeliveryUnknown), nil
	}
	turnResponse := tuttigenerated.SendWorkspaceAgentSessionInputTurnResponse{
		Kind:    tuttigenerated.SendWorkspaceAgentSessionInputTurnResponseKindTurn,
		Session: generatedSession,
		TurnId:  turnID,
		Turn:    agentservice.GeneratedWorkspaceAgentTurn(*result.Turn),
	}
	if err := response.FromSendWorkspaceAgentSessionInputTurnResponse(turnResponse); err != nil {
		return nil, err
	}
	return tuttigenerated.SendWorkspaceAgentSessionInput200JSONResponse(response), nil
}

func capabilityReferencesFromGenerated(input *[]tuttigenerated.WorkspaceAgentCapabilityReference) ([]agentservice.CapabilityReference, *apierrors.ProtocolError) {
	if input == nil {
		return nil, nil
	}
	result := make([]agentservice.CapabilityReference, 0, len(*input))
	seen := make(map[agentservice.CapabilityReference]struct{}, len(*input))
	for index, reference := range *input {
		if !reference.Capability.Valid() || !reference.Source.Valid() {
			return nil, apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage(fmt.Sprintf("capabilityRefs[%d] is invalid", index)),
			)
		}
		converted := agentservice.CapabilityReference{
			Capability: string(reference.Capability),
			Source:     string(reference.Source),
		}
		if _, duplicate := seen[converted]; duplicate {
			return nil, apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage(fmt.Sprintf("capabilityRefs[%d] duplicates an earlier reference", index)),
			)
		}
		seen[converted] = struct{}{}
		result = append(result, converted)
	}
	return result, nil
}

func agentSessionTurnPhase(session agentservice.Session) string {
	if session.ActiveTurn != nil {
		return session.ActiveTurn.Phase
	}
	if session.LatestTurn != nil {
		return session.LatestTurn.Phase
	}
	return ""
}

func agentSubmitMetadata(diagnostics *tuttigenerated.AgentSubmitDiagnostics) map[string]any {
	metadata := make(map[string]any)
	if diagnostics == nil {
		return nil
	}
	if diagnostics.SubmittedAtUnixMs != nil {
		metadata["clientSubmittedAtUnixMs"] = *diagnostics.SubmittedAtUnixMs
	}
	if diagnostics.BlockCount != nil {
		metadata["blockCount"] = *diagnostics.BlockCount
	}
	if diagnostics.HasImage != nil {
		metadata["hasImage"] = *diagnostics.HasImage
	}
	if diagnostics.PromptLength != nil {
		metadata["promptLength"] = *diagnostics.PromptLength
	}
	if diagnostics.Queued != nil {
		metadata["queued"] = *diagnostics.Queued
	}
	if diagnostics.Source != nil {
		metadata["source"] = strings.TrimSpace(*diagnostics.Source)
	}
	return metadata
}
