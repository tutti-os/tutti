package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type agentRuntimeAdapter struct {
	controller *agentruntime.Controller
}

func (a agentRuntimeAdapter) ObserveRootTurnSettled(_ context.Context, workspaceID string, agentSessionID string, turn agentactivitybiz.Turn) {
	a.controller.ReconcileRootTurnSettlement(agentruntime.RootTurnSettlement{
		RoomID:         workspaceID,
		AgentSessionID: agentSessionID,
		TurnID:         turn.TurnID,
		Outcome:        turn.Outcome,
		ErrorMessage:   turn.ErrorMessage,
	})
}

func newAgentRuntimeAdapter(controller *agentruntime.Controller) agentRuntimeAdapter {
	return agentRuntimeAdapter{controller: controller}
}

func (a agentRuntimeAdapter) ConnectorHTTPMCPSupported(
	ctx context.Context,
	input agentservice.ConnectorCapabilityInput,
) (bool, error) {
	capabilities, err := a.controller.ConnectorCapabilities(ctx, agentruntime.ConnectorCapabilityInput{
		RoomID:            input.WorkspaceID,
		AgentSessionID:    input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		ProviderTargetRef: cloneRuntimeContext(input.ProviderTargetRef),
		PermissionModeID:  input.PermissionModeID,
		Settings:          agentRuntimeSessionSettings(input.Settings),
	})
	return capabilities.HTTPMCP, err
}

func (a agentRuntimeAdapter) Cancel(ctx context.Context, input agentservice.RuntimeCancelInput) (agentservice.RuntimeCancelResult, error) {
	targets := make([]agentruntime.CancelTarget, 0, len(input.Targets))
	for _, target := range input.Targets {
		targets = append(targets, agentruntime.CancelTarget{
			AgentSessionID: target.AgentSessionID,
			TurnID:         target.TurnID,
		})
	}
	result, err := a.controller.Cancel(ctx, agentruntime.CancelInput{
		RoomID:             input.WorkspaceID,
		RootAgentSessionID: input.RootAgentSessionID,
		Targets:            targets,
		Reason:             input.Reason,
	})
	if err != nil {
		return agentservice.RuntimeCancelResult{}, mapAgentRuntimeError(err)
	}
	confirmedTargets := make([]agentservice.RuntimeCancelTarget, 0, len(result.ConfirmedTargets))
	for _, target := range result.ConfirmedTargets {
		confirmedTargets = append(confirmedTargets, agentservice.RuntimeCancelTarget{
			AgentSessionID: target.AgentSessionID,
			TurnID:         target.TurnID,
		})
	}
	return agentservice.RuntimeCancelResult{
		AgentSessionID:   result.AgentSessionID,
		Canceled:         result.Canceled,
		TargetAbsent:     result.TargetAbsent,
		ConfirmedTargets: confirmedTargets,
	}, nil
}

