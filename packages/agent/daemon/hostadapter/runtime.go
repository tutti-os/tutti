// Package hostadapter adapts the daemon runtime contract to Agent Host.
//
// Both sides of this boundary are owned by Tutti. Product services should
// provide only the concrete runtime backend and current-user identity instead
// of maintaining their own lifecycle and error mappings.
package hostadapter

import (
	"context"
	"errors"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

// RuntimeBackend is the daemon controller surface required by Agent Host.
// *runtime.Controller implements this interface.
type RuntimeBackend interface {
	Start(context.Context, agentruntime.StartInput) (agentruntime.StartResult, error)
	Resume(context.Context, agentruntime.ResumeInput) (agentruntime.Session, error)
	Session(string, string) (agentruntime.Session, bool)
	State(string, string) (agentruntime.SessionStateSnapshot, error)
	CanResume(agentruntime.ResumeInput) bool
	Exec(context.Context, agentruntime.ExecInput) (agentruntime.ExecResult, error)
	DurablyReportSubmitProvenance(context.Context, agentruntime.SubmitProvenanceInput) error
	ValidatePromptContent(context.Context, agentruntime.ExecInput) error
	Cancel(context.Context, agentruntime.CancelInput) (agentruntime.CancelResult, error)
	SubmitInteractive(context.Context, agentruntime.SubmitInteractiveInput) (agentruntime.SubmitInteractiveResult, error)
	InteractiveDisposition(string, string, string, string, string) agentruntime.InteractiveDisposition
	UpdateSettings(context.Context, agentruntime.UpdateSettingsInput) (agentruntime.UpdateSettingsResult, error)
	SetTitle(context.Context, string, string, string) (agentruntime.Session, error)
	SetVisible(context.Context, string, string, bool) (agentruntime.Session, error)
	Close(context.Context, agentruntime.CloseInput) (agentruntime.CloseResult, error)
	GoalControl(context.Context, agentruntime.GoalControlInput) (agentruntime.GoalControlResult, error)
	ReconcileGoal(context.Context, agentruntime.GoalReconcileInput) (agentruntime.GoalReconcileResult, error)
	GoalCapabilities(context.Context, agentruntime.GoalReconcileInput) (agentruntime.GoalAdapterCapabilities, error)
}

// RuntimeController implements Agent Host runtime ports with a daemon backend.
type RuntimeController struct {
	Backend       RuntimeBackend
	CurrentUserID func() string
}

var (
	_ host.RuntimeController                 = (*RuntimeController)(nil)
	_ host.RuntimeSubmitProvenanceReporter   = (*RuntimeController)(nil)
	_ host.GoalRuntimeController             = (*RuntimeController)(nil)
	_ host.GoalRuntimeReconciler             = (*RuntimeController)(nil)
	_ host.GoalRuntimeRecoveryPolicyResolver = (*RuntimeController)(nil)
)

func (a *RuntimeController) Start(ctx context.Context, input host.RuntimeStartInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	result, err := a.Backend.Start(ctx, agentruntime.StartInput{
		RoomID:                  input.WorkspaceID,
		AgentSessionID:          input.AgentSessionID,
		AgentTargetID:           input.AgentTargetID,
		Provider:                input.Provider,
		CWD:                     input.Cwd,
		Env:                     append([]string(nil), input.Env...),
		Title:                   input.Title,
		InitialTitleEstablished: input.InitialTitleEstablished,
		Visible:                 input.Visible,
		RuntimeContext:          cloneMap(input.RuntimeContext),
		ProviderTargetRef:       cloneMap(input.ProviderTargetRef),
		PermissionModeID:        input.PermissionModeID,
		Settings: runtimeSettings(host.ComposerSettings{
			Model:                  input.Model,
			PermissionModeID:       input.PermissionModeID,
			PlanMode:               input.PlanMode,
			BrowserUse:             input.BrowserUse,
			ComputerUse:            input.ComputerUse,
			ReasoningEffort:        input.ReasoningEffort,
			Speed:                  input.Speed,
			ConversationDetailMode: input.ConversationDetailMode,
		}),
		Provisional: input.Provisional,
	})
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	session := a.sessionWithState(result.Session)
	session.Provisional = input.Provisional
	return session, nil
}

func (a *RuntimeController) Resume(ctx context.Context, input host.RuntimeResumeInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.Resume(ctx, runtimeResumeInput(input))
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Session(workspaceID, sessionID string) (host.ProviderRuntimeSession, bool) {
	if a == nil || a.Backend == nil {
		return host.ProviderRuntimeSession{}, false
	}
	session, found := a.Backend.Session(workspaceID, sessionID)
	if !found {
		return host.ProviderRuntimeSession{}, false
	}
	return a.sessionWithState(session), true
}

func (a *RuntimeController) CanResume(input host.RuntimeResumeInput) bool {
	return a != nil && a.Backend != nil && a.Backend.CanResume(runtimeResumeInput(input))
}

func (a *RuntimeController) Exec(ctx context.Context, input host.RuntimeExecInput) (host.RuntimeExecResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeExecResult{}, err
	}
	result, err := a.Backend.Exec(ctx, runtimeExecInput(input))
	return host.RuntimeExecResult{
		AgentSessionID: result.AgentSessionID,
		Status:         result.Status,
		TurnID:         result.TurnID,
		Accepted:       result.Accepted,
		SessionStatus:  result.SessionStatus,
		TurnLifecycle:  hostTurnLifecycle(result.TurnLifecycle),
		SubmitAvailability: host.SubmitAvailability{
			State: result.SubmitAvailability.State, Reason: result.SubmitAvailability.Reason,
		},
	}, mapRuntimeError(err)
}

func (a *RuntimeController) DurablyReportSubmitProvenance(ctx context.Context, input host.RuntimeSubmitProvenanceInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	return mapRuntimeError(a.Backend.DurablyReportSubmitProvenance(ctx, runtimeSubmitProvenanceInput(input)))
}

func (a *RuntimeController) ValidatePromptContent(ctx context.Context, input host.RuntimeExecInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	return mapRuntimeError(a.Backend.ValidatePromptContent(ctx, runtimeExecInput(input)))
}

func (a *RuntimeController) Cancel(ctx context.Context, input host.RuntimeCancelInput) (host.RuntimeCancelResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeCancelResult{}, err
	}
	targets := make([]agentruntime.CancelTarget, 0, len(input.Targets))
	for _, target := range input.Targets {
		targets = append(targets, agentruntime.CancelTarget{AgentSessionID: target.AgentSessionID, TurnID: target.TurnID})
	}
	result, err := a.Backend.Cancel(ctx, agentruntime.CancelInput{
		RoomID: input.WorkspaceID, RootAgentSessionID: input.RootAgentSessionID, Targets: targets, Reason: input.Reason,
	})
	confirmed := make([]host.RuntimeCancelTarget, 0, len(result.ConfirmedTargets))
	for _, target := range result.ConfirmedTargets {
		confirmed = append(confirmed, host.RuntimeCancelTarget{AgentSessionID: target.AgentSessionID, TurnID: target.TurnID})
	}
	return host.RuntimeCancelResult{
		AgentSessionID:   result.AgentSessionID,
		Canceled:         result.Canceled,
		TargetAbsent:     result.TargetAbsent,
		ConfirmedTargets: confirmed,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) SubmitInteractive(ctx context.Context, input host.RuntimeSubmitInteractiveInput) (host.RuntimeSubmitInteractiveResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeSubmitInteractiveResult{}, err
	}
	result, err := a.Backend.SubmitInteractive(ctx, agentruntime.SubmitInteractiveInput{
		RoomID: input.WorkspaceID, RootAgentSessionID: input.RootAgentSessionID,
		AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, RequestID: input.RequestID,
		Action: input.Action, OptionID: input.OptionID, Payload: cloneMap(input.Payload),
	})
	return host.RuntimeSubmitInteractiveResult{Disposition: host.RuntimeInteractiveDisposition(result.Disposition)}, mapRuntimeError(err)
}

