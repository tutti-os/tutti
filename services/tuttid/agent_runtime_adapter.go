package main

import (
	"context"
	"errors"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type agentRuntimeAdapter struct {
	controller *agentruntime.Controller
}

func newAgentRuntimeAdapter(controller *agentruntime.Controller) agentRuntimeAdapter {
	return agentRuntimeAdapter{controller: controller}
}

func (a agentRuntimeAdapter) Cancel(ctx context.Context, input agentservice.RuntimeCancelInput) (agentservice.RuntimeCancelResult, error) {
	result, err := a.controller.Cancel(ctx, agentruntime.CancelInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Reason:         input.Reason,
	})
	if err != nil {
		return agentservice.RuntimeCancelResult{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeCancelResult{
		AgentSessionID: result.AgentSessionID,
		Canceled:       result.Canceled,
	}, nil
}

func (a agentRuntimeAdapter) GoalControl(ctx context.Context, input agentservice.RuntimeGoalControlInput) (agentservice.RuntimeGoalControlResult, error) {
	result, err := a.controller.GoalControl(ctx, agentruntime.GoalControlInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Action:         agentruntime.GoalControlAction(input.Action),
		Objective:      input.Objective,
	})
	if err != nil {
		return agentservice.RuntimeGoalControlResult{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeGoalControlResult{
		AgentSessionID: result.AgentSessionID,
		Goal:           result.Goal,
	}, nil
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
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Title:             input.Title,
		Status:            input.Status,
		Settings:          agentRuntimeSessionSettings(input.Settings),
		PermissionModeID:  input.Settings.PermissionModeID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
		Visible:           input.Visible,
		RuntimeContext:    cloneRuntimeContext(input.RuntimeContext),
	})
}

func (a agentRuntimeAdapter) Close(ctx context.Context, input agentservice.RuntimeCloseInput) error {
	if _, err := a.controller.Close(ctx, agentruntime.CloseInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
	}); err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
}

func (a agentRuntimeAdapter) Exec(ctx context.Context, input agentservice.RuntimeExecInput) (agentservice.RuntimeExecResult, error) {
	agentservice.LogSubmitTrace("runtime_adapter.exec.entered", input.WorkspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(input.Content),
	})
	result, err := a.controller.Exec(ctx, agentruntime.ExecInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Content:        runtimePromptContentFromService(input.Content),
		DisplayPrompt:  input.DisplayPrompt,
		Guidance:       input.Guidance,
		Metadata:       cloneRuntimeContext(input.Metadata),
	})
	if err != nil {
		agentservice.LogSubmitTrace("runtime_adapter.exec.failed", input.WorkspaceID, input.AgentSessionID, input.Metadata, map[string]any{
			"error": err.Error(),
		})
		return agentservice.RuntimeExecResult{}, mapAgentRuntimeError(err)
	}
	agentservice.LogSubmitTrace("runtime_adapter.exec.resolved", input.WorkspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"turn_id":        result.TurnID,
		"session_status": result.SessionStatus,
		"turn_phase":     result.TurnLifecycle.Phase,
	})
	return agentservice.RuntimeExecResult{
		AgentSessionID:     result.AgentSessionID,
		Status:             result.Status,
		TurnID:             result.TurnID,
		Accepted:           result.Accepted,
		SessionStatus:      result.SessionStatus,
		TurnLifecycle:      serviceTurnLifecycleFromRuntime(result.TurnLifecycle),
		SubmitAvailability: serviceSubmitAvailabilityFromRuntime(result.SubmitAvailability),
	}, nil
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
			AttachmentID: block.AttachmentID,
			Name:         block.Name,
			Path:         block.Path,
		})
	}
	return result
}

func (a agentRuntimeAdapter) SubmitInteractive(ctx context.Context, input agentservice.RuntimeSubmitInteractiveInput) error {
	if _, err := a.controller.SubmitInteractive(ctx, agentruntime.SubmitInteractiveInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		RequestID:      input.RequestID,
		Action:         input.Action,
		OptionID:       input.OptionID,
		Payload:        input.Payload,
	}); err != nil {
		return mapAgentRuntimeError(err)
	}
	return nil
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