func (a agentRuntimeAdapter) GoalControl(ctx context.Context, input agentservice.RuntimeGoalControlInput) (agentservice.RuntimeGoalControlResult, error) {
	result, err := a.controller.GoalControl(ctx, agentruntime.GoalControlInput{
		RoomID:             input.WorkspaceID,
		AgentSessionID:     input.AgentSessionID,
		Action:             agentruntime.GoalControlAction(input.Action),
		Objective:          input.Objective,
		OperationID:        input.OperationID,
		GoalRevision:       input.GoalRevision,
		RepairEpoch:        input.RepairEpoch,
		SubmissionMetadata: input.SubmissionMetadata,
		RequireLive:        input.RequireLive,
	})
	if err != nil {
		return agentservice.RuntimeGoalControlResult{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeGoalControlResult{
		AgentSessionID: result.AgentSessionID,
		Goal:           result.Goal,
		Evidence:       result.Evidence,
		ProviderPhase:  result.ProviderPhase,
	}, nil
}

func (a agentRuntimeAdapter) ReconcileGoal(ctx context.Context, input agentservice.RuntimeGoalControlInput) (agentservice.RuntimeGoalReconcileResult, error) {
	result, err := a.controller.ReconcileGoal(ctx, agentruntime.GoalReconcileInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, RequireLive: input.RequireLive,
	})
	if err != nil {
		return agentservice.RuntimeGoalReconcileResult{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeGoalReconcileResult{
		AgentSessionID: result.AgentSessionID, Goal: result.Goal, Evidence: result.Evidence,
	}, nil
}

func (a agentRuntimeAdapter) GoalRecoveryPolicy(ctx context.Context, input agentservice.RuntimeGoalControlInput) (agentservice.RuntimeGoalRecoveryPolicy, error) {
	capabilities, err := a.controller.GoalCapabilities(ctx, agentruntime.GoalReconcileInput{RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	if err != nil {
		return agentservice.RuntimeGoalRecoveryPolicy{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeGoalRecoveryPolicy{QuerySupported: capabilities.QuerySupported, ReplaySetAfterRestart: capabilities.ReplaySetAfterRestart}, nil
}

func agentRuntimeSessionSettings(settings agentservice.ComposerSettings) *agentruntime.SessionSettings {
	result := &agentruntime.SessionSettings{
		Model:                  settings.Model,
		ReasoningEffort:        settings.ReasoningEffort,
		Speed:                  settings.Speed,
		PlanMode:               settings.PlanMode,
		PermissionModeID:       settings.PermissionModeID,
		ConversationDetailMode: settings.ConversationDetailMode,
	}
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		result.BrowserUse = &value
	}
	return result
}

func (a agentRuntimeAdapter) CanResume(input agentservice.RuntimeResumeInput) bool {
	return a.controller.CanResume(agentruntime.ResumeInput{
		RoomID:            input.WorkspaceID,
		AgentSessionID:    input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Resumable:         input.Resumable,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		MCPServers:        daemonMCPServerBindings(input.MCPServers),
		Title:             input.Title,
		Status:            input.Status,
		Settings:          agentRuntimeSessionSettings(input.Settings),
		PermissionModeID:  input.Settings.PermissionModeID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
		Visible:           input.Visible,
		RuntimeContext:    cloneRuntimeContext(input.RuntimeContext),
		ProviderTargetRef: cloneRuntimeContext(input.ProviderTargetRef),
	})
}

func (a agentRuntimeAdapter) Close(ctx context.Context, input agentservice.RuntimeCloseInput) error {
	if _, err := a.controller.Close(ctx, agentruntime.CloseInput{
		RoomID:                 input.WorkspaceID,
		AgentSessionID:         input.AgentSessionID,
		PreserveCanonicalState: input.PreserveCanonicalState,
	}); err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
}

func (a agentRuntimeAdapter) DisconnectRuntimeSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	result, err := a.controller.DisconnectRuntimeSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return false, mapAgentRuntimeError(err)
	}
	return result.Disconnected, nil
}

func (a agentRuntimeAdapter) SnapshotWorkspaceRuntimeDisconnectTargets(workspaceID string) []agenthost.RuntimeDisconnectTarget {
	targets := a.controller.SnapshotRuntimeDisconnectTargets(workspaceID)
	result := make([]agenthost.RuntimeDisconnectTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, agenthost.RuntimeDisconnectTarget{
			WorkspaceID: target.RoomID, AgentSessionID: target.AgentSessionID,
			ConnectionGeneration: target.ConnectionGeneration,
		})
	}
	return result
}

func (a agentRuntimeAdapter) DisconnectRuntimeSessionTarget(
	ctx context.Context,
	target agenthost.RuntimeDisconnectTarget,
) (bool, error) {
	result, err := a.controller.DisconnectRuntimeSessionTarget(ctx, agentruntime.RuntimeDisconnectTarget{
		RoomID: target.WorkspaceID, AgentSessionID: target.AgentSessionID,
		ConnectionGeneration: target.ConnectionGeneration,
	})
	if err != nil {
		return false, mapAgentRuntimeError(err)
	}
	return result.Disconnected, nil
}

func (a agentRuntimeAdapter) Exec(ctx context.Context, input agentservice.RuntimeExecInput) (agentservice.RuntimeExecResult, error) {
	if !input.Guidance && strings.TrimSpace(input.TurnID) == "" {
		return agentservice.RuntimeExecResult{}, fmt.Errorf(
			"%w: canonical turn id is required for a new agent turn",
			agentservice.ErrInvalidArgument,
		)
	}
	agentservice.LogSubmitTrace("runtime_adapter.exec.entered", input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
		"content_block_count": len(input.Content),
	})
	result, err := a.controller.Exec(ctx, agentruntime.ExecInput{
		RoomID:                          input.WorkspaceID,
		AgentSessionID:                  input.AgentSessionID,
		TurnID:                          input.TurnID,
		ClientSubmitID:                  input.ClientSubmitID,
		CanonicalSubmitOccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS,
		CapabilityRefs:                  runtimeCapabilityReferencesFromService(input.CapabilityRefs),
		Content:                         runtimePromptContentFromService(input.Content),
		DisplayPrompt:                   input.DisplayPrompt,
		InitialTitle:                    input.InitialTitle,
		InitialTitleBase:                input.InitialTitleBase,
		Guidance:                        input.Guidance,
		HistoryReplacement:              input.HistoryReplacement,
		RequireProviderAcceptance:       input.RequireProviderAcceptance,
		Metadata:                        cloneRuntimeContext(input.Metadata),
		TuttiModeSnapshot:               runtimeTuttiModeSnapshotFromService(input.TuttiModeSnapshot),
	})
	projected := agentservice.RuntimeExecResult{
		AgentSessionID:     result.AgentSessionID,
		Status:             result.Status,
		TurnID:             result.TurnID,
		Accepted:           result.Accepted,
		ProviderDispatch:   serviceProviderDispatchFromRuntime(result.ProviderDispatch),
		SessionStatus:      result.SessionStatus,
		TurnLifecycle:      serviceTurnLifecycleFromRuntime(result.TurnLifecycle),
		SubmitAvailability: serviceSubmitAvailabilityFromRuntime(result.SubmitAvailability),
	}
	if err != nil {
		agentservice.LogSubmitTrace("runtime_adapter.exec.failed", input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
			"error": err.Error(),
		})
		return projected, mapAgentRuntimeError(err)
	}
	agentservice.LogSubmitTrace("runtime_adapter.exec.resolved", input.WorkspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
		"turn_id":        result.TurnID,
		"session_status": result.SessionStatus,
		"turn_phase":     result.TurnLifecycle.Phase,
	})
	return projected, nil
}

