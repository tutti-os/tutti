package main

import (
	"context"
	"errors"

	agentruntime "github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime"
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
		Settings: &agentruntime.SessionSettings{
			Model:            input.Settings.Model,
			ReasoningEffort:  input.Settings.ReasoningEffort,
			PlanMode:         input.Settings.PlanMode,
			PermissionModeID: input.Settings.PermissionModeID,
		},
		PermissionModeID: input.Settings.PermissionModeID,
		CreatedAtUnixMS:  input.CreatedAtUnixMS,
		UpdatedAtUnixMS:  input.UpdatedAtUnixMS,
		Visible:          input.Visible,
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
	result, err := a.controller.Exec(ctx, agentruntime.ExecInput{
		RoomID:         input.WorkspaceID,
		AgentSessionID: input.AgentSessionID,
		Content:        runtimePromptContentFromService(input.Content),
		DisplayPrompt:  input.DisplayPrompt,
	})
	if err != nil {
		return agentservice.RuntimeExecResult{}, mapAgentRuntimeError(err)
	}
	return agentservice.RuntimeExecResult{
		AgentSessionID: result.AgentSessionID,
		Status:         result.Status,
		TurnID:         result.TurnID,
		Accepted:       result.Accepted,
		SessionStatus:  result.SessionStatus,
	}, nil
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
			PlanMode:         input.Settings.PlanMode,
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
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		CWD:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Title:             input.Title,
		Status:            input.Status,
		Settings: &agentruntime.SessionSettings{
			Model:            input.Settings.Model,
			ReasoningEffort:  input.Settings.ReasoningEffort,
			PlanMode:         input.Settings.PlanMode,
			PermissionModeID: input.Settings.PermissionModeID,
		},
		PermissionModeID: input.Settings.PermissionModeID,
		CreatedAtUnixMS:  input.CreatedAtUnixMS,
		UpdatedAtUnixMS:  input.UpdatedAtUnixMS,
		Visible:          input.Visible,
	})
	if err != nil {
		return agentservice.RuntimeSession{}, mapAgentRuntimeError(err)
	}
	return agentRuntimeSession(session), nil
}

func (a agentRuntimeAdapter) Session(workspaceID string, agentSessionID string) (agentservice.RuntimeSession, bool) {
	session, ok := a.controller.Session(workspaceID, agentSessionID)
	return agentRuntimeSession(session), ok
}

func (a agentRuntimeAdapter) Sessions(workspaceID string) []agentservice.RuntimeSession {
	sessions := a.controller.Sessions(workspaceID)
	result := make([]agentservice.RuntimeSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, agentRuntimeSession(session))
	}
	return result
}

func (a agentRuntimeAdapter) Start(ctx context.Context, input agentservice.RuntimeStartInput) (agentservice.RuntimeSession, error) {
	result, err := a.controller.Start(ctx, agentruntime.StartInput{
		RoomID:           input.WorkspaceID,
		AgentSessionID:   input.AgentSessionID,
		Provider:         input.Provider,
		CWD:              input.Cwd,
		Env:              append([]string(nil), input.Env...),
		Title:            input.Title,
		PermissionModeID: input.PermissionModeID,
		Settings: &agentruntime.SessionSettings{
			Model:            input.Model,
			ReasoningEffort:  input.ReasoningEffort,
			PlanMode:         input.PlanMode,
			PermissionModeID: input.PermissionModeID,
		},
		Visible: input.Visible,
	})
	if err != nil {
		return agentservice.RuntimeSession{}, mapAgentRuntimeError(err)
	}
	return agentRuntimeSession(result.Session), nil
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
		ID:                session.AgentSessionID,
		WorkspaceID:       session.RoomID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Cwd:               session.CWD,
		Env:               append([]string(nil), session.Env...),
		Settings:          agentRuntimeComposerSettings(session.Settings),
		Status:            session.Status,
		Visible:           session.Visible,
		Title:             session.Title,
		LastError:         session.LastError,
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
	}
}

func agentRuntimeComposerSettings(settings *agentruntime.SessionSettings) *agentservice.ComposerSettings {
	if settings == nil {
		return nil
	}
	return &agentservice.ComposerSettings{
		Model:            settings.Model,
		PermissionModeID: settings.PermissionModeID,
		PlanMode:         settings.PlanMode,
		ReasoningEffort:  settings.ReasoningEffort,
	}
}

func mapAgentRuntimeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, agentruntime.ErrSessionNotFound) {
		return agentservice.ErrSessionNotFound
	}
	if errors.Is(err, agentruntime.ErrSessionSettingsRequireNewSession) {
		return agentservice.ErrSessionSettingsRequireNewSession
	}
	if errors.Is(err, agentruntime.ErrPromptImageUnsupported) {
		return agentservice.ErrPromptImageUnsupported
	}
	return err
}