func (a *RuntimeController) InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID string) host.RuntimeInteractiveDisposition {
	if a == nil || a.Backend == nil {
		return host.RuntimeInteractiveDispositionUnknown
	}
	return host.RuntimeInteractiveDisposition(a.Backend.InteractiveDisposition(workspaceID, rootSessionID, sessionID, turnID, requestID))
}

func (a *RuntimeController) UpdateSettings(ctx context.Context, input host.RuntimeUpdateSettingsInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	_, err := a.Backend.UpdateSettings(ctx, agentruntime.UpdateSettingsInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Settings: agentruntime.SessionSettingsPatch{
			Model: input.Settings.Model, ReasoningEffort: input.Settings.ReasoningEffort, Speed: input.Settings.Speed,
			PlanMode: input.Settings.PlanMode, BrowserUse: input.Settings.BrowserUse,
			ComputerUse: input.Settings.ComputerUse, PermissionModeID: input.Settings.PermissionModeID,
		},
	})
	return mapRuntimeError(err)
}

func (a *RuntimeController) SetTitle(ctx context.Context, input host.RuntimeSetTitleInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.SetTitle(ctx, input.WorkspaceID, input.AgentSessionID, input.Title)
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) SetVisible(ctx context.Context, input host.RuntimeSetVisibleInput) (host.ProviderRuntimeSession, error) {
	if err := a.requireBackend(); err != nil {
		return host.ProviderRuntimeSession{}, err
	}
	session, err := a.Backend.SetVisible(ctx, input.WorkspaceID, input.AgentSessionID, input.Visible)
	if err != nil {
		return host.ProviderRuntimeSession{}, mapRuntimeError(err)
	}
	return a.sessionWithState(session), nil
}