func serviceProviderDispatchFromRuntime(
	dispatch *agentruntime.ProviderDispatchResult,
) agenthost.RuntimeProviderDispatchResult {
	if dispatch == nil {
		return agenthost.RuntimeProviderDispatchResult{}
	}
	projected := agenthost.RuntimeProviderDispatchResult{
		Disposition: agenthost.RuntimeDispatchDisposition(dispatch.Disposition),
	}
	if diagnostics := dispatch.AcceptanceDiagnostics; diagnostics != nil {
		projected.AcceptanceDiagnostics = &agenthost.RuntimeProviderAcceptanceDiagnostics{
			Status:                   diagnostics.Status,
			ProviderSessionIDPresent: diagnostics.ProviderSessionIDPresent,
			ProviderTurnIDPresent:    diagnostics.ProviderTurnIDPresent,
			ProviderTurnIDSource:     diagnostics.ProviderTurnIDSource,
			FailureReason:            diagnostics.FailureReason,
		}
	}
	if dispatch.Acceptance != nil {
		projected.Acceptance = &agenthost.RuntimeProviderAcceptanceReceipt{
			ProviderSessionID: dispatch.Acceptance.ProviderSessionID,
			ProviderTurnID:    dispatch.Acceptance.ProviderTurnID,
			Source: agenthost.RuntimeAcceptanceSource(
				dispatch.Acceptance.Source,
			),
		}
	}
	return projected
}

func (a agentRuntimeAdapter) DurablyReportSubmitProvenance(
	ctx context.Context,
	input agentservice.RuntimeSubmitProvenanceInput,
) error {
	err := a.controller.DurablyReportSubmitProvenance(ctx, agentruntime.SubmitProvenanceInput{
		RoomID:                          input.WorkspaceID,
		AgentSessionID:                  input.AgentSessionID,
		TurnID:                          input.TurnID,
		ClientSubmitID:                  input.ClientSubmitID,
		CanonicalSubmitOccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS,
		Content:                         runtimePromptContentFromService(input.Content),
		DisplayPrompt:                   input.DisplayPrompt,
		Guidance:                        input.Guidance,
	})
	if err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
}

