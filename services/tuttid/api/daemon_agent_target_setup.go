package api

import (
	"context"
	"errors"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type AgentTargetSetupService interface {
	GetSetup(context.Context, agentextensionservice.InstallPlanInput) (agentextensionservice.SetupSnapshot, error)
	Install(context.Context, agentextensionservice.InstallInput) (agentextensionservice.SetupSnapshot, error)
	Authenticate(context.Context, agentextensionservice.AuthenticateInput) (agentextensionservice.SetupSnapshot, error)
}

func (api DaemonAPI) AuthenticateAgentTargetRuntime(ctx context.Context, request tuttigenerated.AuthenticateAgentTargetRuntimeRequestObject) (tuttigenerated.AuthenticateAgentTargetRuntimeResponseObject, error) {
	if api.AgentTargetSetupService == nil {
		return tuttigenerated.AuthenticateAgentTargetRuntime503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentTargetSetupUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return invalidAuthenticateAgentTargetRuntimeRequest("request body is required"), nil
	}
	input := agentextensionservice.AuthenticateInput{
		WorkspaceID: strings.TrimSpace(string(request.WorkspaceID)), AgentTargetID: strings.TrimSpace(request.AgentTargetID),
		MethodID:       strings.TrimSpace(request.Body.MethodId),
		ClientActionID: strings.TrimSpace(request.Body.ClientActionId),
	}
	if input.WorkspaceID == "" || input.AgentTargetID == "" || input.MethodID == "" || input.ClientActionID == "" {
		return invalidAuthenticateAgentTargetRuntimeRequest("workspace id, agent target id, method id, and client action id are required"), nil
	}
	snapshot, err := api.AgentTargetSetupService.Authenticate(ctx, input)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
			return tuttigenerated.AuthenticateAgentTargetRuntime404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.WorkspaceNotFound("workspace_not_found", apierrors.WithCause(err))),
			}, nil
		case errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, agentextensionservice.ErrInvalidInstallPlanRequest),
			errors.Is(err, agentextensionservice.ErrUnsupportedInstallTarget),
			errors.Is(err, agentextensionservice.ErrTerminalAuthMethod),
			errors.Is(err, agentruntime.ErrACPAuthMethodUnavailable),
			errors.Is(err, agentruntime.ErrACPAuthMethodTerminal):
			return invalidAuthenticateAgentTargetRuntimeRequest(err.Error()), nil
		default:
			return tuttigenerated.AuthenticateAgentTargetRuntime502JSONResponse{
				WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
			}, nil
		}
	}
	return tuttigenerated.AuthenticateAgentTargetRuntime200JSONResponse(projectAgentTargetSetupSnapshot(snapshot)), nil
}

func (api DaemonAPI) GetAgentTargetSetup(ctx context.Context, request tuttigenerated.GetAgentTargetSetupRequestObject) (tuttigenerated.GetAgentTargetSetupResponseObject, error) {
	if api.AgentTargetSetupService == nil {
		return tuttigenerated.GetAgentTargetSetup503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentTargetSetupUnavailable(),
		}, nil
	}
	input := agentextensionservice.InstallPlanInput{
		WorkspaceID: strings.TrimSpace(string(request.WorkspaceID)), AgentTargetID: strings.TrimSpace(request.AgentTargetID),
	}
	if input.WorkspaceID == "" || input.AgentTargetID == "" {
		return invalidAgentTargetSetupRequest("workspace id and agent target id are required"), nil
	}
	snapshot, err := api.AgentTargetSetupService.GetSetup(ctx, input)
	if err != nil {
		return getAgentTargetSetupError(err), nil
	}
	return tuttigenerated.GetAgentTargetSetup200JSONResponse(projectAgentTargetSetupSnapshot(snapshot)), nil
}

func (api DaemonAPI) InstallAgentTargetRuntime(ctx context.Context, request tuttigenerated.InstallAgentTargetRuntimeRequestObject) (tuttigenerated.InstallAgentTargetRuntimeResponseObject, error) {
	if api.AgentTargetSetupService == nil {
		return tuttigenerated.InstallAgentTargetRuntime503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentTargetSetupUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return invalidInstallAgentTargetRuntimeRequest("request body is required"), nil
	}
	input := agentextensionservice.InstallInput{
		WorkspaceID: strings.TrimSpace(string(request.WorkspaceID)), AgentTargetID: strings.TrimSpace(request.AgentTargetID),
		PlanDigest:     strings.TrimSpace(request.Body.PlanDigest),
		ClientActionID: strings.TrimSpace(request.Body.ClientActionId),
	}
	if input.WorkspaceID == "" || input.AgentTargetID == "" || input.PlanDigest == "" || input.ClientActionID == "" {
		return invalidInstallAgentTargetRuntimeRequest("workspace id, agent target id, plan digest, and client action id are required"), nil
	}
	snapshot, err := api.AgentTargetSetupService.Install(ctx, input)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
			return tuttigenerated.InstallAgentTargetRuntime404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.WorkspaceNotFound("workspace_not_found", apierrors.WithCause(err))),
			}, nil
		case errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, agentextensionservice.ErrInvalidInstallPlanRequest),
			errors.Is(err, agentextensionservice.ErrUnsupportedInstallTarget),
			errors.Is(err, agentextensionservice.ErrInstallPlanChanged):
			return invalidInstallAgentTargetRuntimeRequest(err.Error()), nil
		default:
			return tuttigenerated.InstallAgentTargetRuntime502JSONResponse{
				WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
			}, nil
		}
	}
	return tuttigenerated.InstallAgentTargetRuntime200JSONResponse(projectAgentTargetSetupSnapshot(snapshot)), nil
}