func (a *RuntimeController) Close(ctx context.Context, input host.RuntimeCloseInput) error {
	if err := a.requireBackend(); err != nil {
		return err
	}
	_, err := a.Backend.Close(ctx, agentruntime.CloseInput{RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	return mapRuntimeError(err)
}

func (a *RuntimeController) GoalControl(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalControlResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalControlResult{}, err
	}
	result, err := a.Backend.GoalControl(ctx, agentruntime.GoalControlInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		Action: agentruntime.GoalControlAction(input.Action), Objective: input.Objective,
		OperationID: input.OperationID, GoalRevision: input.GoalRevision, RepairEpoch: input.RepairEpoch,
		SubmissionMetadata: cloneMap(input.SubmissionMetadata),
	})
	return host.RuntimeGoalControlResult{
		AgentSessionID: result.AgentSessionID, Goal: cloneMap(result.Goal), Evidence: cloneMap(result.Evidence),
		ProviderPhase: result.ProviderPhase,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) ReconcileGoal(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalReconcileResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalReconcileResult{}, err
	}
	result, err := a.Backend.ReconcileGoal(ctx, agentruntime.GoalReconcileInput{RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	return host.RuntimeGoalReconcileResult{
		AgentSessionID: result.AgentSessionID, Goal: cloneMap(result.Goal), Evidence: cloneMap(result.Evidence),
	}, mapRuntimeError(err)
}

func (a *RuntimeController) GoalRecoveryPolicy(ctx context.Context, input host.RuntimeGoalControlInput) (host.RuntimeGoalRecoveryPolicy, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeGoalRecoveryPolicy{}, err
	}
	capabilities, err := a.Backend.GoalCapabilities(ctx, agentruntime.GoalReconcileInput{RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	return host.RuntimeGoalRecoveryPolicy{
		QuerySupported: capabilities.QuerySupported, ReplaySetAfterRestart: capabilities.ReplaySetAfterRestart,
	}, mapRuntimeError(err)
}

func (a *RuntimeController) requireBackend() error {
	if a == nil || a.Backend == nil {
		return errors.New("agent runtime controller is unavailable")
	}
	return nil
}

func mapRuntimeError(err error) error {
	if err == nil {
		return nil
	}
	var appErr *agentruntime.AppError
	if errors.As(err, &appErr) && appErr != nil {
		if errors.Is(appErr, context.Canceled) || errors.Is(appErr, context.DeadlineExceeded) {
			return err
		}
		return host.NewProviderError(appErr.Code, appErr.Message, appErr.DebugMessage, appErr)
	}
	return err
}

func (a *RuntimeController) fromSession(session agentruntime.Session) host.ProviderRuntimeSession {
	var settings *host.ComposerSettings
	if session.Settings != nil {
		value := hostSettings(*session.Settings)
		settings = &value
	}
	return host.ProviderRuntimeSession{
		ID: session.AgentSessionID, WorkspaceID: session.RoomID, UserID: a.currentUserID(),
		AgentTargetID: session.AgentTargetID, Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
		Cwd: session.CWD, Env: append([]string(nil), session.Env...), Settings: settings,
		RuntimeContext: cloneMap(session.RuntimeContext), Status: session.Status,
		TurnLifecycle: hostTurnLifecyclePointer(session.TurnLifecycle), SubmitAvailability: hostSubmitAvailability(session.SubmitAvailability),
		Visible: session.Visible, Title: session.Title, InitialTitleEstablished: session.InitialTitleEstablished,
		LastError: session.LastError, CreatedAtUnixMS: session.CreatedAtUnixMS, UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
}

// sessionWithState preserves the daemon runtime's provider-enriched live
// observation. The base Session owns process identity and lifecycle fields;
// State overlays provider-computed settings and runtime context such as model
// catalogs, usage, rate limits, account details, and commands.
func (a *RuntimeController) sessionWithState(session agentruntime.Session) host.ProviderRuntimeSession {
	result := a.fromSession(session)
	if a == nil || a.Backend == nil {
		return result
	}
	state, err := a.Backend.State(session.RoomID, session.AgentSessionID)
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
		result.TurnLifecycle = hostTurnLifecyclePointer(state.TurnLifecycle)
	}
	if state.SubmitAvailability != nil {
		result.SubmitAvailability = hostSubmitAvailability(state.SubmitAvailability)
	}
	if state.Settings != nil {
		settings := hostSettings(*state.Settings)
		result.Settings = &settings
	}
	result.RuntimeContext = cloneMap(state.RuntimeContext)
	if state.UpdatedAtUnixMS > 0 {
		result.UpdatedAtUnixMS = state.UpdatedAtUnixMS
	}
	return result
}

func (a *RuntimeController) currentUserID() string {
	if a != nil && a.CurrentUserID != nil {
		return strings.TrimSpace(a.CurrentUserID())
	}
	return ""
}

func runtimeResumeInput(input host.RuntimeResumeInput) agentruntime.ResumeInput {
	return agentruntime.ResumeInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
		Provider: input.Provider, ProviderSessionID: input.ProviderSessionID, CWD: input.Cwd,
		Env: append([]string(nil), input.Env...), Title: input.Title, Status: input.Status, Visible: input.Visible,
		RuntimeContext: cloneMap(input.RuntimeContext), ProviderTargetRef: cloneMap(input.ProviderTargetRef),
		PermissionModeID: input.Settings.PermissionModeID, Settings: runtimeSettings(input.Settings),
		CreatedAtUnixMS: input.CreatedAtUnixMS, UpdatedAtUnixMS: input.UpdatedAtUnixMS,
		RecreateIfMissing: input.RecreateIfMissing,
	}
}

func runtimeExecInput(input host.RuntimeExecInput) agentruntime.ExecInput {
	return agentruntime.ExecInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, ClientSubmitID: input.ClientSubmitID,
		CapabilityRefs:    runtimeCapabilityReferences(input.CapabilityRefs),
		TuttiModeSnapshot: runtimeTuttiModeSnapshot(input.TuttiModeSnapshot),
		Content:           runtimePromptContent(input.Content),
		DisplayPrompt:     input.DisplayPrompt, InitialTitle: input.InitialTitle, InitialTitleBase: input.InitialTitleBase,
		Metadata: cloneMap(input.Metadata), Guidance: input.Guidance,
	}
}

func runtimeSubmitProvenanceInput(input host.RuntimeSubmitProvenanceInput) agentruntime.SubmitProvenanceInput {
	return agentruntime.SubmitProvenanceInput{
		RoomID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, ClientSubmitID: input.ClientSubmitID,
		Content: runtimePromptContent(input.Content), DisplayPrompt: input.DisplayPrompt,
		Guidance: input.Guidance,
	}
}

func runtimePromptContent(input []host.PromptContentBlock) []agentruntime.PromptContentBlock {
	content := make([]agentruntime.PromptContentBlock, 0, len(input))
	for _, block := range input {
		content = append(content, agentruntime.PromptContentBlock{
			Type: block.Type, Text: block.Text, MimeType: block.MimeType, Data: block.Data, URL: block.URL,
			AttachmentID: block.AttachmentID, Name: block.Name, Path: block.Path,
		})
	}
	return content
}

func runtimeCapabilityReferences(input []host.CapabilityReference) []agentruntime.CapabilityReference {
	references := make([]agentruntime.CapabilityReference, 0, len(input))
	for _, reference := range input {
		references = append(references, agentruntime.CapabilityReference{
			Capability: reference.Capability,
			Source:     reference.Source,
		})
	}
	return references
}

func runtimeTuttiModeSnapshot(input *host.TuttiModeTurnSnapshot) *agentruntime.TuttiModeTurnSnapshot {
	if input == nil {
		return nil
	}
	return &agentruntime.TuttiModeTurnSnapshot{
		ActivationID: input.ActivationID, RevisionID: input.RevisionID, Revision: input.Revision,
		State: input.State, Source: input.Source, OrchestrationIntensity: input.OrchestrationIntensity,
	}
}

func runtimeSettings(settings host.ComposerSettings) *agentruntime.SessionSettings {
	return &agentruntime.SessionSettings{
		Model: settings.Model, ReasoningEffort: settings.ReasoningEffort, Speed: settings.Speed,
		PlanMode: settings.PlanMode, BrowserUse: settings.BrowserUse, ComputerUse: settings.ComputerUse,
		PermissionModeID: settings.PermissionModeID, ConversationDetailMode: settings.ConversationDetailMode,
	}
}

func hostSettings(settings agentruntime.SessionSettings) host.ComposerSettings {
	return host.ComposerSettings{
		Model: settings.Model, ReasoningEffort: settings.ReasoningEffort, Speed: settings.Speed,
		PlanMode: settings.PlanMode, BrowserUse: settings.BrowserUse, ComputerUse: settings.ComputerUse,
		PermissionModeID: settings.PermissionModeID, ConversationDetailMode: settings.ConversationDetailMode,
	}
}

func hostTurnLifecyclePointer(input *agentruntime.TurnLifecycle) *host.TurnLifecycle {
	if input == nil {
		return nil
	}
	value := hostTurnLifecycle(*input)
	return &value
}

func hostTurnLifecycle(input agentruntime.TurnLifecycle) host.TurnLifecycle {
	var completed *host.CompletedCommand
	if input.CompletedCommand != nil {
		completed = &host.CompletedCommand{Kind: input.CompletedCommand.Kind, Status: input.CompletedCommand.Status}
	}
	return host.TurnLifecycle{
		ActiveTurnID: input.ActiveTurnID, Phase: input.Phase, Settling: input.Settling,
		Outcome: input.Outcome, CompletedCommand: completed,
	}
}

func hostSubmitAvailability(input *agentruntime.SubmitAvailability) *host.SubmitAvailability {
	if input == nil {
		return nil
	}
	return &host.SubmitAvailability{State: input.State, Reason: input.Reason}
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