func runtimeTuttiModeSnapshotFromService(
	snapshot *agentservice.TuttiModeTurnSnapshot,
) *agentruntime.TuttiModeTurnSnapshot {
	if snapshot == nil {
		return nil
	}
	legacyOrchestrationIntensity := snapshot.OrchestrationIntensity //nolint:staticcheck // Compatibility bridge preserves version-zero snapshots.
	return &agentruntime.TuttiModeTurnSnapshot{
		ActivationID:           snapshot.ActivationID,
		RevisionID:             snapshot.RevisionID,
		Revision:               snapshot.Revision,
		State:                  snapshot.State,
		Source:                 snapshot.Source,
		PreferenceVersion:      snapshot.PreferenceVersion,
		Effect:                 snapshot.Effect,
		Speed:                  snapshot.Speed,
		OrchestrationIntensity: legacyOrchestrationIntensity,
	}
}

func runtimeCapabilityReferencesFromService(
	references []agentservice.CapabilityReference,
) []agentruntime.CapabilityReference {
	if len(references) == 0 {
		return nil
	}
	mapped := make([]agentruntime.CapabilityReference, 0, len(references))
	for _, reference := range references {
		mapped = append(mapped, agentruntime.CapabilityReference{
			Capability: reference.Capability,
			Source:     reference.Source,
		})
	}
	return mapped
}

func serviceSubmitAvailabilityFromRuntime(value agentruntime.SubmitAvailability) agentservice.SubmitAvailability {
	return agentservice.SubmitAvailability{
		State:  value.State,
		Reason: value.Reason,
	}
}

func serviceCompletedCommandFromRuntime(value *agentruntime.CompletedCommand) *agentservice.CompletedCommand {
	if value == nil {
		return nil
	}
	return &agentservice.CompletedCommand{
		Kind:   value.Kind,
		Status: value.Status,
	}
}

func serviceTurnLifecycleFromRuntime(value agentruntime.TurnLifecycle) agentservice.TurnLifecycle {
	return agentservice.TurnLifecycle{
		ActiveTurnID:     cloneStringPointer(value.ActiveTurnID),
		Phase:            value.Phase,
		Settling:         value.Settling,
		Outcome:          cloneStringPointer(value.Outcome),
		CompletedCommand: serviceCompletedCommandFromRuntime(value.CompletedCommand),
	}
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func (a agentRuntimeAdapter) ValidatePromptContent(ctx context.Context, input agentservice.RuntimeExecInput) error {
	if err := a.controller.ValidatePromptContent(ctx, agentruntime.ExecInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Content:        runtimePromptContentFromService(input.Content),
		DisplayPrompt:  input.DisplayPrompt,
	}); err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
}

func runtimePromptContentFromService(content []agentservice.PromptContentBlock) []agentruntime.PromptContentBlock {
	result := make([]agentruntime.PromptContentBlock, 0, len(content))
	for _, block := range content {
		result = append(result, agentruntime.PromptContentBlock{
			Type:         block.Type,
			Text:         block.Text,
			MimeType:     block.MimeType,
			Data:         block.Data,
			URL:          block.URL,
			AttachmentID: block.AttachmentID,
			Name:         block.Name,
			Path:         block.Path,
			ConnectorKey: block.ConnectorKey,
		})
	}
	return result
}

func (a agentRuntimeAdapter) SubmitInteractive(ctx context.Context, input agentservice.RuntimeSubmitInteractiveInput) (agentservice.RuntimeSubmitInteractiveResult, error) {
	result, err := a.controller.SubmitInteractive(ctx, agentruntime.SubmitInteractiveInput{
		RoomID:             input.WorkspaceID,
		RootAgentSessionID: input.RootAgentSessionID,
		AgentSessionID:     input.AgentSessionID,
		TurnID:             input.TurnID,
		RequestID:          input.RequestID,
		Action:             input.Action,
		OptionID:           input.OptionID,
		Payload:            input.Payload,
	})
	mapped := agentservice.RuntimeSubmitInteractiveResult{
		Disposition:    agentservice.RuntimeInteractiveDisposition(result.Disposition),
		FollowUpPrompt: result.FollowUpPrompt,
	}
	if err != nil {
		return mapped, mapAgentRuntimeError(err)
	}
	return mapped, nil
}