func projectAgentTargetSetupSnapshot(snapshot agentextensionservice.SetupSnapshot) tuttigenerated.AgentTargetSetupSnapshot {
	result := tuttigenerated.AgentTargetSetupSnapshot{
		WorkspaceId: snapshot.WorkspaceID, AgentTargetId: snapshot.AgentTargetID,
		Status: tuttigenerated.AgentTargetSetupStatus(snapshot.Status),
	}
	result.AuthMethods = make([]tuttigenerated.AgentTargetAuthMethod, 0, len(snapshot.AuthMethods))
	for _, method := range snapshot.AuthMethods {
		projected := tuttigenerated.AgentTargetAuthMethod{Id: method.ID, Name: method.Name}
		if method.Description != "" {
			projected.Description = &method.Description
		}
		if method.Type != "" {
			projected.Type = &method.Type
		}
		if method.TerminalCommand != "" {
			projected.TerminalCommand = &method.TerminalCommand
		}
		result.AuthMethods = append(result.AuthMethods, projected)
	}
	if snapshot.Account != nil {
		account := tuttigenerated.AgentTargetAuthenticatedAccount{
			Id: snapshot.Account.ID, DisplayName: snapshot.Account.DisplayName, AuthMethodId: snapshot.Account.AuthMethodID,
		}
		if snapshot.Account.Organization != "" {
			account.Organization = &snapshot.Account.Organization
		}
		result.Account = &account
	}
	if snapshot.RuntimeSource != "" {
		value := tuttigenerated.AgentTargetRuntimeSource(snapshot.RuntimeSource)
		result.RuntimeSource = &value
	}
	if snapshot.RuntimeVersion != "" {
		result.RuntimeVersion = &snapshot.RuntimeVersion
	}
	if snapshot.Reason != "" {
		result.Reason = &snapshot.Reason
	}
	if snapshot.Plan != nil {
		plan := projectAgentTargetInstallPlan(*snapshot.Plan)
		result.Plan = &plan
	}
	if snapshot.Action != nil {
		action := projectAgentTargetSetupAction(*snapshot.Action)
		result.Action = &action
	}
	return result
}

func projectAgentTargetInstallPlan(plan agentextensionservice.InstallPlan) tuttigenerated.AgentTargetInstallPlan {
	return tuttigenerated.AgentTargetInstallPlan{
		AgentTargetId:           plan.AgentTargetID,
		ExtensionInstallationId: plan.ExtensionInstallationID, AgentKey: plan.AgentKey, ExtensionVersion: plan.ExtensionVersion,
		RuntimeKind: plan.RuntimeKind, Platform: plan.Platform, Runner: tuttigenerated.AgentTargetInstallPlanRunner(plan.Runner),
		PackageName: plan.PackageName, PackageVersion: plan.PackageVersion, InstallRoot: plan.InstallRoot,
		InstallCommand: plan.InstallCommand, Executable: plan.Executable, LaunchArgs: plan.LaunchArgs, PlanDigest: plan.PlanDigest,
	}
}

func projectAgentTargetSetupAction(action agentextensionservice.SetupAction) tuttigenerated.AgentTargetSetupAction {
	result := tuttigenerated.AgentTargetSetupAction{
		ActionId: action.ActionID, ClientActionId: action.ClientActionID,
		Kind:   tuttigenerated.AgentTargetSetupActionKind(action.Kind),
		Status: tuttigenerated.AgentTargetSetupActionStatus(action.Status), Phase: tuttigenerated.AgentTargetSetupActionPhase(action.Phase),
		CreatedAtUnixMs: action.CreatedAtUnixMS, UpdatedAtUnixMs: action.UpdatedAtUnixMS,
	}
	if action.ErrorCode != "" {
		result.ErrorCode = &action.ErrorCode
	}
	if action.ErrorMessage != "" {
		result.ErrorMessage = &action.ErrorMessage
	}
	return result
}

func getAgentTargetSetupError(err error) tuttigenerated.GetAgentTargetSetupResponseObject {
	switch {
	case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
		return tuttigenerated.GetAgentTargetSetup404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(apierrors.WorkspaceNotFound("workspace_not_found", apierrors.WithCause(err))),
		}
	case errors.Is(err, workspacedata.ErrAgentTargetNotFound),
		errors.Is(err, agentextensionservice.ErrInvalidInstallPlanRequest),
		errors.Is(err, agentextensionservice.ErrUnsupportedInstallTarget):
		return invalidAgentTargetSetupRequest(err.Error())
	default:
		return tuttigenerated.GetAgentTargetSetup502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}
	}
}

func agentTargetSetupUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"agent_target_setup_service_unavailable", apierrors.WithDeveloperMessage("agent target setup service is unavailable"),
	))
}

func invalidAgentTargetSetupRequest(message string) tuttigenerated.GetAgentTargetSetup400JSONResponse {
	return tuttigenerated.GetAgentTargetSetup400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(
		apierrors.InvalidRequest("invalid_agent_target_setup", apierrors.WithDeveloperMessage(message)),
	)}
}

func invalidInstallAgentTargetRuntimeRequest(message string) tuttigenerated.InstallAgentTargetRuntime400JSONResponse {
	return tuttigenerated.InstallAgentTargetRuntime400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(
		apierrors.InvalidRequest("invalid_agent_target_runtime_install", apierrors.WithDeveloperMessage(message)),
	)}
}

func invalidAuthenticateAgentTargetRuntimeRequest(message string) tuttigenerated.AuthenticateAgentTargetRuntime400JSONResponse {
	return tuttigenerated.AuthenticateAgentTargetRuntime400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(
		apierrors.InvalidRequest("invalid_agent_target_runtime_authenticate", apierrors.WithDeveloperMessage(message)),
	)}
}
