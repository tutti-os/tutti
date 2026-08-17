package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
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
	initialGoalControl := initialGoalControlFromGenerated(request.Body.InitialGoalControl)
	clientSubmitID := strings.TrimSpace(request.Body.ClientSubmitId)
	if diagnosticsErr := validateAgentSubmitDiagnostics(request.Body.SubmitDiagnostics); diagnosticsErr != nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(diagnosticsErr),
		}, nil
	}
	metadata := agentSubmitMetadata(request.Body.SubmitDiagnostics)
	isolation := ""
	if request.Body.Isolation != nil {
		isolation = string(*request.Body.Isolation)
	}
	var recordingID string
	if request.Body.RecordingId != nil {
		if api.AgentSessionRecordingService == nil {
			return tuttigenerated.CreateWorkspaceAgentSession503JSONResponse{
				ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
			}, nil
		}
		recordingID = request.Body.RecordingId.String()
		if _, err := api.AgentSessionRecordingService.Bind(ctx, agentsessionreplay.BindInput{
			RecordingID:    recordingID,
			WorkspaceID:    string(request.WorkspaceID),
			AgentTargetID:  agentTargetID,
			AgentSessionID: agentSessionID,
		}); err != nil {
			return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.MalformedRequest(apierrors.WithCause(err)),
				),
			}, nil
		}
	}
	logCreateAgentSubmitTrace("api.create.received", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, "", "", nil)
	session, err := api.AgentSessionService.Create(ctx, string(request.WorkspaceID), agentservice.CreateSessionInput{
		AgentSessionID:             agentSessionID,
		ClientSubmitID:             clientSubmitID,
		AgentTargetID:              agentTargetID,
		InitialGoalControl:         initialGoalControl,
		InitialTuttiModeActivation: initialTuttiModeActivation,
		CapabilityRefs:             capabilityRefs,
		Cwd:                        request.Body.Cwd,
		Isolation:                  isolation,
		InitialContent:             agentPromptContentFromGenerated(request.Body.InitialContent),
		InitialDisplayPrompt:       stringPtrValue(request.Body.InitialDisplayPrompt),
		Metadata:                   metadata,
		Model:                      request.Body.Model,
		ModelExplicit:              request.Body.ModelExplicit,
		PermissionModeID:           request.Body.PermissionModeId,
		PlanMode:                   request.Body.PlanMode,
		BrowserUse:                 request.Body.BrowserUse,
		CodexSaverMode:             request.Body.CodexSaverMode,
		CodexSaverModeAllowed:      api.codexSaverModeEnabled(ctx),
		ReasoningEffort:            request.Body.ReasoningEffort,
		ReasoningEffortExplicit:    request.Body.ReasoningEffortExplicit,
		RuntimeContext:             createSessionRuntimeContext(request.Body.NoProject),
		RailPlacement:              railPlacementFromGenerated(request.Body.RailPlacement),
		Speed:                      request.Body.Speed,
		Title:                      request.Body.Title,
		Visible:                    request.Body.Visible,
		ConversationDetailMode:     api.agentConversationDetailMode(ctx),
	})
	if err != nil {
		if recordingID != "" {
			_, _ = api.AgentSessionRecordingService.Cancel(ctx, recordingID)
		}
		logCreateAgentSubmitTrace("api.create.failed", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, "", "", err)
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	generatedSession, err := generatedAgentSession(session)
	if err != nil {
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	logCreateAgentSubmitTrace("api.create.completed", string(request.WorkspaceID), agentSessionID, clientSubmitID, metadata, session.Provider, agentSessionTurnPhase(session), nil)
	if recordingID != "" &&
		!isRendererEngineCommandOrigin(
			request.Params.XTuttiAgentCommandOrigin,
		) {
		stimulusPayload := map[string]any{
			"agentTargetId":              agentTargetID,
			"browserUse":                 request.Body.BrowserUse,
			"codexSaverMode":             request.Body.CodexSaverMode,
			"capabilityRefs":             request.Body.CapabilityRefs,
			"clientSubmitId":             clientSubmitID,
			"content":                    request.Body.InitialContent,
			"cwd":                        request.Body.Cwd,
			"displayPrompt":              request.Body.InitialDisplayPrompt,
			"initialGoalControl":         request.Body.InitialGoalControl,
			"initialTuttiModeActivation": request.Body.InitialTuttiModeActivation,
			"isolation":                  request.Body.Isolation,
			"model":                      request.Body.Model,
			"noProject":                  request.Body.NoProject,
			"permissionModeId":           request.Body.PermissionModeId,
			"planMode":                   request.Body.PlanMode,
			"railPlacement":              request.Body.RailPlacement,
			"reasoningEffort":            request.Body.ReasoningEffort,
			"speed":                      request.Body.Speed,
			"submitDiagnostics":          request.Body.SubmitDiagnostics,
			"title":                      request.Body.Title,
			"visible":                    request.Body.Visible,
		}
		applyEffectiveCreateSessionLaunch(stimulusPayload, session)
		api.recordAgentStimulus(
			ctx,
			"session.create",
			string(request.WorkspaceID),
			agentSessionID,
			stimulusPayload,
		)
	}
	return tuttigenerated.CreateWorkspaceAgentSession201JSONResponse{
		Session: generatedSession,
	}, nil
}

func applyEffectiveCreateSessionLaunch(payload map[string]any, session agentservice.Session) {
	if payload == nil {
		return
	}
	if cwd := strings.TrimSpace(session.Cwd); cwd != "" {
		payload["cwd"] = cwd
	}
	if session.Isolation != nil && strings.TrimSpace(session.Isolation.Mode) != "" {
		payload["isolation"] = strings.TrimSpace(session.Isolation.Mode)
	}
	if session.Settings == nil {
		return
	}
	payload["browserUse"] = session.Settings.BrowserUse
	payload["model"] = session.Settings.Model
	payload["permissionModeId"] = session.Settings.PermissionModeID
	payload["planMode"] = session.Settings.PlanMode
	payload["reasoningEffort"] = session.Settings.ReasoningEffort
	payload["speed"] = session.Settings.Speed
}

func initialGoalControlFromGenerated(input *tuttigenerated.WorkspaceAgentInitialGoalControl) *agenthost.TypedGoalControl {
	if input == nil {
		return nil
	}
	return &agenthost.TypedGoalControl{
		Action:    string(input.Action),
		Objective: stringPtrValue(input.Objective),
	}
}

func tuttiModeActivationIntentFromGenerated(input *tuttigenerated.TuttiModeActivationIntent) (*agentservice.TuttiModeActivationIntent, *apierrors.ProtocolError) {
	if input == nil {
		return nil, nil
	}
	if err := validateTuttiModeActivationEnums(input.Status, input.Source); err != nil {
		return nil, err
	}
	return &agentservice.TuttiModeActivationIntent{
		State:  string(input.Status),
		Source: string(input.Source),
		Effect: firstPreference(input.Effect, input.OrchestrationIntensity),
		Speed:  input.Speed,
	}, nil
}

func railPlacementFromGenerated(placement *tuttigenerated.WorkspaceAgentRailPlacement) *agenthost.RailPlacement {
	if placement == nil {
		return nil
	}
	return &agenthost.RailPlacement{
		Version:     int(placement.Version),
		Kind:        agenthost.RailPlacementKind(placement.Kind),
		ProjectPath: stringPtrValue(placement.ProjectPath),
		SectionKey:  placement.SectionKey,
	}
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
	if diagnosticsErr := validateAgentSubmitDiagnostics(request.Body.SubmitDiagnostics); diagnosticsErr != nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(diagnosticsErr),
		}, nil
	}
	metadata := agentSubmitMetadata(request.Body.SubmitDiagnostics)
	guidance := request.Body.Guidance != nil && *request.Body.Guidance
	targetTurnID := ""
	if guidance {
		targetTurnID = strings.TrimSpace(stringPtrValue(request.Body.TurnId))
	}
	logSendAgentSubmitTrace("api.send.received", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, "", targetTurnID, "", nil)
	result, err := api.AgentSessionService.SendInput(ctx, string(request.WorkspaceID), string(request.AgentSessionID), agentservice.SendInput{
		CapabilityRefs: capabilityRefs,
		Content:        agentPromptContentFromGenerated(request.Body.Content),
		DisplayPrompt:  stringPtrValue(request.Body.DisplayPrompt),
		Guidance:       guidance,
		TurnID:         targetTurnID,
		ClientSubmitID: clientSubmitID,
		Metadata:       metadata,
	})
	if err != nil {
		logSendAgentSubmitTrace("api.send.failed", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, "", targetTurnID, "", err)
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	generatedSession, err := generatedAgentSession(result.Session)
	if err != nil {
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	logSendAgentSubmitTrace("api.send.completed", string(request.WorkspaceID), string(request.AgentSessionID), clientSubmitID, metadata, agentSessionTurnPhase(result.Session), result.TurnID, result.TurnLifecycle.Phase, nil)
	// Desktop AgentGUI submissions are recorded from the workspace activity
	// engine so queue and steer semantics survive replay. Transport callers
	// without renderer submit diagnostics remain direct stimuli.
	if api.AgentSessionRecordingService != nil &&
		shouldRecordDirectSessionSend(
			request.Body.SubmitDiagnostics,
			request.Params.XTuttiAgentCommandOrigin,
		) {
		api.recordAgentStimulus(
			ctx,
			"session.send",
			string(request.WorkspaceID),
			string(request.AgentSessionID),
			map[string]any{
				"clientSubmitId": clientSubmitID,
				"content":        request.Body.Content,
				"displayPrompt":  request.Body.DisplayPrompt,
				"guidance":       guidance,
				"turnId":         targetTurnID,
			},
		)
	}
	var response tuttigenerated.SendWorkspaceAgentSessionInputResponse
	if result.Kind == "goalControl" && result.GoalControl != nil {
		goalResult := result.GoalControl
		goal := generatedGoalControlProjection(&generatedSession, goalResult.Goal)
		goalResponse := tuttigenerated.SendWorkspaceAgentSessionInputGoalControlResponse{
			Goal:    goal,
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

func shouldRecordDirectSessionSend(
	diagnostics *tuttigenerated.AgentSubmitDiagnostics,
	origin *tuttigenerated.SendWorkspaceAgentSessionInputParamsXTuttiAgentCommandOrigin,
) bool {
	return diagnostics == nil &&
		!isRendererEngineCommandOrigin(origin)
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
	if diagnostics.UiMode != nil {
		metadata["uiMode"] = strings.TrimSpace(string(*diagnostics.UiMode))
	}
	return metadata
}

func validateAgentSubmitDiagnostics(diagnostics *tuttigenerated.AgentSubmitDiagnostics) *apierrors.ProtocolError {
	if diagnostics != nil && diagnostics.UiMode != nil && !diagnostics.UiMode.Valid() {
		return apierrors.MalformedRequest(
			apierrors.WithDeveloperMessage("submitDiagnostics.uiMode is invalid"),
		)
	}
	return nil
}