func (a agentRuntimeAdapter) Resume(ctx context.Context, input agentservice.RuntimeResumeInput) (agentservice.RuntimeSession, error) {
	session, err := a.controller.Resume(ctx, agentruntime.ResumeInput{
		RoomID:            input.WorkspaceID,
		AgentSessionID:    input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Title:             input.Title,
		Status:            input.Status,
		Settings:          agentRuntimeSessionSettings(input.Settings),
		PermissionModeID:  input.Settings.PermissionModeID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
		Visible:           input.Visible,
		RuntimeContext:    cloneRuntimeContext(input.RuntimeContext),
		RecreateIfMissing: input.RecreateIfMissing,
	})
	if err != nil {
		return agentservice.RuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) Session(workspaceID string, agentSessionID string) (agentservice.RuntimeSession, bool) {
	session, ok := a.controller.Session(workspaceID, agentSessionID)
	if !ok {
		return agentservice.RuntimeSession{}, false
	}
	return a.runtimeSessionWithState(session), true
}

func (a agentRuntimeAdapter) SetVisible(ctx context.Context, input agentservice.RuntimeSetVisibleInput) (agentservice.RuntimeSession, error) {
	session, err := a.controller.SetVisible(ctx, input.WorkspaceID, input.AgentSessionID, input.Visible)
	if err != nil {
		return agentservice.RuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(session), nil
}

func (a agentRuntimeAdapter) Sessions(workspaceID string) []agentservice.RuntimeSession {
	sessions := a.controller.Sessions(workspaceID)
	result := make([]agentservice.RuntimeSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, a.runtimeSessionWithState(session))
	}
	return result
}

func (a agentRuntimeAdapter) Start(ctx context.Context, input agentservice.RuntimeStartInput) (agentservice.RuntimeSession, error) {
	result, err := a.controller.Start(ctx, agentruntime.StartInput{
		RoomID:            input.WorkspaceID,
		AgentSessionID:    input.AgentSessionID,
		AgentTargetID:     input.AgentTargetID,
		Provider:          input.Provider,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Title:             input.Title,
		ProviderTargetRef: cloneRuntimeContext(input.ProviderTargetRef),
		RuntimeContext:    cloneRuntimeContext(input.RuntimeContext),
		PermissionModeID:  input.PermissionModeID,
		Settings: &agentruntime.SessionSettings{
			Model:                  input.Model,
			ReasoningEffort:        input.ReasoningEffort,
			Speed:                  input.Speed,
			PlanMode:               input.PlanMode,
			BrowserUse:             cloneOptionalBool(input.BrowserUse),
			PermissionModeID:       input.PermissionModeID,
			ConversationDetailMode: input.ConversationDetailMode,
		},
		Visible: input.Visible,
	})
	if err != nil {
		return agentservice.RuntimeSession{}, mapAgentRuntimeError(err)
	}
	return a.runtimeSessionWithState(result.Session), nil
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

func agentRuntimeSession(session agentruntime.Session) agentservice.RuntimeSession {
	return agentservice.RuntimeSession{
		ID:                 session.AgentSessionID,
		WorkspaceID:        session.RoomID,
		AgentTargetID:      session.AgentTargetID,
		Provider:           session.Provider,
		ProviderSessionID:  session.ProviderSessionID,
		Cwd:                session.CWD,
		Env:                append([]string(nil), session.Env...),
		Settings:           agentRuntimeComposerSettings(session.Settings),
		Status:             session.Status,
		TurnLifecycle:      serviceTurnLifecyclePointerFromRuntime(session.TurnLifecycle),
		SubmitAvailability: serviceSubmitAvailabilityPointerFromRuntime(session.SubmitAvailability),
		Visible:            session.Visible,
		Title:              session.Title,
		LastError:          session.LastError,
		RuntimeContext:     cloneRuntimeContext(session.RuntimeContext),
		CreatedAtUnixMS:    session.CreatedAtUnixMS,
		UpdatedAtUnixMS:    session.UpdatedAtUnixMS,
	}
}

func (a agentRuntimeAdapter) runtimeSessionWithState(session agentruntime.Session) agentservice.RuntimeSession {
	result := agentRuntimeSession(session)
	state, err := a.controller.State(session.RoomID, session.AgentSessionID)
	if err != nil {
		return result
	}
	if state.ProviderSessionID != "" {
		result.ProviderSessionID = state.ProviderSessionID
	}
	if state.Status != "" {
		result.Status = state.Status
	}
	if state.TurnLifecycle != nil {
		result.TurnLifecycle = serviceTurnLifecyclePointerFromRuntime(state.TurnLifecycle)
	}
	if state.SubmitAvailability != nil {
		result.SubmitAvailability = serviceSubmitAvailabilityPointerFromRuntime(state.SubmitAvailability)
	}
	if state.PendingInteractive != nil {
		result.PendingInteractive = serviceInteractivePromptFromRuntime(state.PendingInteractive)
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

func serviceInteractivePromptFromRuntime(value *agentruntime.SessionInteractivePrompt) *agentservice.RuntimeInteractivePrompt {
	if value == nil {
		return nil
	}
	return &agentservice.RuntimeInteractivePrompt{
		Kind:      value.Kind,
		RequestID: value.RequestID,
		ToolName:  value.ToolName,
		Status:    value.Status,
		Input:     cloneRuntimeContext(value.Input),
		Output:    cloneRuntimeContext(value.Output),
		Error:     cloneRuntimeContext(value.Error),
		Metadata:  cloneRuntimeContext(value.Metadata),
	}
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
	if errors.Is(err, agentruntime.ErrSessionNoActiveTurn) {
		return agentservice.ErrSessionNoActiveTurn
	}
	if errors.Is(err, agentruntime.ErrActiveTurnGuidanceUnsupported) {
		return agentservice.ErrActiveTurnGuidanceUnsupported
	}
	if errors.Is(err, agentruntime.ErrSessionSettingsRequireNewSession) {
		return agentservice.ErrSessionSettingsRequireNewSession
	}
	if errors.Is(err, agentruntime.ErrPromptImageUnsupported) {
		return agentservice.ErrPromptImageUnsupported
	}
	return err
}