func (a agentRuntimeAdapter) InteractiveDisposition(workspaceID string, rootAgentSessionID string, agentSessionID string, turnID string, requestID string) agentservice.RuntimeInteractiveDisposition {
	return agentservice.RuntimeInteractiveDisposition(a.controller.InteractiveDisposition(workspaceID, rootAgentSessionID, agentSessionID, turnID, requestID))
}

func (a agentRuntimeAdapter) UpdateSettings(ctx context.Context, input agentservice.RuntimeUpdateSettingsInput) error {
	if _, err := a.controller.UpdateSettings(ctx, agentruntime.UpdateSettingsInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Settings: agentruntime.SessionSettingsPatch{
			Model:            input.Settings.Model,
			ReasoningEffort:  input.Settings.ReasoningEffort,
			Speed:            input.Settings.Speed,
			PlanMode:         input.Settings.PlanMode,
			BrowserUse:       input.Settings.BrowserUse,
			PermissionModeID: input.Settings.PermissionModeID,
		},
	}); err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
}

func (a agentRuntimeAdapter) Resume(ctx context.Context, input agentservice.RuntimeResumeInput) (agentservice.ProviderRuntimeSession, error) {
	session, err := a.controller.Resume(ctx, agentruntime.ResumeInput{
		RoomID:            input.WorkspaceID,
		AgentSessionID:    input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Resumable:         input.Resumable,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		MCPServers:        daemonMCPServerBindings(input.MCPServers),
		Title:             input.Title,
		Status:            input.Status,
		Settings:          agentRuntimeSessionSettings(input.Settings),
		PermissionModeID:  input.Settings.PermissionModeID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
		Visible:           input.Visible,
		RuntimeContext:    cloneRuntimeContext(input.RuntimeContext),
		ProviderTargetRef: cloneRuntimeContext(input.ProviderTargetRef),
		RecreateIfMissing: input.RecreateIfMissing,
	})
	if err != nil {
		return agentservice.ProviderRuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) Session(workspaceID string, agentSessionID string) (agentservice.ProviderRuntimeSession, bool) {
	session, ok := a.controller.Session(workspaceID, agentSessionID)
	if !ok {
		return agentservice.ProviderRuntimeSession{}, false
	}
	return a.runtimeSessionWithState(session), true
}

func (a agentRuntimeAdapter) SetVisible(ctx context.Context, input agentservice.RuntimeSetVisibleInput) (agentservice.ProviderRuntimeSession, error) {
	session, err := a.controller.SetVisible(ctx, input.WorkspaceID, input.AgentSessionID, input.Visible)
	if err != nil {
		return agentservice.ProviderRuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) SetTitle(ctx context.Context, input agentservice.RuntimeSetTitleInput) (agentservice.ProviderRuntimeSession, error) {
	session, err := a.controller.SetTitle(ctx, input.WorkspaceID, input.AgentSessionID, input.Title)
	if err != nil {
		return agentservice.ProviderRuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) Sessions(workspaceID string) []agentservice.ProviderRuntimeSession {
	sessions := a.controller.Sessions(workspaceID)
	result := make([]agentservice.ProviderRuntimeSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, a.runtimeSessionWithState(session))
	}
	return result
}

func (a agentRuntimeAdapter) Start(ctx context.Context, input agentservice.RuntimeStartInput) (agentservice.RuntimeStartResult, error) {
	result, err := a.controller.Start(ctx, agentruntime.StartInput{
		RoomID:                  input.WorkspaceID,
		AgentSessionID:          input.AgentSessionID,
		AgentTargetID:           input.AgentTargetID,
		Provider:                input.Provider,
		CWD:                     input.Cwd,
		Env:                     append([]string(nil), input.Env...),
		MCPServers:              daemonMCPServerBindings(input.MCPServers),
		Title:                   input.Title,
		InitialTitleEstablished: input.InitialTitleEstablished,
		ProviderTargetRef:       cloneRuntimeContext(input.ProviderTargetRef),
		RuntimeContext:          cloneRuntimeContext(input.RuntimeContext),
		PermissionModeID:        input.PermissionModeID,
		Settings: &agentruntime.SessionSettings{
			Model:                  input.Model,
			ReasoningEffort:        input.ReasoningEffort,
			Speed:                  input.Speed,
			PlanMode:               input.PlanMode,
			BrowserUse:             cloneOptionalBool(input.BrowserUse),
			PermissionModeID:       input.PermissionModeID,
			ConversationDetailMode: input.ConversationDetailMode,
		},
		Visible:              input.Visible,
		Provisional:          input.Provisional,
		CanonicalInitPending: input.CanonicalInitPending,
	})
	if err != nil {
		return agentservice.RuntimeStartResult{}, mapAgentRuntimeError(err)
	}
	session := a.runtimeSessionWithState(result.Session)
	session.Provisional = input.Provisional
	return agentservice.RuntimeStartResult{Session: session, Created: result.Created}, nil
}

func (a agentRuntimeAdapter) PublishSessionInitialization(
	ctx context.Context,
	input agentservice.RuntimeSessionInitializationPublishInput,
) (agentservice.ProviderRuntimeSession, error) {
	session, err := a.controller.PublishSessionInitialization(
		ctx,
		input.WorkspaceID,
		input.AgentSessionID,
	)
	if err != nil {
		return agentservice.ProviderRuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) Subscribe(workspaceID string, agentSessionID string) (<-chan agentservice.RuntimeStreamEvent, func(), bool) {
	events, unsubscribe, ok := a.controller.Subscribe(workspaceID, agentSessionID)
	return agentRuntimeStreamEvents(events), unsubscribe, ok
}

func agentRuntimeStreamEvents(events <-chan agentruntime.StreamEvent) <-chan agentservice.RuntimeStreamEvent {
	out := make(chan agentservice.RuntimeStreamEvent)
	go func() {
		defer close(out)
		for event := range events {
			out <- agentservice.RuntimeStreamEvent{
				EventType: event.EventType,
				Data:      event.Data,
			}
		}
	}()
	return out
}

func agentRuntimeSession(session agentruntime.Session) agentservice.ProviderRuntimeSession {
	return agentservice.ProviderRuntimeSession{
		ID:                      session.AgentSessionID,
		WorkspaceID:             session.RoomID,
		AgentTargetID:           session.AgentTargetID,
		Provider:                session.Provider,
		ProviderSessionID:       session.ProviderSessionID,
		Resumable:               session.Resumable,
		Cwd:                     session.CWD,
		Env:                     append([]string(nil), session.Env...),
		MCPServers:              serviceMCPServerBindings(session.MCPServers),
		Settings:                agentRuntimeComposerSettings(session.Settings),
		Status:                  session.Status,
		TurnLifecycle:           serviceTurnLifecyclePointerFromRuntime(session.TurnLifecycle),
		SubmitAvailability:      serviceSubmitAvailabilityPointerFromRuntime(session.SubmitAvailability),
		Visible:                 session.Visible,
		Title:                   session.Title,
		InitialTitleEstablished: session.InitialTitleEstablished,
		LastError:               session.LastError,
		RuntimeContext:          cloneRuntimeContext(session.RuntimeContext),
		CreatedAtUnixMS:         session.CreatedAtUnixMS,
		UpdatedAtUnixMS:         session.UpdatedAtUnixMS,
	}
}

func daemonMCPServerBindings(input []agenthost.MCPServerBinding) []agentruntime.MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]agentruntime.MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result = append(result, agentruntime.MCPServerBinding{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: headers})
	}
	return result
}

func serviceMCPServerBindings(input []agentruntime.MCPServerBinding) []agenthost.MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]agenthost.MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result = append(result, agenthost.MCPServerBinding{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: headers})
	}
	return result
}

func (a agentRuntimeAdapter) runtimeSessionWithState(session agentruntime.Session) agentservice.ProviderRuntimeSession {
	result := agentRuntimeSession(session)
	state, err := a.controller.State(session.RoomID, session.AgentSessionID)
	if err != nil {
		return result
	}
	if state.ProviderSessionID != "" {
		result.ProviderSessionID = state.ProviderSessionID
	}
	result.Resumable = result.Resumable || state.Resumable
	if state.Status != "" {
		result.Status = state.Status
	}
	if state.TurnLifecycle != nil {
		result.TurnLifecycle = serviceTurnLifecyclePointerFromRuntime(state.TurnLifecycle)
	}
	if state.SubmitAvailability != nil {
		result.SubmitAvailability = serviceSubmitAvailabilityPointerFromRuntime(state.SubmitAvailability)
	}
	if state.Settings != nil {
		result.Settings = agentRuntimeComposerSettings(state.Settings)
	}
	result.RuntimeContext = cloneRuntimeContext(state.RuntimeContext)
	if state.UpdatedAtUnixMS > 0 {
		result.UpdatedAtUnixMS = state.UpdatedAtUnixMS
	}
	return result
}

func serviceSubmitAvailabilityPointerFromRuntime(value *agentruntime.SubmitAvailability) *agentservice.SubmitAvailability {
	if value == nil {
		return nil
	}
	converted := serviceSubmitAvailabilityFromRuntime(*value)
	return &converted
}

func serviceTurnLifecyclePointerFromRuntime(value *agentruntime.TurnLifecycle) *agentservice.TurnLifecycle {
	if value == nil {
		return nil
	}
	converted := serviceTurnLifecycleFromRuntime(*value)
	return &converted
}

func agentRuntimeComposerSettings(settings *agentruntime.SessionSettings) *agentservice.ComposerSettings {
	if settings == nil {
		return nil
	}
	return &agentservice.ComposerSettings{
		Model:                  settings.Model,
		PermissionModeID:       settings.PermissionModeID,
		PlanMode:               settings.PlanMode,
		BrowserUse:             cloneOptionalBool(settings.BrowserUse),
		ReasoningEffort:        settings.ReasoningEffort,
		Speed:                  settings.Speed,
		ConversationDetailMode: settings.ConversationDetailMode,
	}
}

func cloneRuntimeContext(value map[string]any) map[string]any {
	if len(value) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		cloned[key] = cloneRuntimeContextValue(item)
	}
	return cloned
}

func cloneRuntimeContextValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = cloneRuntimeContextValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = cloneRuntimeContextValue(item)
		}
		return out
	default:
		return value
	}
}

func cloneOptionalBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func mapAgentRuntimeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, agentruntime.ErrSessionNotFound) {
		return agentservice.ErrSessionNotFound
	}
	if errors.Is(err, agentruntime.ErrSessionDisconnected) {
		return fmt.Errorf("%w: %v", agentservice.ErrRuntimeSessionDisconnected, err)
	}
	if errors.Is(err, agentruntime.ErrInteractiveRequestNotLive) {
		return fmt.Errorf("%w: %v", agentservice.ErrInteractiveRequestNotLive, err)
	}
	if errors.Is(err, agentruntime.ErrInteractiveAlreadyAnswered) {
		return fmt.Errorf("%w: %v", agentservice.ErrInteractiveAlreadyAnswered, err)
	}
	if errors.Is(err, agentruntime.ErrSessionNoActiveTurn) {
		return agentservice.ErrSessionNoActiveTurn
	}
	if errors.Is(err, agentruntime.ErrActiveTurnGuidanceUnsupported) {
		return agentservice.ErrActiveTurnGuidanceUnsupported
	}
	if errors.Is(err, agentruntime.ErrActiveTurnTargetRequired) {
		return agentservice.ErrActiveTurnTargetRequired
	}
	if errors.Is(err, agentruntime.ErrActiveTurnTargetMismatch) {
		return agentservice.ErrActiveTurnTargetMismatch
	}
	if errors.Is(err, agentruntime.ErrSessionSettingsRequireNewSession) {
		return agentservice.ErrSessionSettingsRequireNewSession
	}
	if errors.Is(err, agentruntime.ErrPromptImageUnsupported) {
		return agentservice.ErrPromptImageUnsupported
	}
	var appErr *agentruntime.AppError
	if errors.As(err, &appErr) && appErr != nil {
		return agenthost.NewProviderError(appErr.Code, appErr.Message, appErr.DebugMessage, appErr)
	}
	return err
}
